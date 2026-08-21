// MEASUREMENT 4: what a decoded frame does to the colour contract.
//
// Rotyl's rule is hardware sRGB decode on read, hardware encode on write,
// linear in between - both ends or neither. A source IMAGE satisfies it by
// construction: createImageBitmap normalises to sRGB, the bytes land in an
// rgba8unorm texture, and everything downstream samples through an
// rgba8unorm-srgb view.
//
// A decoded VIDEO frame is not that. It is NV12, usually bt709 with limited
// range, and something has to convert it. The question this answers is what
// that something produces, because the two ways to be wrong are both silent:
// values that are already sRGB-encoded and get encoded again come out washed
// out, and linear values written raw come out dark.
//
// The probe is a grid of flat patches whose sRGB bytes are known exactly, so
// the error is a number rather than an impression.

import { decodeOne, stats } from './util.ts';
import {
  BlobSource,
  BufferTarget,
  EncodedPacketSink,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSample,
  VideoSampleSource,
} from 'mediabunny';
import { CompositeRenderer } from '../../src/core/render/composite-renderer.ts';
import { POSTER_STYLE } from '../../src/core/style/poster/poster-style-pipeline.ts';
import { defaultControls } from '../../src/core/style/style.ts';

export const PATCHES: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [16, 16, 16],
  [32, 32, 32],
  [64, 64, 64],
  [96, 96, 96],
  [128, 128, 128],
  [160, 160, 160],
  [192, 192, 192],
  [235, 235, 235],
  [255, 255, 255],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [0, 255, 255],
  [255, 0, 255],
];

export const WIDTH = 1920;
export const HEIGHT = 1080;
export const COLS = 4;
export const ROWS = 4;

export interface Decoded {
  readonly frame: VideoFrame;
  /** What the container says the colour is, which is not always what it is. */
  readonly config: VideoDecoderConfig;
}

export async function firstFrameOf(blob: Blob): Promise<Decoded> {
  const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track');
  const config = await track.getDecoderConfig();
  if (!config) throw new Error('no decoder config');
  const packet = await new EncodedPacketSink(track).getFirstKeyPacket();
  if (!packet) throw new Error('no key packet');
  const frame = await decodeOne(config, packet.toEncodedVideoChunk());
  input.dispose();
  return { frame, config };
}

export async function firstFrame(url: string): Promise<VideoFrame> {
  return (await firstFrameOf(await (await fetch(url)).blob())).frame;
}

/** Read the patch centres out of an rgba8unorm texture. */
async function readPatches(dev: GPUDevice, texture: GPUTexture): Promise<[number, number, number][]> {
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = dev.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = dev.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT },
  );
  dev.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();

  const out: [number, number, number][] = [];
  for (let i = 0; i < PATCHES.length; i++) {
    const x = Math.floor(((i % COLS) + 0.5) * (WIDTH / COLS));
    const y = Math.floor((Math.floor(i / COLS) + 0.5) * (HEIGHT / ROWS));
    const o = y * bytesPerRow + x * 4;
    out.push([bytes[o] ?? -1, bytes[o + 1] ?? -1, bytes[o + 2] ?? -1]);
  }
  return out;
}

function target(dev: GPUDevice): GPUTexture {
  return dev.createTexture({
    size: { width: WIDTH, height: HEIGHT },
    format: 'rgba8unorm',
    viewFormats: ['rgba8unorm-srgb'],
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.TEXTURE_BINDING,
  });
}

/** import + one pass, writing through the view named. */
export async function viaExternalTexture(
  dev: GPUDevice,
  frame: VideoFrame,
  writeThrough: GPUTextureFormat,
): Promise<[number, number, number][]> {
  const module = dev.createShaderModule({
    code: `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var frame: texture_external;

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[index], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(frame, samp, pos.xy / vec2f(${String(WIDTH)}.0, ${String(HEIGHT)}.0));
}`,
  });
  const layout = dev.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
    ],
  });
  const pipeline = dev.createRenderPipeline({
    layout: dev.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: writeThrough }] },
    primitive: { topology: 'triangle-list' },
  });

  const texture = target(dev);
  const encoder = dev.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView({ format: writeThrough }),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    dev.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: dev.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) },
        { binding: 1, resource: dev.importExternalTexture({ source: frame }) },
      ],
    }),
  );
  pass.draw(3);
  pass.end();
  dev.queue.submit([encoder.finish()]);

  const values = await readPatches(dev, texture);
  texture.destroy();
  return values;
}

