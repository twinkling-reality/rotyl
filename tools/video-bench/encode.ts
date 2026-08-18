// MEASUREMENT 5: what an encoded frame costs, and whether the pipeline sustains
// real time.
//
// A VideoEncoder is asynchronous and holds its own queue, so timing one frame
// answers nothing. What decides whether a clip export is a wait or an ordeal is
// SUSTAINED throughput with decode, style, composite, capture, encode and mux
// all in flight, which is what this measures.
//
// It measures it as a LADDER rather than as one number, each rung adding
// exactly one step to the one below it, over the same frames of the same clip:
//
//   decode        pull frame N and put it in the source texture
//   composite     the style chain and the composite, fenced
//   capture       the composited frame as something the encoder will take
//   encode        our own VideoEncoder, packets counted and discarded
//   mux           the same encoder, packets written into an MP4
//   mediabunny    the same file, with the library driving the encoder too
//
// A rung's own cost is the difference from the rung below, so nothing here is
// inferred from a subtraction of numbers taken under different conditions. The
// last two rungs differ only in who owns the VideoEncoder, which is the
// question the bundle measurement raises: the library's encoder wrapper is
// 18 KB gzipped on top of its muxer, and it is worth knowing whether it also
// costs anything per frame.
//
// Everything on the GPU is fenced with queue.onSubmittedWorkDone(). rAF appears
// nowhere; see util.ts.

import {
  BlobSource,
  BufferTarget,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSource,
} from 'mediabunny';
import { CompositeRenderer } from '../../src/core/render/composite-renderer.ts';
import {
  MASK_FORMAT,
  OUTPUT_FORMAT,
  OUTPUT_VIEW_FORMAT,
  SOURCE_FORMAT,
  SOURCE_VIEW_FORMAT,
} from '../../src/core/gpu/formats.ts';
import { COMIC_STYLE } from '../../src/core/style/comic/comic-style-pipeline.ts';
import { POSTER_STYLE } from '../../src/core/style/poster/poster-style-pipeline.ts';
import { PRINT_STYLE } from '../../src/core/style/print/print-style-pipeline.ts';
import { defaultControls, type StyleDefinition, type StyleQuality } from '../../src/core/style/style.ts';
import type { Dimensions } from '../../src/core/render/resolution.ts';
import { stats, type Stat } from './util.ts';

/** copyTextureToBuffer wants a row stride that is a multiple of 256. */
const ROW_ALIGN = 256;

/**
 * How many frames each rung runs over.
 *
 * Long enough that the encoder's queue reaches steady state and that one slow
 * frame does not decide the answer, short enough that the comic chain at 1080p
 * finishes in half a minute. Ninety frames is three seconds of the clip.
 */
const FRAMES = 90;

/**
 * The bitrate both encoders are given, so the ladder's last two rungs differ
 * only in who drives the encoder.
 *
 * Twelve megabits at 1080p30 is generous for stylised output and deliberately
 * so: this is timing an encoder, and starving it would measure a cheaper
 * picture rather than a faster path. What rate control an export should
 * actually use is a separate table below.
 */
const BITRATE = 12_000_000;

/** The tier a clip export actually runs at, so this is what is timed. */
const TIER: StyleQuality = 'export';

const STYLES: readonly StyleDefinition[] = [POSTER_STYLE, PRINT_STYLE, COMIC_STYLE];

interface Clip {
  readonly name: string;
  readonly url: string;
  readonly size: Dimensions;
}

/**
 * Somewhere to decode into, style, composite, and hand out as a frame.
 *
 * The composite target is an OffscreenCanvas configured exactly as the export
 * path configures one, because the whole point of the capture comparison is
 * what it costs to get pixels out of the thing export already renders into.
 */
class Pipeline {
  readonly canvas: OffscreenCanvas;

  readonly #device: GPUDevice;
  readonly #size: Dimensions;
  readonly #source: GPUTexture;
  readonly #mask: GPUTexture;
  readonly #composite: CompositeRenderer;
  readonly #context: GPUCanvasContext;
  readonly #offscreen: GPUTexture;
  readonly #readback: GPUBuffer;
  readonly #paddedRow: number;

