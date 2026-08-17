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
import { BlobSource, EncodedPacketSink, Input, MP4 } from 'mediabunny';

const PATCHES: readonly (readonly [number, number, number])[] = [
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

const WIDTH = 1920;
const HEIGHT = 1080;
const COLS = 4;
const ROWS = 4;

async function firstFrame(url: string): Promise<VideoFrame> {
  const blob = await (await fetch(url)).blob();
  const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track');
  const config = await track.getDecoderConfig();
  if (!config) throw new Error('no decoder config');
  const packet = await new EncodedPacketSink(track).getFirstKeyPacket();
  if (!packet) throw new Error('no key packet');
  const frame = await decodeOne(config, packet.toEncodedVideoChunk());
  input.dispose();
  return frame;
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
async function viaExternalTexture(
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

async function viaCopyExternalImage(dev: GPUDevice, frame: VideoFrame): Promise<[number, number, number][]> {
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

function error(measured: readonly (readonly [number, number, number])[]): Record<string, unknown> {
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
