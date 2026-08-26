import { beforeAll, describe, it } from 'vitest';
import { CompositeRenderer } from '../src/core/render/composite-renderer.ts';
import {
  MASK_FORMAT,
  OUTPUT_FORMAT,
  OUTPUT_VIEW_FORMAT,
  SOURCE_FORMAT,
  SOURCE_VIEW_FORMAT,
} from '../src/core/gpu/formats.ts';
import { readTextureRgba, testDevice, writeTextureRgba } from './gpu-harness.ts';
import {
  expectFiniteEverywhere,
  expectSelectedTransformed,
  expectUnselectedUntouched,
  testImage,
  type SplitRender,
} from './style-harness.ts';

const SIZE = 256;

function splitMask(size: number): Uint8Array {
  const coverage = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) coverage[y * size + x] = x >= size / 2 ? 255 : 0;
  }
  return coverage;
}

function solidLayer(size: number, r: number, g: number, b: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = 255;
  }
  return pixels;
}

describe('illustrated layer', () => {
  let rendered: SplitRender;

  beforeAll(async () => {
    const { device } = await testDevice();
    const dimensions = { width: SIZE, height: SIZE };
    const source = testImage(SIZE, SIZE);
    const sourceTexture = device.createTexture({
      size: dimensions,
      format: SOURCE_FORMAT,
      viewFormats: [SOURCE_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    writeTextureRgba(device, sourceTexture, SIZE, SIZE, source);

    const illustrated = device.createTexture({
      size: dimensions,
      format: SOURCE_FORMAT,
      viewFormats: [SOURCE_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    writeTextureRgba(device, illustrated, SIZE, SIZE, solidLayer(SIZE, 20, 200, 40));

    const maskTexture = device.createTexture({
      size: dimensions,
      format: MASK_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: maskTexture },
      splitMask(SIZE),
      { bytesPerRow: SIZE, rowsPerImage: SIZE },
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
    renderer.adoptLayer(illustrated, 1);
    renderer.composite(
      encoder,
      sourceTexture,
      maskTexture,
      target.createView({ format: OUTPUT_VIEW_FORMAT }),
    );
    device.queue.submit([encoder.finish()]);

    rendered = { source, output: await readTextureRgba(device, target, SIZE, SIZE), size: SIZE };
    renderer.dispose();
    sourceTexture.destroy();
    illustrated.destroy();
    maskTexture.destroy();
    target.destroy();
  });

  it('leaves unselected pixels byte-identical to the source', () => {
    expectUnselectedUntouched(rendered);
  });

  it('visibly replaces the selected region with the hosted layer', () => {
    expectSelectedTransformed(rendered);
  });

  it('produces a finite result everywhere', () => {
    expectFiniteEverywhere(rendered);
  });
});