export async function viaCopyExternalImage(
  dev: GPUDevice,
  frame: VideoFrame,
): Promise<[number, number, number][]> {
  const texture = target(dev);
  dev.queue.copyExternalImageToTexture(
    { source: frame, flipY: false },
    { texture, premultipliedAlpha: false },
    { width: WIDTH, height: HEIGHT },
  );
  const values = await readPatches(dev, texture);
  texture.destroy();
  return values;
}

export function error(measured: readonly (readonly [number, number, number])[]): Record<string, unknown> {
  const errors: number[] = [];
  const rows = measured.map((got, i) => {
    const want = PATCHES[i] ?? ([0, 0, 0] as const);
    const delta = [got[0] - want[0], got[1] - want[1], got[2] - want[2]];
    errors.push(Math.max(...delta.map(Math.abs)));
    return { want: want.join(','), got: got.join(','), delta: delta.join(',') };
  });
  return { worst: Math.max(...errors), median_abs: stats(errors).median, rows };
}

export async function colour(dev: GPUDevice, base: string): Promise<unknown> {
  const out: Record<string, unknown> = {
    what: 'known sRGB patches, encoded to h264 and brought back',
    patches: PATCHES.length,
  };

  for (const clip of ['probe-444-lossless', 'probe-420-tv', 'probe-420-pc']) {
    try {
      const frame = await firstFrame(`${base}/${clip}.mp4`);
      const space = frame.colorSpace;
      out[clip] = {
        // Read one property at a time: VideoColorSpace exposes getters on the
        // prototype, so spreading it gives an empty object.
        colorSpace: {
          primaries: space.primaries,
          transfer: space.transfer,
          matrix: space.matrix,
          fullRange: space.fullRange,
        },
        format: frame.format,
        // Written through a PLAIN view: whatever the sample returns lands as
        // bytes. If those bytes are the original sRGB bytes, a video frame can
        // be dropped into Rotyl's source texture with nothing special done to
        // it, and the whole existing colour contract holds unchanged.
        external_to_rgba8unorm: error(await viaExternalTexture(dev, frame, 'rgba8unorm')),
        // Written through an sRGB view, which encodes on write. Correct only if
        // the sample returned LINEAR values.
        external_to_rgba8unorm_srgb: error(await viaExternalTexture(dev, frame, 'rgba8unorm-srgb')),
        copyExternalImageToTexture: error(await viaCopyExternalImage(dev, frame)),
      };
      frame.close();
    } catch (e) {
      out[clip] = { error: String(e) };
    }
  }
  return out;
}

/**
 * MEASUREMENT 6: what the ENCODER does to the same contract.
 *
 * Measurement 4 above asked what happens on the way in and answered that a
 * decoded frame lands in the existing colour path unchanged. The way OUT has
 * never been tested, and it is the direction a clip export depends on: pixels
 * leave through a canvas, become a VideoFrame, are converted to YCbCr by the
 * encoder, and come back through the browser's own conversion. Every one of
 * those steps can apply a transfer function, and applying one twice or not at
 * all is silent in exactly the way measurement 4 found on the way in.
 *
 * The probe is the same sixteen patches, put through the REAL composite with
 * zero coverage, which is `mix(source, styled, 0)` and therefore the source
 * byte for byte. So what reaches the canvas is known exactly, and everything
 * measured after it is the round trip and nothing else.
 *
 * THE CONTROL IS FFMPEG. The same patches, encoded by ffmpeg and decoded
 * through the identical browser path, are already measured above at worst 11
 * codes in the midtones, which is Chrome's BT.709 conversion on the NV12 path
 * rather than anybody's encoder. Comparing our round trip against that one
 * separates "our encode is wrong" from "this is what 4:2:0 costs in this
 * browser", and those are very different findings.
 */

/** Long enough that the encoder has settled and short enough to be instant. */
const PROBE_FRAMES = 10;

function patchBytes(): Uint8Array {
  const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    const row = Math.floor(y / (HEIGHT / ROWS));
    for (let x = 0; x < WIDTH; x++) {
      const patch = PATCHES[row * COLS + Math.floor(x / (WIDTH / COLS))] ?? ([0, 0, 0] as const);
      const o = (y * WIDTH + x) * 4;
      bytes[o] = patch[0];
      bytes[o + 1] = patch[1];
      bytes[o + 2] = patch[2];
      bytes[o + 3] = 255;
    }
  }
  return bytes;
}

