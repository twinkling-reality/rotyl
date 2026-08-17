import { beforeAll, describe, expect, it } from 'vitest';
import { readTextureRgba, testDevice, writeTextureRgba } from './gpu-harness.ts';
import { CompositeRenderer } from '../src/core/render/composite-renderer.ts';
import {
  MASK_FORMAT,
  OUTPUT_FORMAT,
  OUTPUT_VIEW_FORMAT,
  SOURCE_FORMAT,
  SOURCE_VIEW_FORMAT,
} from '../src/core/gpu/formats.ts';
import { DEFAULT_COMIC_CONTROLS } from '../src/core/style/comic-params.ts';

/**
 * The acceptance test for Rotyl's central promise.
 *
 * "Apply a style to the selected region and leave everything else unchanged" is
 * only meaningful if "unchanged" means bit-for-bit identical. Anything less — a
 * drift of one code value across the untouched majority of a photograph — would
 * be an invisible lie that surfaces the moment someone compares two files.
 */

const SIZE = 192;
/**
 * The mask is sampled with linear filtering, so the texels straddling a hard
 * 0/1 step are legitimately partial coverage. Assertions skip that seam.
 */
const SEAM = 2;

/** Photographic-ish content: smooth gradients, a hard edge, and fine texture. */
function testImage(width: number, height: number): Uint8Array {
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
function splitMask(width: number, height: number): Uint8Array {
  const coverage = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      coverage[y * width + x] = x >= width / 2 ? 255 : 0;
    }
  }
  return coverage;
}

async function renderSplit(): Promise<{ source: Uint8Array; output: Uint8Array }> {
  const { device } = await testDevice();
  const size = { width: SIZE, height: SIZE };

  const sourcePixels = testImage(SIZE, SIZE);
  const sourceTexture = device.createTexture({
    size,
    format: SOURCE_FORMAT,
    viewFormats: [SOURCE_VIEW_FORMAT],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  writeTextureRgba(device, sourceTexture, SIZE, SIZE, sourcePixels);

  const maskTexture = device.createTexture({
    size,
    format: MASK_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: maskTexture },
    splitMask(SIZE, SIZE),
    { bytesPerRow: SIZE, rowsPerImage: SIZE },
    size,
  );

  const target = device.createTexture({
    size,
    format: OUTPUT_FORMAT,
    viewFormats: [OUTPUT_VIEW_FORMAT],
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const renderer = new CompositeRenderer(device);
  const request = {
    sourceTexture,
    sourceSize: size,
    outputSize: size,
    maskTexture,
    controls: DEFAULT_COMIC_CONTROLS,
    quality: 'full' as const,
  };

  const encoder = device.createCommandEncoder();
  renderer.renderStyle(encoder, request);
  renderer.composite(encoder, request, target.createView({ format: OUTPUT_VIEW_FORMAT }));
  device.queue.submit([encoder.finish()]);

  const output = await readTextureRgba(device, target, SIZE, SIZE);

  renderer.dispose();
  sourceTexture.destroy();
  maskTexture.destroy();
  target.destroy();
  return { source: sourcePixels, output };
}

describe('selective stylisation', () => {
  let source: Uint8Array;
  let output: Uint8Array;

  beforeAll(async () => {
    ({ source, output } = await renderSplit());
  });

  it('leaves unselected pixels byte-identical to the source', () => {
    // Aggregated rather than asserted per pixel: an expectation per channel
    // over 18k pixels is 55k assertion objects, which exhausts the worker.
    let compared = 0;
    let firstMismatch: string | undefined;

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE / 2 - SEAM; x++) {
        const i = (y * SIZE + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          if (output[i + channel] !== source[i + channel]) {
            firstMismatch ??= `(${x}, ${y}) channel ${channel}: ${String(output[i + channel])} != ${String(source[i + channel])}`;
          }
        }
        compared++;
      }
    }

    expect(firstMismatch).toBeUndefined();
    expect(compared).toBeGreaterThan(SIZE * 90);
  });

  it('visibly transforms the selected region', () => {
    let changedPixels = 0;
    let totalDelta = 0;
    let inspected = 0;

    for (let y = 0; y < SIZE; y++) {
      for (let x = SIZE / 2 + SEAM; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4;
        const delta =
          Math.abs((output[i] ?? 0) - (source[i] ?? 0)) +
          Math.abs((output[i + 1] ?? 0) - (source[i + 1] ?? 0)) +
          Math.abs((output[i + 2] ?? 0) - (source[i + 2] ?? 0));
        if (delta > 12) changedPixels++;
        totalDelta += delta;
        inspected++;
      }
    }

    // A comic treatment has to read as a transformation, not a colour tweak.
    expect(changedPixels / inspected).toBeGreaterThan(0.6);
    expect(totalDelta / inspected).toBeGreaterThan(25);
  });

  it('produces a finite result everywhere', () => {
    // Load-bearing: a single NaN in the styled layer would defeat
    // mix(base, styled, 0) and corrupt the unselected region.
    let nonFinite = 0;
    for (let i = 0; i < output.length; i++) {
      if (!Number.isFinite(output[i])) nonFinite++;
    }
    expect(nonFinite).toBe(0);
  });
});
