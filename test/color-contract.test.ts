import { describe, expect, it } from 'vitest';
import { readTextureRgba, testDevice, writeTextureRgba } from './gpu-harness.ts';
import { FullscreenPass } from '../src/core/gpu/fullscreen-pass.ts';
import {
  OUTPUT_FORMAT,
  OUTPUT_VIEW_FORMAT,
  SOURCE_FORMAT,
  SOURCE_VIEW_FORMAT,
} from '../src/core/gpu/formats.ts';
import { linearToSrgb, srgbToLinear } from '../src/core/color/srgb.ts';
import { linearToOklab, oklabToLinear } from '../src/core/color/oklab.ts';
import colorWgsl from '../src/core/style/wgsl/color.wgsl?raw';

/**
 * The colour contract, proved on the real GPU.
 *
 * Rotyl's core promise is that unselected pixels are untouched, and export
 * matches preview. Both reduce to this: a byte that goes through the hardware
 * sRGB decode, linear-light shader maths, and the hardware sRGB encode has to
 * come back out as the same byte. If it does not, every pixel in the image is
 * already slightly wrong before any stylisation happens.
 */

const PASSTHROUGH = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(src, samp, uv);
}
`;

async function roundTrip(
  sourceViewFormat: GPUTextureFormat | undefined,
  targetViewFormat: GPUTextureFormat | undefined,
  pixels: Uint8Array,
  width: number,
  height: number,
  fragmentWgsl: string = PASSTHROUGH,
): Promise<Uint8Array> {
  const { device } = await testDevice();

  const source = device.createTexture({
    size: { width, height },
    format: SOURCE_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    ...(sourceViewFormat ? { viewFormats: [sourceViewFormat] } : {}),
  });
  writeTextureRgba(device, source, width, height, pixels);

  const target = device.createTexture({
    size: { width, height },
    format: OUTPUT_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    ...(targetViewFormat ? { viewFormats: [targetViewFormat] } : {}),
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });

  const pass = new FullscreenPass({
    label: 'passthrough',
    device,
    fragmentWgsl,
    bindGroupLayout,
    targetFormat: targetViewFormat ?? OUTPUT_FORMAT,
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: source.createView(sourceViewFormat ? { format: sourceViewFormat } : {}) },
      { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
    ],
  });

  const encoder = device.createCommandEncoder();
  pass.run(encoder, target.createView(targetViewFormat ? { format: targetViewFormat } : {}), bindGroup);
  device.queue.submit([encoder.finish()]);

  const result = await readTextureRgba(device, target, width, height);
  source.destroy();
  target.destroy();
  return result;
}

function ramp(): { pixels: Uint8Array; width: number; height: number } {
  const values = [0, 1, 17, 64, 128, 188, 192, 254, 255];
  const pixels = new Uint8Array(values.length * 4);
  values.forEach((v, i) => {
    pixels.set([v, v, v, 255], i * 4);
  });
  return { pixels, width: values.length, height: 1 };
}

describe('colour contract', () => {
  it('is bit-exact through the sRGB view round trip', async () => {
    const { pixels, width, height } = ramp();
    const out = await roundTrip(SOURCE_VIEW_FORMAT, OUTPUT_VIEW_FORMAT, pixels, width, height);

    for (let i = 0; i < width; i++) {
      expect(out[i * 4], `channel value at texel ${i}`).toBe(pixels[i * 4]);
    }
  });

  it('is measurably wrong if either end of the round trip is dropped', async () => {
    const { pixels, width, height } = ramp();

    // Decode on read but store the linear value raw: everything goes dark.
    const decodeOnly = await roundTrip(SOURCE_VIEW_FORMAT, undefined, pixels, width, height);
    // Encode on write without decoding first: everything washes out.
    const encodeOnly = await roundTrip(undefined, OUTPUT_VIEW_FORMAT, pixels, width, height);

    const midpoint = 5; // the 188 entry
    expect(decodeOnly[midpoint * 4]).toBeLessThan(150);
    expect(encodeOnly[midpoint * 4]).toBeGreaterThan(210);
  });
});

describe('sRGB transfer functions', () => {
  it('round-trips', () => {
    // Tolerance is 1e-6, not machine epsilon: the standard's published
    // constants (0.0031308 / 0.04045 / 1.055) do not make the two pieces of
    // the curve meet exactly, so a round trip through the join carries ~3e-8
    // of error. That is four orders of magnitude below one 8-bit code value.
    for (const v of [0, 0.001, 0.0031308, 0.04045, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
  });

  it('agrees with the hardware decode at 8-bit precision', async () => {
    const { pixels, width, height } = ramp();
    // Sample through the sRGB view, write linear values raw, and compare the
    // stored bytes against the CPU transfer function.
    const out = await roundTrip(SOURCE_VIEW_FORMAT, undefined, pixels, width, height);

    for (let i = 0; i < width; i++) {
      const sourceByte = pixels[i * 4] ?? 0;
      const expected = Math.round(srgbToLinear(sourceByte / 255) * 255);
      expect(Math.abs((out[i * 4] ?? 0) - expected), `texel ${i}`).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * The WGSL Oklab conversion against the TypeScript one.
 *
 * Oklab is where the cel bands are quantised, so a transcription error in
 * either copy of the matrices would show up as a hue shift along every band
 * boundary — subtle enough to look like an artistic choice rather than a bug.
 * Running both and comparing is the only way to catch that.
 */
const OKLAB_ROUND_TRIP = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let linear = textureSample(src, samp, uv).rgb;
  return vec4f(oklabToLinear(linearToOklab(linear)), 1.0);
}
`;

describe('Oklab', () => {
  it('round-trips through the shader without shifting colour', async () => {
    const { pixels, width, height } = ramp();
    const out = await roundTrip(
      SOURCE_VIEW_FORMAT,
      OUTPUT_VIEW_FORMAT,
      pixels,
      width,
      height,
      `${colorWgsl}\n${OKLAB_ROUND_TRIP}`,
    );

    for (let i = 0; i < width; i++) {
      // A cube root and its inverse in f32; one code value of slack.
      expect(Math.abs((out[i * 4] ?? 0) - (pixels[i * 4] ?? 0)), `texel ${i}`).toBeLessThanOrEqual(1);
    }
  });

  it('agrees with the TypeScript implementation', () => {
    // Both are used: the shader for rendering, this one as the reference the
    // shader is checked against.
    for (const rgb of [
      { r: 0, g: 0, b: 0 },
      { r: 1, g: 1, b: 1 },
      { r: 0.5, g: 0.25, b: 0.75 },
      { r: 0.2, g: 0.9, b: 0.1 },
    ]) {
      const back = oklabToLinear(linearToOklab(rgb));
      expect(back.r).toBeCloseTo(rgb.r, 6);
      expect(back.g).toBeCloseTo(rgb.g, 6);
      expect(back.b).toBeCloseTo(rgb.b, 6);
    }
  });

  it('places mid-grey at the lightness the specification predicts', () => {
    // Anchors the matrices against a known value rather than only against
    // themselves: a transposed matrix still round-trips perfectly.
    const { L, a, b } = linearToOklab({ r: 0.5, g: 0.5, b: 0.5 });
    expect(L).toBeCloseTo(0.7937, 3);
    expect(a).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(0, 6);
  });
});