/** The patches through the product's composite and onto a canvas, as export leaves them. */
function compositeToCanvas(dev: GPUDevice): { canvas: OffscreenCanvas; dispose: () => void } {
  const source = dev.createTexture({
    size: { width: WIDTH, height: HEIGHT },
    format: 'rgba8unorm',
    viewFormats: ['rgba8unorm-srgb'],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  dev.queue.writeTexture(
    { texture: source },
    patchBytes(),
    { bytesPerRow: WIDTH * 4, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT },
  );

  // Zero coverage everywhere, so the composite returns the source exactly and
  // the style running behind it cannot reach the pixels.
  const mask = dev.createTexture({
    size: { width: WIDTH, height: HEIGHT },
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  dev.queue.writeTexture(
    { texture: mask },
    new Uint8Array(WIDTH * HEIGHT),
    { bytesPerRow: WIDTH, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT },
  );

  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('no webgpu canvas context');
  context.configure({
    device: dev,
    format: 'rgba8unorm',
    viewFormats: ['rgba8unorm-srgb'],
    alphaMode: 'opaque',
  });

  const composite = new CompositeRenderer(dev);
  const encoder = dev.createCommandEncoder();
  composite.renderStyle(encoder, {
    sourceTexture: source,
    sourceSize: { width: WIDTH, height: HEIGHT },
    outputSize: { width: WIDTH, height: HEIGHT },
    style: POSTER_STYLE,
    controls: defaultControls(POSTER_STYLE),
    quality: 'export',
  });
  composite.composite(
    encoder,
    source,
    mask,
    context.getCurrentTexture().createView({ format: 'rgba8unorm-srgb' }),
  );
  dev.queue.submit([encoder.finish()]);

  return {
    canvas,
    dispose: () => {
      composite.dispose();
      source.destroy();
      mask.destroy();
      context.unconfigure();
    },
  };
}

/** Write the canvas out as an MP4, the way the export path will. */
async function encodeCanvas(
  canvas: OffscreenCanvas,
): Promise<{ blob: Blob; colorSpace: VideoColorSpaceInit }> {
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new VideoSampleSource({ codec: 'avc', quality: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source);
  await output.start();

  let colorSpace: VideoColorSpaceInit = {};
  for (let i = 0; i < PROBE_FRAMES; i++) {
    const frame = new VideoFrame(canvas, { timestamp: i * 33_333, duration: 33_333, alpha: 'discard' });
    if (i === 0) colorSpace = frame.colorSpace.toJSON();
    const videoSample = new VideoSample(frame);
    try {
      await source.add(videoSample);
    } finally {
      videoSample.close();
      frame.close();
    }
  }
  source.close();
  await output.finalize();
  return { blob: new Blob([output.target.buffer ?? new ArrayBuffer(0)]), colorSpace };
}

const space = (value: VideoColorSpace): VideoColorSpaceInit => ({
  primaries: value.primaries,
  transfer: value.transfer,
  matrix: value.matrix,
  fullRange: value.fullRange,
});

export async function encodeColour(dev: GPUDevice, base: string): Promise<unknown> {
  const out: Record<string, unknown> = {
    what: 'known sRGB patches through the composite, out through the encoder, and back',
    patches: PATCHES.length,
    frames: PROBE_FRAMES,
  };

  const staged = compositeToCanvas(dev);
  try {
    const { blob, colorSpace } = await encodeCanvas(staged.canvas);
    const { frame, config } = await firstFrameOf(blob);
    out['ours'] = {
      bytes: blob.size,
      handed_to_the_encoder_as: colorSpace,
      container_says: {
        codec: config.codec,
        colorSpace: config.colorSpace ?? null,
      },
      decoded_as: space(frame.colorSpace),
      format: frame.format,
      round_trip: error(await viaCopyExternalImage(dev, frame)),
    };
    frame.close();
  } catch (e) {
    out['ours'] = { error: String(e) };
  } finally {
    staged.dispose();
  }

  // The control. Identical patches, identical decode path, an encoder nobody
  // here wrote, so anything the two share is the browser rather than us.
  try {
    const frame = await firstFrame(`${base}/probe-420-tv.mp4`);
    out['ffmpeg, same decode path'] = {
      decoded_as: space(frame.colorSpace),
      format: frame.format,
      round_trip: error(await viaCopyExternalImage(dev, frame)),
    };
    frame.close();
  } catch (e) {
    out['ffmpeg, same decode path'] = { error: String(e) };
  }

  return out;
}