  constructor(device: GPUDevice, size: Dimensions, coverage: 'full' | 'none' = 'full') {
    this.#device = device;
    this.#size = size;
    this.#composite = new CompositeRenderer(device);

    this.#source = device.createTexture({
      label: 'encode:source',
      size: { width: size.width, height: size.height },
      format: SOURCE_FORMAT,
      viewFormats: [SOURCE_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Full coverage for timing: the selection is measured elsewhere and a
    // partial mask would make the composite's cost depend on the shape somebody
    // drew. Zero coverage for the alignment check, where the composite has to
    // return the source exactly so a written frame can be recognised.
    this.#mask = device.createTexture({
      label: 'encode:mask',
      size: { width: size.width, height: size.height },
      format: MASK_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const block = new Uint8Array(size.width * 64).fill(coverage === 'full' ? 255 : 0);
    for (let y = 0; y < size.height; y += 64) {
      const rows = Math.min(64, size.height - y);
      device.queue.writeTexture(
        { texture: this.#mask, origin: { x: 0, y } },
        block.subarray(0, size.width * rows),
        { bytesPerRow: size.width, rowsPerImage: rows },
        { width: size.width, height: rows },
      );
    }

    this.canvas = new OffscreenCanvas(size.width, size.height);
    const context = this.canvas.getContext('webgpu');
    if (!context) throw new Error('no webgpu canvas context');
    this.#context = context;
    context.configure({
      device,
      format: OUTPUT_FORMAT,
      viewFormats: [OUTPUT_VIEW_FORMAT],
      alphaMode: 'opaque',
    });

    // The other capture path's target: an ordinary texture, so the comparison
    // is canvas presentation against a texture-to-buffer copy and not against
    // a different render.
    this.#offscreen = device.createTexture({
      label: 'encode:offscreen',
      size: { width: size.width, height: size.height },
      format: OUTPUT_FORMAT,
      viewFormats: [OUTPUT_VIEW_FORMAT],
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.#paddedRow = Math.ceil((size.width * 4) / ROW_ALIGN) * ROW_ALIGN;
    this.#readback = device.createBuffer({
      label: 'encode:readback',
      size: this.#paddedRow * size.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  upload(frame: VideoFrame): void {
    this.#device.queue.copyExternalImageToTexture(
      { source: frame, flipY: false },
      { texture: this.#source, premultipliedAlpha: false },
      { width: frame.displayWidth, height: frame.displayHeight },
    );
  }

  /** Style chain and composite, into the canvas or into the offscreen texture. */
  render(style: StyleDefinition, into: 'canvas' | 'texture'): void {
    const encoder = this.#device.createCommandEncoder({ label: 'encode:frame' });
    this.#composite.renderStyle(encoder, {
      sourceTexture: this.#source,
      sourceSize: this.#size,
      outputSize: this.#size,
      style,
      controls: defaultControls(style),
      quality: TIER,
    });
    const target = into === 'canvas' ? this.#context.getCurrentTexture() : this.#offscreen;
    this.#composite.composite(
      encoder,
      this.#source,
      this.#mask,
      target.createView({ format: OUTPUT_VIEW_FORMAT }),
    );
    this.#device.queue.submit([encoder.finish()]);
  }

  fence(): Promise<undefined> {
    return this.#device.queue.onSubmittedWorkDone();
  }

  /** The composited canvas, as a frame. One copy, and the browser chooses where. */
  fromCanvas(timestamp: number, duration: number): VideoFrame {
    return new VideoFrame(this.canvas, { timestamp, duration, alpha: 'discard' });
  }

  /**
   * The composited texture, as a frame, the long way round.
   *
   * copyTextureToBuffer pads every row to a multiple of 256 bytes, so a 1280
   * pixel row is already aligned and a 1920 pixel row is not. De-padding is a
   * per-row copy on the CPU and is the reason this path is worth timing rather
   * than assuming.
   */
  async fromReadback(timestamp: number, duration: number): Promise<VideoFrame> {
    const encoder = this.#device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.#offscreen },
      { buffer: this.#readback, bytesPerRow: this.#paddedRow, rowsPerImage: this.#size.height },
      { width: this.#size.width, height: this.#size.height },
    );
    this.#device.queue.submit([encoder.finish()]);
    await this.#readback.mapAsync(GPUMapMode.READ);

    const rowBytes = this.#size.width * 4;
    const padded = new Uint8Array(this.#readback.getMappedRange());
    const tight = new Uint8Array(rowBytes * this.#size.height);
    if (this.#paddedRow === rowBytes) tight.set(padded.subarray(0, tight.length));
    else {
      for (let y = 0; y < this.#size.height; y++) {
        tight.set(padded.subarray(y * this.#paddedRow, y * this.#paddedRow + rowBytes), y * rowBytes);
      }
    }
    this.#readback.unmap();

    return new VideoFrame(tight, {
      format: 'RGBA',
      codedWidth: this.#size.width,
      codedHeight: this.#size.height,
      timestamp,
      duration,
    });
  }

  /**
   * A sparse fingerprint of the offscreen target, for telling frames apart.
   *
   * A grid of taps rather than every pixel: this is asked whether two pictures
   * are the same picture, not how far apart they are. Three thousand numbers
   * is far more than that needs and still a thousandth of the frame.
   */
  async signature(): Promise<Float64Array> {
    const encoder = this.#device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.#offscreen },
      { buffer: this.#readback, bytesPerRow: this.#paddedRow, rowsPerImage: this.#size.height },
      { width: this.#size.width, height: this.#size.height },
    );
    this.#device.queue.submit([encoder.finish()]);
    await this.#readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(this.#readback.getMappedRange());

    const grid = 32;
    const out = new Float64Array(grid * grid * 3);
    for (let row = 0; row < grid; row++) {
      const y = Math.floor(((row + 0.5) * this.#size.height) / grid);
      for (let column = 0; column < grid; column++) {
        const x = Math.floor(((column + 0.5) * this.#size.width) / grid);
        const o = y * this.#paddedRow + x * 4;
        const i = (row * grid + column) * 3;
        out[i] = bytes[o] ?? 0;
        out[i + 1] = bytes[o + 1] ?? 0;
        out[i + 2] = bytes[o + 2] ?? 0;
      }
    }
    this.#readback.unmap();
    return out;
  }

  dispose(): void {
    this.#composite.dispose();
    this.#source.destroy();
    this.#mask.destroy();
    this.#offscreen.destroy();
    this.#readback.destroy();
    this.#context.unconfigure();
  }
}

/**
 * Frames of a clip, in order, one at a time.
 *
 * Deliberately not the product's FrameProvider: this is measuring what a
 * forward walk costs with nothing else in the way, and the provider's seek
 * logic, request supersession and queue would all be measured with it.
 */
class Frames {
  readonly count: number;

  readonly #input: Input;
  readonly #config: VideoDecoderConfig;
  readonly #sink: EncodedPacketSink;

  #decoder: VideoDecoder | undefined;
  #ready: VideoFrame[] = [];
  #cursor: EncodedPacket | undefined;
  #failure: unknown;

  private constructor(input: Input, config: VideoDecoderConfig, sink: EncodedPacketSink, count: number) {
    this.#input = input;
    this.#config = config;
    this.#sink = sink;
    this.count = count;
  }

  static async fetch(url: string): Promise<Frames> {
    return Frames.open(await (await fetch(url)).blob());
  }

  static async open(blob: Blob): Promise<Frames> {
    const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const config = await track.getDecoderConfig();
    if (!config) throw new Error('no decoder config');
    const sink = new EncodedPacketSink(track);
    let count = 0;
    for await (const _ of sink.packets(undefined, undefined, { metadataOnly: true })) count++;
    return new Frames(input, config, sink, count);
  }

  async rewind(): Promise<void> {
    this.#drain();
    this.#decoder?.close();
    this.#decoder = new VideoDecoder({
      output: (frame) => this.#ready.push(frame),
      error: (error) => (this.#failure = error),
    });
    this.#decoder.configure({ ...this.#config, optimizeForLatency: true });
    this.#cursor = (await this.#sink.getFirstPacket()) ?? undefined;
    this.#failure = undefined;
  }

  /** The next frame in presentation order, closed by the caller. */
  async next(): Promise<VideoFrame | undefined> {
    for (;;) {
      if (this.#failure) throw this.#failure;
      const ready = this.#ready.shift();
      if (ready) return ready;

      const decoder = this.#decoder;
      if (!decoder || decoder.state !== 'configured') return undefined;
      const packet = this.#cursor;
      if (!packet) {
        await decoder.flush();
        return this.#ready.shift();
      }
      decoder.decode(packet.toEncodedVideoChunk());
      this.#cursor = (await this.#sink.getNextPacket(packet)) ?? undefined;
      if (decoder.decodeQueueSize > 8) await waitForQueue(decoder);
    }
  }

  #drain(): void {
    for (const frame of this.#ready) frame.close();
    this.#ready = [];
  }

  dispose(): void {
    this.#drain();
    // A VideoDecoder that is never closed holds a hardware decode session, and
    // enough of them make the next configure produce nothing, with no error.
    if (this.#decoder && this.#decoder.state !== 'closed') this.#decoder.close();
    this.#decoder = undefined;
    this.#input.dispose();
  }
}

function waitForQueue(codec: VideoDecoder | VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    const onDequeue = (): void => {
      if (codec.state === 'configured' && queueSize(codec) > 4) return;
      codec.removeEventListener('dequeue', onDequeue);
      resolve();
    };
    codec.addEventListener('dequeue', onDequeue);
  });
}

const queueSize = (codec: VideoDecoder | VideoEncoder): number =>
  'decodeQueueSize' in codec ? codec.decodeQueueSize : codec.encodeQueueSize;

/**
 * An H.264 encoder config this browser will accept.
 *
 * Asked rather than assumed, and asked from the top down, because the level is
 * a claim about resolution and frame rate that a decoder is entitled to
 * enforce: a file tagged 3.1 carrying 1080p is a file some players refuse.
 */
const AVC_LEVELS = ['avc1.640034', 'avc1.640028', 'avc1.64001f', 'avc1.42001f'] as const;

async function encoderConfig(
  size: Dimensions,
  latencyMode: 'quality' | 'realtime',
): Promise<VideoEncoderConfig> {
  for (const codec of AVC_LEVELS) {
    const config: VideoEncoderConfig = {
      codec,
      width: size.width,
      height: size.height,
      bitrate: BITRATE,
      framerate: 30,
      latencyMode,
      avc: { format: 'avc' },
    };
    const support = await VideoEncoder.isConfigSupported(config);
    if (support.supported) return support.config ?? config;
  }
  throw new Error('no encodable H.264 configuration');
}

interface Rung {
  /** Wall-clock milliseconds per frame across the whole run. */
  readonly ms_per_frame: number;
  readonly frames_per_s: number;
  /** Per-frame samples, so a min far below the median shows a busy machine. */
  readonly per_frame: Stat;
  readonly frames: number;
  readonly bytes?: number;
  readonly finalize_ms?: number;
  readonly encoded?: number;
  readonly encoder_config?: VideoEncoderConfig;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

/** Mean absolute difference between two fingerprints. */
const distance = (a: Float64Array, b: Float64Array): number =>
  a.reduce((sum, value, i) => sum + Math.abs(value - (b[i] ?? 0)), 0) / a.length;

function rung(samples: readonly number[], extra?: Partial<Rung>): Rung {
  const total = samples.reduce((sum, value) => sum + value, 0);
  const frames = samples.length;
  return {
    ms_per_frame: round(total / frames),
    frames_per_s: round((frames / total) * 1000),
    per_frame: stats(samples),
    frames,
    ...extra,
  };
}

/**
 * Run `step` over the first `FRAMES` frames of the clip and time each one.
 *
 * Decoding is inside the timed region on every rung, including the first,
 * because that is what a real export does: it is 0.46 ms a frame and taking it
 * out would make each rung's marginal cost describe a pipeline nobody runs.
 */
async function walk(
  frames: Frames,
  step: (frame: VideoFrame, index: number) => Promise<void>,
): Promise<Rung> {
  await frames.rewind();
  const samples: number[] = [];
  for (let index = 0; index < Math.min(FRAMES, frames.count); index++) {
    const t0 = performance.now();
    const frame = await frames.next();
    if (!frame) break;
    try {
      await step(frame, index);
    } finally {
      frame.close();
    }
    samples.push(performance.now() - t0);
  }
  return rung(samples);
}

/** Presentation time and duration in microseconds, from the frame itself. */
const timing = (frame: VideoFrame): { timestamp: number; duration: number } => ({
  timestamp: frame.timestamp,
  duration: frame.duration ?? 33_333,
});

async function ladder(device: GPUDevice, clip: Clip, style: StyleDefinition): Promise<unknown> {
  const frames = await Frames.fetch(clip.url);
  const pipeline = new Pipeline(device, clip.size);
  const out: Record<string, unknown> = {};

  try {
    out['decode'] = await walk(frames, async (frame) => {
      pipeline.upload(frame);
      await pipeline.fence();
    });

    out['composite'] = await walk(frames, async (frame) => {
      pipeline.upload(frame);
      pipeline.render(style, 'canvas');
      await pipeline.fence();
    });

    out['capture, canvas'] = await walk(frames, async (frame) => {
      pipeline.upload(frame);
      pipeline.render(style, 'canvas');
      await pipeline.fence();
      const { timestamp, duration } = timing(frame);
      pipeline.fromCanvas(timestamp, duration).close();
    });

    out['capture, readback'] = await walk(frames, async (frame) => {
      pipeline.upload(frame);
      pipeline.render(style, 'texture');
      const { timestamp, duration } = timing(frame);
      (await pipeline.fromReadback(timestamp, duration)).close();
    });

    out['encode'] = await encodeRung(pipeline, frames, style, clip, 'discard');
    out['mux'] = await encodeRung(pipeline, frames, style, clip, 'mux');
    // The same bitrate our own encoder was given, so what separates this rung
    // from the one above it is the wrapper and not 2.5 times the bits.
    out['mediabunny'] = await mediabunnyRung(pipeline, frames, style, new Quality({ bitrate: BITRATE }));
  } finally {
    pipeline.dispose();
    frames.dispose();
  }
  return out;
}

/**
 * Our own VideoEncoder, with the packets either dropped or written.
 *
 * The two share every line but the sink, which is what makes the difference
 * between them the muxer and nothing else.
 */
async function encodeRung(
  pipeline: Pipeline,
  frames: Frames,
  style: StyleDefinition,
  clip: Clip,
  sink: 'discard' | 'mux',
): Promise<Rung> {
  const config = await encoderConfig(clip.size, 'quality');
  let encoded = 0;
  let failure: unknown;

  const output =
    sink === 'mux' ? new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() }) : undefined;
  const packets = output ? new EncodedVideoPacketSource('avc') : undefined;
  if (output && packets) {
    output.addVideoTrack(packets);
    await output.start();
  }

  // Awaited at the end rather than per packet: the callback is synchronous and
  // returning a promise from it would let the encoder run ahead of the muxer.
  let writing: Promise<unknown> = Promise.resolve();
  let first = true;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      encoded++;
      if (!packets) return;
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      const metadata = first ? meta : undefined;
      first = false;
      writing = writing.then(() => packets.add(packet, metadata));
    },
    error: (error) => (failure = error),
  });
  encoder.configure(config);

  const result = await walk(frames, async (frame, index) => {
    pipeline.upload(frame);
    pipeline.render(style, 'canvas');
    await pipeline.fence();
    const { timestamp, duration } = timing(frame);
    const captured = pipeline.fromCanvas(timestamp, duration);
    try {
      // Two seconds of keyframes, which is the muxer's own default and what a
      // file somebody scrubs through wants.
      encoder.encode(captured, { keyFrame: index % 60 === 0 });
    } finally {
      captured.close();
    }
    if (encoder.encodeQueueSize > 4) await waitForQueue(encoder);
  });

  await encoder.flush();
  encoder.close();
  await writing;
  if (failure) throw failure;

  if (!output || !packets) return { ...result, encoded };

  packets.close();
  const t0 = performance.now();
  await output.finalize();
  return {
    ...result,
    encoded,
    bytes: output.target.buffer?.byteLength ?? 0,
    finalize_ms: round(performance.now() - t0),
  };
}

/** The same file, with the library owning the encoder as well as the container. */
async function mediabunnyRung(
  pipeline: Pipeline,
  frames: Frames,
  style: StyleDefinition,
  quality: Quality,
): Promise<Rung> {
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  let encoderConfigSeen: VideoEncoderConfig | undefined;
  const source = new VideoSampleSource({
    codec: 'avc',
    quality,
    keyFrameInterval: 2,
    onEncoderConfig: (config) => (encoderConfigSeen = config),
  });
  output.addVideoTrack(source);
  await output.start();

  const result = await walk(frames, async (frame) => {
    pipeline.upload(frame);
    pipeline.render(style, 'canvas');
    await pipeline.fence();
    const { timestamp, duration } = timing(frame);
    const captured = pipeline.fromCanvas(timestamp, duration);
    const videoSample = new VideoSample(captured);
    try {
      await source.add(videoSample);
    } finally {
      videoSample.close();
      captured.close();
    }
  });

  source.close();
  const t0 = performance.now();
  await output.finalize();
  const finalizeMs = round(performance.now() - t0);
  return {
    ...result,
    bytes: output.target.buffer?.byteLength ?? 0,
    finalize_ms: finalizeMs,
    ...(encoderConfigSeen ? { encoder_config: encoderConfigSeen } : {}),
  };
}

/** The end of the ladder for every style, which is the number the design turns on. */
async function endToEnd(device: GPUDevice, clip: Clip): Promise<unknown> {
  const frames = await Frames.fetch(clip.url);
  const pipeline = new Pipeline(device, clip.size);
  const out: Record<string, unknown> = {};
  try {
    for (const style of STYLES) {
      out[style.id] = await encodeRung(pipeline, frames, style, clip, 'mux');
    }
  } finally {
    pipeline.dispose();
    frames.dispose();
  }
  return out;
}

/**
 * What the encoder alone does with a real picture, with the GPU taken out.
 *
 * The same captured frame, handed over `FRAMES` times with advancing
 * timestamps. It is a floor rather than a prediction: a still picture gives the
 * motion estimator nothing to do, so a real clip cannot be faster than this.
 */
async function encoderFloor(device: GPUDevice, clip: Clip): Promise<unknown> {
  const frames = await Frames.fetch(clip.url);
  const pipeline = new Pipeline(device, clip.size);
  const out: Record<string, unknown> = {};
  try {
    await frames.rewind();
    const first = await frames.next();
    if (!first) throw new Error('no frames');
    pipeline.upload(first);
    pipeline.render(POSTER_STYLE, 'canvas');
    await pipeline.fence();
    first.close();

    for (const latencyMode of ['quality', 'realtime'] as const) {
      const config = await encoderConfig(clip.size, latencyMode);
      let encoded = 0;
      const encoder = new VideoEncoder({
        output: () => encoded++,
        error: (error) => {
          throw error;
        },
      });
      encoder.configure(config);

      const samples: number[] = [];
      for (let index = 0; index < FRAMES; index++) {
        const t0 = performance.now();
        const captured = pipeline.fromCanvas(index * 33_333, 33_333);
        try {
          encoder.encode(captured, { keyFrame: index % 60 === 0 });
        } finally {
          captured.close();
        }
        if (encoder.encodeQueueSize > 4) await waitForQueue(encoder);
        samples.push(performance.now() - t0);
      }
      await encoder.flush();
      encoder.close();
      out[latencyMode] = { ...rung(samples), encoded, dropped: FRAMES - encoded, codec: config.codec };
    }
  } finally {
    pipeline.dispose();
    frames.dispose();
  }
  return out;
}

/**
 * What rate control costs, and what it produces.
 *
 * The ladder holds the bitrate fixed so it can time an encoder. This asks the
 * separate product question: what should a clip export ask for. A qualitative
 * level resolves to a QUANTIZER where the codec supports one, which is
 * constant quality and therefore an unbounded file; asking for the same level
 * as a BITRATE is a predictable file and a variable picture. Both are one line
 * of configuration, and the difference between them is a factor on the size of
 * everything anybody exports.
 *
 * Measured on a styled frame rather than on the source, because that is what an
 * export encodes and flat areas compress nothing like film grain does.
 */
async function rateControl(device: GPUDevice, clip: Clip, style: StyleDefinition): Promise<unknown> {
  const frames = await Frames.fetch(clip.url);
  const pipeline = new Pipeline(device, clip.size);
  const out: Record<string, unknown> = {};
  try {
    const cases: readonly (readonly [string, Quality])[] = [
      ['high, quantizer', new Quality({ quality: 'high' })],
      ['high, bitrate', new Quality({ quality: 'high', preferBitrate: true })],
      ['very-high, bitrate', new Quality({ quality: 'very-high', preferBitrate: true })],
      ['12 Mbit/s', new Quality({ bitrate: BITRATE })],
    ];
    for (const [name, quality] of cases) {
      const measured = await mediabunnyRung(pipeline, frames, style, quality);
      const seconds = (measured.frames * 33_333) / 1e6;
      out[name] = {
        ...measured,
        megabits_per_s: round(((measured.bytes ?? 0) * 8) / seconds / 1e6),
      };
    }
  } finally {
    pipeline.dispose();
    frames.dispose();
  }
  return out;
}

/**
 * Does the capture take frame N, or frame N minus one?
 *
 * A canvas is PRESENTED rather than read, so "capture the canvas" is a claim
 * about when as much as about what. Being one frame out is invisible in every
 * timing number above while making every exported clip wrong, and wrong in the
 * way that matters most here: the selection drawn on frame N would land on the
 * pixels of frame N minus one.
 *
 * So the whole path runs for real and the file is decoded back. The composite
 * runs at ZERO coverage, which returns the source exactly, so a written frame
 * should match the source frame it came from and no other.
 *
 * Two things stop this being a test that passes by accident. The signature and
 * the encoded frame are taken from the SAME uploaded source frame, one render
 * each, so nothing is compared across two decodes of the same file. And the
 * source frames are spaced apart, because consecutive frames of a slow zoom
 * differ by less than the codec does and an argmin over them would be reading
 * noise. What is reported is the offset AND the margin: how much better the
 * frame it matched was than its neighbours.
 */
async function alignment(device: GPUDevice, clip: Clip): Promise<unknown> {
  const count = 16;
  /** Frames apart, so neighbours are further away than the codec's own error. */
  const stride = 4;
  const pipeline = new Pipeline(device, clip.size, 'none');
  const frames = await Frames.fetch(clip.url);

  try {
    const config = await encoderConfig(clip.size, 'quality');
    const file = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const packets = new EncodedVideoPacketSource('avc');
    file.addVideoTrack(packets);
    await file.start();

    let writing: Promise<unknown> = Promise.resolve();
    let first = true;
    let failure: unknown;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const packet = EncodedPacket.fromEncodedChunk(chunk);
        const metadata = first ? meta : undefined;
        first = false;
        writing = writing.then(() => packets.add(packet, metadata));
      },
      error: (error) => (failure = error),
    });
    encoder.configure(config);

    const source: Float64Array[] = [];
    await frames.rewind();
    for (let index = 0; index < count; index++) {
      let frame: VideoFrame | undefined;
      for (let skip = 0; skip < (index === 0 ? 1 : stride); skip++) {
        frame?.close();
        frame = await frames.next();
      }
      if (!frame) break;
      try {
        pipeline.upload(frame);
        // The signature first, off a plain texture, then the same source
        // through the same composite into the canvas the encoder reads.
        pipeline.render(POSTER_STYLE, 'texture');
        source.push(await pipeline.signature());
        pipeline.render(POSTER_STYLE, 'canvas');
        await pipeline.fence();
        const captured = pipeline.fromCanvas(index * 33_333, 33_333);
        try {
          encoder.encode(captured, { keyFrame: index === 0 });
        } finally {
          captured.close();
        }
      } finally {
        frame.close();
      }
      if (encoder.encodeQueueSize > 4) await waitForQueue(encoder);
    }

    await encoder.flush();
    encoder.close();
    await writing;
    if (failure) throw failure;
    packets.close();
    await file.finalize();
    const written = new Blob([file.target.buffer ?? new ArrayBuffer(0)]);

    const back = await Frames.open(written);
    const produced: Float64Array[] = [];
    try {
      await back.rewind();
      for (let index = 0; index < source.length; index++) {
        const frame = await back.next();
        if (!frame) break;
        try {
          pipeline.upload(frame);
          pipeline.render(POSTER_STYLE, 'texture');
          produced.push(await pipeline.signature());
        } finally {
          frame.close();
        }
      }
    } finally {
      back.dispose();
    }

    const matched = produced.map((signature, index) => {
      const distances = source.map((candidate) => distance(candidate, signature));
      let best = 0;
      distances.forEach((value, k) => {
        if (value < (distances[best] ?? Number.POSITIVE_INFINITY)) best = k;
      });
      const others = distances.filter((_, k) => k !== index);
      return {
        offset: best - index,
        own: round(distances[index] ?? 0),
        nearest_other: round(Math.min(...others)),
      };
    });

    return {
      what: 'each written frame against the source frame it was rendered from',
      frames: produced.length,
      stride,
      // The number that matters. Anything but zero and every exported clip is
      // a frame out of step with the selection drawn on it.
      worst_offset: matched.length === 0 ? null : Math.max(...matched.map((row) => Math.abs(row.offset))),
      // How much better the match was than the next best, so a zero above can
      // be read as a result rather than as a coin landing the right way up.
      worst_margin:
        matched.length === 0
          ? null
          : round(Math.min(...matched.map((row) => row.nearest_other / Math.max(row.own, 1e-6)))),
      bytes: written.size,
      rows: matched,
    };
  } finally {
    pipeline.dispose();
    frames.dispose();
  }
}

export async function encode(device: GPUDevice, base: string): Promise<unknown> {
  const smaller: Clip = { name: '720p', url: `${base}/720p30-gop30.mp4`, size: { width: 1280, height: 720 } };
  const larger: Clip = {
    name: '1080p',
    url: `${base}/1080p30-gop30.mp4`,
    size: { width: 1920, height: 1080 },
  };
  const clips: readonly Clip[] = [smaller, larger];

  const out: Record<string, unknown> = {
    what: 'sustained throughput of the whole export pipeline, per frame',
    frames: FRAMES,
    tier: TIER,
  };
  for (const clip of clips) {
    out[`${clip.name}, encoder alone`] = await encoderFloor(device, clip);
    // The ladder runs on poster because it is about where the time goes rather
    // than about a style, and poster is the one a clip would be exported with.
    out[`${clip.name}, ladder (poster)`] = await ladder(device, clip, POSTER_STYLE);
    out[`${clip.name}, end to end`] = await endToEnd(device, clip);
  }
  out['rate control (1080p, poster)'] = await rateControl(device, larger, POSTER_STYLE);
  out['capture alignment (720p)'] = await alignment(device, smaller);
  return out;
}
