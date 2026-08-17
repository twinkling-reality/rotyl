import { beforeAll, describe, expect, it } from 'vitest';
import { disposeWithTestDevice, testDevice, writeTextureRgba } from './gpu-harness.ts';
import { FrameTensorEncoder } from '../src/core/perception/frame-tensor.ts';
import { SOURCE_FORMAT, SOURCE_VIEW_FORMAT } from '../src/core/gpu/formats.ts';
import { linearToSrgb } from '../src/core/color/srgb.ts';

/**
 * The image, as a segmentation model receives it.
 *
 * Three things decide whether the mask lands where the model thinks it does,
 * and all three fail silently rather than loudly:
 *
 *   the tensor is planar, so a transposed layout looks like a colour shift
 *   the values are sRGB-encoded, so linear light looks like an underexposure
 *   the resize is to a square, so preserving aspect looks like an offset mask
 *
 * None of them produces an error. Each produces a plausible mask in the wrong
 * place, which is why they are checked by running the real shader rather than
 * by reading it.
 *
 * All the GPU work happens once, before any case: spreading it across separate
 * `it` blocks aborts the Dawn Node worker intermittently. See mask-refine.
 */

/** 256 bytes per row is the copy alignment; 64 floats is the smallest that fits. */
const SIZE = 64;

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

/** What the model should receive for one source byte, if every stage is right. */
function expected(byte: number, channel: number): number {
  // The byte is already sRGB-encoded, so a correct pipeline decodes it on
  // sampling and re-encodes it here, arriving back where it started.
  return (byte / 255 - (MEAN[channel] ?? 0)) / (STD[channel] ?? 1);
}

function solid(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set([...rgb, 255], i * 4);
  return pixels;
}

/** Alternating black and white texels, so each output texel averages four. */
function checker(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = (x + y) % 2 === 0 ? 255 : 0;
      pixels.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return pixels;
}

/** Left half red, right half blue, in a source twice as wide as it is tall. */
function halves(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set(x < width / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * width + x) * 4);
    }
  }
  return pixels;
}

interface Tensor {
  at(channel: number, x: number, y: number): number;
}

let uniform: Tensor;
let averaged: Tensor;
let anisotropic: Tensor;

beforeAll(async () => {
  const { device } = await testDevice();
  const encoder = new FrameTensorEncoder(device, { size: SIZE, mean: MEAN, std: STD });
  disposeWithTestDevice(() => {
    encoder.dispose();
  });

  const run = async (width: number, height: number, pixels: Uint8Array): Promise<Tensor> => {
    const source = device.createTexture({
      size: { width, height },
      format: SOURCE_FORMAT,
      viewFormats: [SOURCE_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    writeTextureRgba(device, source, width, height, pixels);

    const commands = device.createCommandEncoder();
    encoder.encode(commands, source.createView({ format: SOURCE_VIEW_FORMAT }), { width, height });
    device.queue.submit([commands.finish()]);

    const values = await encoder.read();
    source.destroy();

    return {
      at: (channel, x, y) => values[channel * SIZE * SIZE + y * SIZE + x] ?? Number.NaN,
    };
  };

  uniform = await run(SIZE, SIZE, solid(SIZE, SIZE, [128, 64, 200]));
  averaged = await run(SIZE * 2, SIZE * 2, checker(SIZE * 2, SIZE * 2));
  anisotropic = await run(SIZE * 2, SIZE, halves(SIZE * 2, SIZE));
});

describe('the model input tensor', () => {
  it('is planar, one channel after another', () => {
    // A transposed or interleaved layout would put green where red belongs, and
    // the model would still return a mask — just not of the thing clicked on.
    for (const [x, y] of [
      [0, 0],
      [17, 41],
      [SIZE - 1, SIZE - 1],
    ] as const) {
      expect(uniform.at(0, x, y)).toBeCloseTo(expected(128, 0), 2);
      expect(uniform.at(1, x, y)).toBeCloseTo(expected(64, 1), 2);
      expect(uniform.at(2, x, y)).toBeCloseTo(expected(200, 2), 2);
    }
  });

  it('hands the model sRGB-encoded values, not linear light', () => {
    // The one that would otherwise be invisible: linear light is a plausible
    // image, several stops dark, and the model degrades rather than failing.
    const linearInstead = (128 / 255) ** 2.2;
    expect(uniform.at(0, 32, 32)).toBeCloseTo(expected(128, 0), 2);
    expect(uniform.at(0, 32, 32)).not.toBeCloseTo((linearInstead - MEAN[0]) / STD[0], 1);
  });

  it('averages in linear light before encoding', () => {
    // Half black and half white averages to linear 0.5, which encodes to 0.735
    // — not to 0.5. Averaging encoded values instead is the classic resize bug,
    // and it darkens every edge in the image the model is reasoning about.
    const correct = (linearToSrgb(0.5) - MEAN[0]) / STD[0];
    const ifAveragedEncoded = (0.5 - MEAN[0]) / STD[0];

    expect(averaged.at(0, 20, 20)).toBeCloseTo(correct, 2);
    expect(Math.abs(correct - ifAveragedEncoded)).toBeGreaterThan(0.5);
  });

  it('resizes to a square rather than preserving aspect', () => {
    // What the processor the weights were trained with does. Letterboxing
    // instead would leave bars the model reads as image content, and shift
    // every mask by their width.
    expect(anisotropic.at(0, 4, 32)).toBeCloseTo(expected(255, 0), 2);
    expect(anisotropic.at(2, 4, 32)).toBeCloseTo(expected(0, 2), 2);

    expect(anisotropic.at(0, SIZE - 5, 32)).toBeCloseTo(expected(0, 0), 2);
    expect(anisotropic.at(2, SIZE - 5, 32)).toBeCloseTo(expected(255, 2), 2);
  });

  it('refuses a size whose rows would not meet the copy alignment', async () => {
    const { device } = await testDevice();
    expect(() => new FrameTensorEncoder(device, { size: 60, mean: MEAN, std: STD })).toThrow(/256-byte row/);
  });
});
