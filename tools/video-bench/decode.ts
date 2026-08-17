// MEASUREMENT 3: demux and decode throughput, and what a decoded frame costs to
// get onto the GPU.
//
// The three numbers that decide whether scrubbing is a render loop or a
// background job:
//   demux      how fast packets come out of the container, with no decoding
//   decode     sustained frames per second, and the cost of a SEEK, which is
//              keyframe-plus-decode-forward and therefore set by GOP length
//   upload     VideoFrame to a Rotyl source texture, fenced

import { BlobSource, EncodedPacketSink, Input, MP4, type EncodedPacket } from 'mediabunny';
import { decodeOne, sample, stats, type Stat } from './util.ts';

export interface Clip {
  readonly url: string;
  readonly name: string;
}

interface Opened {
  readonly input: Input;
  readonly track: NonNullable<Awaited<ReturnType<Input['getPrimaryVideoTrack']>>>;
  readonly config: VideoDecoderConfig;
  readonly blobBytes: number;
}

async function open(clip: Clip): Promise<Opened> {
  const blob = await (await fetch(clip.url)).blob();
  const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error(`${clip.name}: no video track`);
  const config = await track.getDecoderConfig();
  if (!config) throw new Error(`${clip.name}: no decoder config`);
  return { input, track, config, blobBytes: blob.size };
}

/** Every packet, pulled but not decoded. */
async function demux(clip: Clip): Promise<Record<string, unknown>> {
  const timings: number[] = [];
  let packets = 0;
  let bytes = 0;
  let keyPackets = 0;
  let openMs = 0;

  for (let run = 0; run < 4; run++) {
    const t0 = performance.now();
    const blob = await (await fetch(clip.url)).blob();
    const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no track');
    await track.getDecoderConfig();
    const tOpen = performance.now();
    const sink = new EncodedPacketSink(track);
    packets = 0;
    bytes = 0;
    keyPackets = 0;
    for await (const packet of sink.packets()) {
      packets++;
      bytes += packet.byteLength;
      if (packet.type === 'key') keyPackets++;
    }
    const t1 = performance.now();
    input.dispose();
    if (run > 0) {
      timings.push(t1 - tOpen);
      openMs = tOpen - t0;
    }
  }

  const walk = stats(timings);
  return {
    packets,
    key_packets: keyPackets,
    bytes,
    open_and_read_config_ms: Math.round(openMs * 100) / 100,
    walk_all_packets_ms: walk,
    mb_per_s: Math.round(bytes / walk.median / 1000),
    packets_per_s: Math.round((packets / walk.median) * 1000),
  };
}

/** Decode the whole clip. Frames are closed the moment they arrive. */
async function decodeAll(clip: Clip, onFrame?: (frame: VideoFrame) => void): Promise<Record<string, number>> {
  const { input, track, config } = await open(clip);
  const sink = new EncodedPacketSink(track);
  const chunks: EncodedVideoChunk[] = [];
  for await (const packet of sink.packets()) chunks.push(packet.toEncodedVideoChunk());
  input.dispose();

  let frames = 0;
  let firstFrameMs = 0;
  const t0 = performance.now();
  let error: unknown;
  const decoder = new VideoDecoder({
    output: (frame) => {
      frames++;
      if (frames === 1) firstFrameMs = performance.now() - t0;
      onFrame?.(frame);
      frame.close();
    },
    error: (e) => {
      error = e;
    },
  });
  decoder.configure({ ...config, optimizeForLatency: false });

  for (const chunk of chunks) {
    decoder.decode(chunk);
    // Backpressure. Without it every chunk is queued at once and the number
    // measures the queue rather than the decoder.
    if (decoder.decodeQueueSize > 8) {
      await new Promise<void>((resolve) => {
        decoder.addEventListener('dequeue', function once() {
          if (decoder.decodeQueueSize <= 4) {
            decoder.removeEventListener('dequeue', once);
            resolve();
          }
        });
      });
    }
  }
  await decoder.flush();
  const elapsed = performance.now() - t0;
  decoder.close();
  if (error) throw error;

  return {
    frames,
    ms: Math.round(elapsed * 100) / 100,
    fps: Math.round((frames / elapsed) * 1000),
    first_frame_ms: Math.round(firstFrameMs * 100) / 100,
  };
}

/**
 * Seek: the number that decides whether a timeline can be scrubbed.
 *
 * There is no such thing as decoding frame N. There is decoding from the
 * keyframe at or before N and throwing away what comes between, so the cost is
 * set by GOP length and nothing else.
 */
async function seek(clip: Clip, targets: readonly number[]): Promise<Record<string, unknown>> {
  const { input, track, config } = await open(clip);
  const sink = new EncodedPacketSink(track);

  const duration = await track.computeDuration();
  const results: { target: number; ms: number; decoded: number }[] = [];
  for (const raw of targets) {
    // Clamped: a target past the end has no key packet at all, and the wait for
    // a frame that is never coming looks exactly like a hang.
    const target = Math.min(raw, Math.max(0, duration - 0.05));
    const t0 = performance.now();
    let decoded = 0;
    let done: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      done = resolve;
    });
    const decoder = new VideoDecoder({
      output: (frame) => {
        decoded++;
        // Presentation order, so the first output at or after the target is the
        // frame asked for.
        if (frame.timestamp / 1e6 >= target - 1e-6) done?.();
        frame.close();
      },
      error: () => {
        done?.();
      },
    });
    decoder.configure({ ...config, optimizeForLatency: true });

    let packet: EncodedPacket | null = await sink.getKeyPacket(target);
    let queued = 0;
    while (packet) {
      decoder.decode(packet.toEncodedVideoChunk());
      queued++;
      if (packet.timestamp >= target && queued > 2) break;
      packet = await sink.getNextPacket(packet);
    }
    void decoder.flush().then(
      () => done?.(),
      () => done?.(),
    );
    await arrived;
    results.push({ target, ms: Math.round((performance.now() - t0) * 100) / 100, decoded });
    decoder.close();
  }

  input.dispose();
  return {
    per_seek: results,
    ms: stats(results.map((r) => r.ms)),
    frames_decoded: stats(results.map((r) => r.decoded)),
  };
}

