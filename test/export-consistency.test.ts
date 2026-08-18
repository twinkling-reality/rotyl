import { describe, expect, it } from 'vitest';
import { disposeWithTestDevice, readTextureRgba, testDevice, writeTextureRgba } from './gpu-harness.ts';
import { renderExport } from '../src/core/render/export-renderer.ts';
import { CompositeRenderer } from '../src/core/render/composite-renderer.ts';
import { MaskRefiner } from '../src/core/mask/mask-refiner.ts';
import {
  OUTPUT_FORMAT,
  OUTPUT_VIEW_FORMAT,
  SOURCE_FORMAT,
  SOURCE_VIEW_FORMAT,
} from '../src/core/gpu/formats.ts';
import { COMIC_STYLE } from '../src/core/style/comic/comic-style-pipeline.ts';
import { defaultControls } from '../src/core/style/style.ts';
import type { SelectionCommand } from '../src/core/document/selection-command.ts';

/**
 * Export is not a second rendering path. It is the preview's path at a
 * different resolution.
 *
 * The property checked here is the one that can only be checked by rendering:
 * an exported image reproduces unselected pixels byte for byte.
 *
 * The companion property, that composition does not depend on the resolution
 * rendered at, is verified in `comic-params.test.ts` instead, and that is the
 * better place for it: it is a property of the parameter mapping, where it can
 * be checked exactly across every output size and quality tier rather than
 * inferred from a tolerance between two renders. Doing it here would also mean
 * running the full style chain twice in one process, which the Dawn Node
 * binding does not survive reliably (browsers do; see README).
 */

function gradientImage(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const u = x / width;
      const v = y / height;
      pixels[i] = Math.round(40 + 180 * u);
      pixels[i + 1] = Math.round(200 - 150 * v);
      pixels[i + 2] = Math.round(120 + 100 * Math.sin(u * 9) * Math.cos(v * 7));
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

/** A stroke covering a circle in the middle of the image, in source pixels. */
function centreStroke(size: number): SelectionCommand {
  return {
    kind: 'paint',
    frame: 0,
    stroke: {
      points: [{ x: size / 2, y: size / 2 }],
      radius: size * 0.3,
      hardness: 1,
    },
  };
}

async function exportAt(size: number): Promise<Uint8Array> {
  const { device } = await testDevice();
  const renderer = new CompositeRenderer(device);
  const refiner = new MaskRefiner(device);
  // Released with the device rather than here: tearing a pipeline set down
  // immediately after the frame that used it is exactly the churn the Dawn
  // Node binding is least stable under.
  disposeWithTestDevice(() => {
    renderer.dispose();
    refiner.dispose();
  });

  const sourcePixels = gradientImage(size, size);
  const sourceTexture = device.createTexture({
    size: { width: size, height: size },
    format: SOURCE_FORMAT,
    viewFormats: [SOURCE_VIEW_FORMAT],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  writeTextureRgba(device, sourceTexture, size, size, sourcePixels);

  const target = device.createTexture({
    size: { width: size, height: size },
    format: OUTPUT_FORMAT,
    viewFormats: [OUTPUT_VIEW_FORMAT],
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  await renderExport({
    device,
    renderer,
    refiner,
    sourceTexture,
    sourceSize: { width: size, height: size },
    // The stroke is expressed as a fraction of this image, so the same
    // selection is described at either resolution.
    commands: [centreStroke(size)],
    style: COMIC_STYLE,
    controls: defaultControls(COMIC_STYLE),
    target,
  });

  const output = await readTextureRgba(device, target, size, size);
  sourceTexture.destroy();
  target.destroy();
  return output;
}

describe('export', () => {
  it('leaves unselected pixels byte-identical', async () => {
    const size = 192;
    const output = await exportAt(size);
    const source = gradientImage(size, size);

    // Corners are far outside a circle of radius 0.3 * size centred in the image.
    let mismatches = 0;
    for (const [x, y] of [
      [2, 2],
      [size - 3, 2],
      [2, size - 3],
      [size - 3, size - 3],
      [10, 40],
      [size - 11, size - 41],
    ] as const) {
      const i = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        if (output[i + channel] !== source[i + channel]) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });
});
