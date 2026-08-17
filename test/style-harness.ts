import { expect } from 'vitest';
import { readTextureRgba, testDevice, writeTextureRgba } from './gpu-harness.ts';
import { CompositeRenderer } from '../src/core/render/composite-renderer.ts';
import {
  MASK_FORMAT,
  OUTPUT_FORMAT,
  OUTPUT_VIEW_FORMAT,
  SOURCE_FORMAT,
  SOURCE_VIEW_FORMAT,
} from '../src/core/gpu/formats.ts';
import { defaultControls, type StyleDefinition } from '../src/core/style/style.ts';

/**
 * The acceptance test for Rotyl's central promise, as a harness every style
 * must pass.
 *
 * "Apply a style to the selected region and leave everything else unchanged" is
 * only meaningful if "unchanged" means bit-for-bit identical. Anything less — a
 * drift of one code value across the untouched majority of a photograph — would
 * be an invisible lie that surfaces the moment someone compares two files.
 *
 * Shared rather than written per style because it is the compositor's contract,
 * not any one style's: a style that broke it would do so through the same
 * single pass. A new style is a new file with three lines in it, and if the
 * seam is real that is all it should ever need.
 *
 * ONE RENDER PER FILE, MANY ASSERTIONS. Dawn's Node bindings abort
 * intermittently when GPU work is spread across separate cases, so each style
 * gets its own test file, renders once in `beforeAll`, and asserts against the
 * bytes.
 */

/**
 * The mask is sampled with linear filtering, so the texels straddling a hard
 * 0/1 step are legitimately partial coverage. Assertions skip that seam.
 */
export const SEAM = 2;

/** Photographic-ish content: smooth gradients, a hard edge, and fine texture. */
export function testImage(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const ripple = Math.sin(x * 0.12) * Math.cos(y * 0.09) * 40;
      const hardEdge = x > width * 0.6 && y > height * 0.35 ? 70 : 0;
      pixels[i] = Math.min(255, Math.max(0, Math.round(120 + ripple + hardEdge)));
      pixels[i + 1] = Math.min(255, Math.max(0, Math.round(90 + (x / width) * 120 - ripple * 0.5)));
      pixels[i + 2] = Math.min(255, Math.max(0, Math.round(180 - (y / height) * 130 + ripple * 0.3)));
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

/** Coverage that is 0 on the left half and 1 on the right half. */
function splitMask(size: number): Uint8Array {
  const coverage = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      coverage[y * size + x] = x >= size / 2 ? 255 : 0;
    }
  }
  return coverage;
}

export interface SplitRender {
  readonly source: Uint8Array;
  readonly output: Uint8Array;
  readonly size: number;
}

/**
 * Render one square image with the right half selected.
 *
 * `size` is a per-style choice rather than a constant: a style whose look has a
 * characteristic scale needs a canvas large enough to show it, and testing it
 * below that scale tests a fallback instead.
 */
export async function renderSplit(style: StyleDefinition, size: number): Promise<SplitRender> {
  const { device } = await testDevice();
  const dimensions = { width: size, height: size };

  const source = testImage(size, size);
  const sourceTexture = device.createTexture({
    size: dimensions,
    format: SOURCE_FORMAT,
    viewFormats: [SOURCE_VIEW_FORMAT],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  writeTextureRgba(device, sourceTexture, size, size, source);

  const maskTexture = device.createTexture({
    size: dimensions,
    format: MASK_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: maskTexture },
    splitMask(size),
    { bytesPerRow: size, rowsPerImage: size },
    dimensions,
  );

  const target = device.createTexture({
    size: dimensions,
    format: OUTPUT_FORMAT,
    viewFormats: [OUTPUT_VIEW_FORMAT],
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const renderer = new CompositeRenderer(device);
  const encoder = device.createCommandEncoder();
  renderer.renderStyle(encoder, {
    sourceTexture,
    sourceSize: dimensions,
    outputSize: dimensions,
    style,
    controls: defaultControls(style),
    quality: 'full',
  });
  renderer.composite(encoder, sourceTexture, maskTexture, target.createView({ format: OUTPUT_VIEW_FORMAT }));
  device.queue.submit([encoder.finish()]);

  const output = await readTextureRgba(device, target, size, size);

  renderer.dispose();
  sourceTexture.destroy();
  maskTexture.destroy();
  target.destroy();
  return { source, output, size };
}

export function expectUnselectedUntouched({ source, output, size }: SplitRender): void {
  // Aggregated rather than asserted per pixel: an expectation per channel over
  // 18k pixels is 55k assertion objects, which exhausts the worker.
  let compared = 0;
  let firstMismatch: string | undefined;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size / 2 - SEAM; x++) {
      const i = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        if (output[i + channel] !== source[i + channel]) {
          firstMismatch ??= `(${x}, ${y}) channel ${channel}: ${String(output[i + channel])} != ${String(source[i + channel])}`;
        }
      }
      compared++;
    }
  }

  expect(firstMismatch).toBeUndefined();
  expect(compared).toBeGreaterThan(size * (size / 2 - SEAM - 1));
}

export function expectSelectedTransformed({ source, output, size }: SplitRender): void {
  let changedPixels = 0;
  let totalDelta = 0;
  let inspected = 0;

  for (let y = 0; y < size; y++) {
    for (let x = size / 2 + SEAM; x < size; x++) {
      const i = (y * size + x) * 4;
      const delta =
        Math.abs((output[i] ?? 0) - (source[i] ?? 0)) +
        Math.abs((output[i + 1] ?? 0) - (source[i + 1] ?? 0)) +
        Math.abs((output[i + 2] ?? 0) - (source[i + 2] ?? 0));
      if (delta > 12) changedPixels++;
      totalDelta += delta;
      inspected++;
    }
  }

  // A style has to read as a transformation, not as a colour tweak.
  expect(changedPixels / inspected).toBeGreaterThan(0.6);
  expect(totalDelta / inspected).toBeGreaterThan(25);
}

export function expectFiniteEverywhere({ output }: SplitRender): void {
  // Load-bearing: a single NaN in the styled layer would defeat
  // mix(base, styled, 0) and corrupt the unselected region.
  let nonFinite = 0;
  for (let i = 0; i < output.length; i++) {
    if (!Number.isFinite(output[i])) nonFinite++;
  }
  expect(nonFinite).toBe(0);
}