/** A decoded frame onto the GPU, three ways, fenced. */
async function upload(clip: Clip, dev: GPUDevice): Promise<Record<string, unknown>> {
  const { input, track, config } = await open(clip);
  const sink = new EncodedPacketSink(track);
  const first = await sink.getFirstKeyPacket();
  if (!first) throw new Error('no key packet');

  const frame = await decodeOne(config, first.toEncodedVideoChunk());
  input.dispose();

  const width = frame.displayWidth;
  const height = frame.displayHeight;

  const target = dev.createTexture({
    label: 'bench-video-source',
    size: { width, height },
    format: 'rgba8unorm',
    viewFormats: ['rgba8unorm-srgb'],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const copy = await sample(30, 5, async () => {
    dev.queue.copyExternalImageToTexture(
      { source: frame, flipY: false },
      { texture: target, premultipliedAlpha: false },
      { width, height },
    );
    await dev.queue.onSubmittedWorkDone();
  });

  const external = await externalTexturePass(dev, frame, width, height);

  // What the whole per-frame path costs together: decode one frame and upload
  // it, with nothing else in the way.
  const bitmapCopy = await sample(10, 2, async () => {
    const bitmap = await createImageBitmap(frame);
    dev.queue.copyExternalImageToTexture(
      { source: bitmap, flipY: false },
      { texture: target, premultipliedAlpha: false },
      { width, height },
    );
    await dev.queue.onSubmittedWorkDone();
    bitmap.close();
  });

  const format = frame.format;
  // Read one property at a time: VideoColorSpace exposes getters on the
  // prototype, so spreading it gives an empty object.
  const space = frame.colorSpace;
  const colorSpace = {
    primaries: space.primaries,
    transfer: space.transfer,
    matrix: space.matrix,
    fullRange: space.fullRange,
  };
  frame.close();
  target.destroy();

  return {
    frame: { width, height, format, colorSpace },
    copyExternalImageToTexture_videoframe: copy,
    importExternalTexture_and_pass: external,
    createImageBitmap_then_copy: bitmapCopy,
  };
}

async function externalTexturePass(
  dev: GPUDevice,
  frame: VideoFrame,
  width: number,
  height: number,
): Promise<Stat> {
  const module = dev.createShaderModule({
    code: `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var frame: texture_external;

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[index], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(frame, samp, pos.xy / vec2f(${String(width)}.0, ${String(height)}.0));
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
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  const sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const target = dev.createTexture({
    size: { width, height },
    format: 'rgba8unorm',
    viewFormats: ['rgba8unorm-srgb'],
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const view = target.createView({ format: 'rgba8unorm-srgb' });

  const result = await sample(30, 5, async () => {
    // Imported per iteration on purpose: an external texture expires at the end
    // of the task it was imported in.
    const external = dev.importExternalTexture({ source: frame });
    const encoder = dev.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      dev.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: external },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    dev.queue.submit([encoder.finish()]);
    await dev.queue.onSubmittedWorkDone();
  });

  target.destroy();
  return result;
}

/** Decode and upload together, which is what playback actually is. */
async function playback(clip: Clip, dev: GPUDevice): Promise<Record<string, number>> {
  const target = dev.createTexture({
    label: 'bench-playback',
    size: { width: 1920, height: 1080 },
    format: 'rgba8unorm',
    viewFormats: ['rgba8unorm-srgb'],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const result = await decodeAll(clip, (frame) => {
    dev.queue.copyExternalImageToTexture(
      { source: frame, flipY: false },
      { texture: target, premultipliedAlpha: false },
      { width: frame.displayWidth, height: frame.displayHeight },
    );
  });
  await dev.queue.onSubmittedWorkDone();
  target.destroy();
  return result;
}

/**
 * What `configure()` costs.
 *
 * Measured because the first decode of the session read 139 ms to first frame
 * against 11 ms for every later one, and a scrub that stands up a decoder per
 * seek would pay it every time.
 */
async function configureCost(clip: Clip): Promise<Record<string, unknown>> {
  const { input, track, config } = await open(clip);
  const packet = await new EncodedPacketSink(track).getFirstKeyPacket();
  input.dispose();
  if (!packet) throw new Error('no key packet');

  const samples: number[] = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    const frame = await decodeOne(config, packet.toEncodedVideoChunk());
    samples.push(performance.now() - t0);
    frame.close();
  }
  return { first: Math.round((samples[0] ?? 0) * 100) / 100, later: stats(samples.slice(1)) };
}

export async function video(dev: GPUDevice, clips: readonly Clip[]): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const clip of clips) {
    const targets = [0.4, 3.7, 1.2, 8.9, 5.5, 9.7, 2.1, 6.3];
    // Discarded: the first decode of a session pays for standing the hardware
    // decoder up, and that belongs in its own row rather than smeared over a
    // throughput figure.
    await decodeAll(clip);
    out[clip.name] = {
      demux: await demux(clip),
      new_decoder_to_first_frame: await configureCost(clip),
      decode_only: await decodeAll(clip),
      decode_and_upload: await playback(clip, dev),
      seek: await seek(clip, targets),
      upload: await upload(clip, dev),
    };
  }
  return out;
}
