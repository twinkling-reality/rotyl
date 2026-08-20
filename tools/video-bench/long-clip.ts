// MEASUREMENT 10: how long a clip can be written, what stops it, and what a
// file handle changes.
//
// `docs/limits.md` said a ten-minute export "would be closer to a gigabyte, and
// this has no answer for that beyond failing", which named a consequence and
// measured nothing: a tab that dies is a different problem from one that swaps
// for four minutes and finishes, and the two want different answers.
//
// It drives the product's own export loop, `runExport` with the shipping
// `clipSink`, over a source that hands the same clip round again with
// monotonically increasing timestamps. Nothing about the encoder or the muxer
// knows the frames repeat: the packets are real, the bitrate is the export's
// own, and the bytes that pile up are the bytes a real export of that length
// would pile up.
//
// ONE THING HERE IS NOT THE PRODUCT'S CODE, and it is the thing being compared
// against: the sink the product had BEFORE this chapter, which held every
// encoded packet until the end. It is reproduced below rather than imported,
// because it no longer exists to import, and the ladder that finds the ceiling
// is the ladder that ran against it.
//
// ITS OWN COMMAND, AND OUT OF `all`. The ladder ends by running the tab out of
// memory, which is not a thing to do in the middle of a run that has nine other
// measurements left to take. It is also twenty minutes, where `all` is three.
//
//   node tools/video-bench/run.mjs long-clip
//
// which passes --expose-gc, so a rung can let go of what the one before it
// allocated. Without that each rung measures the one before it as well.
//
// DO NOT EDIT ANYTHING UNDER src/ WHILE THIS RUNS. The dev server hot-reloads
// the page underneath it, which arrives as "the execution context was
// destroyed" and reads exactly like the out-of-memory crash this is looking
// for. The first two runs of this measurement lost a tab that way.

import {
  BufferTarget,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSource,
  getFirstEncodableVideoCodec,
  type VideoCodec,
} from 'mediabunny';
import { CompositeRenderer } from '../../src/core/render/composite-renderer.ts';
import { MaskRefiner } from '../../src/core/mask/mask-refiner.ts';
import { POSTER_STYLE } from '../../src/core/style/poster/poster-style-pipeline.ts';
import { defaultControls } from '../../src/core/style/style.ts';
import {
  runExport,
  type ExportFrame,
  type ExportResult,
  type ExportSource,
  type FrameSink,
  type SinkState,
  type Written,
} from '../../src/platform/export/export.ts';
import { clipSink } from '../../src/platform/export/clip-sink.ts';
import { FrameProvider } from '../../src/platform/video/frame-provider.ts';
import type { SelectionCommand } from '../../src/core/document/selection-command.ts';
import type { Dimensions } from '../../src/core/render/resolution.ts';
import type { WritableFile } from '../../src/platform/export/destination.ts';
import { Frames } from './encode.ts';

/** 1080p30, which is what every other figure on this page is anchored at. */
const SIZE: Dimensions = { width: 1920, height: 1080 };
const FPS = 30;
const FRAME_MICROS = Math.round(1e6 / FPS);

/**
 * The ladder, in minutes of footage, against the sink that shipped before this.
 *
 * It stops at the first rung that fails, so the cost of the tail is only paid
 * on a machine that can afford it. Five-minute steps because the question a
 * reader has is "how long a clip can I export" and that is about the resolution
 * at which the answer stops mattering.
 */
const LADDER_MINUTES = [5, 10, 15, 20, 25] as const;

/** A length every path survives, where the three of them can be compared. */
const COMPARE_MINUTES = 10;

/**
 * Long enough that the in-memory path has to stop before the end of it.
 *
 * The budget in `clip-sink.ts` is a fraction of the heap the browser admits to,
 * so what this has to be past is a number that differs by machine. Thirty
 * minutes is about 2.6 GB at this bitrate, which is past any budget a browser
 * with a four gigabyte heap can offer.
 */
const PAST_THE_BUDGET_MINUTES = 30;

/** How often the run says where it has got to, in frames. Ten seconds of footage. */
const CHECKPOINT = 300;

/**
 * The rate control the product asks for, so the bytes piling up are the bytes a
 * real export piles up.
 *
 * Stated here rather than imported from `clip-sink.ts`, because what it
 * configures is the sink that no longer exists, and a baseline that moved when
 * the product moved would measure nothing.
 */
const QUALITY = new Quality({ quality: 'very-high', preferBitrate: true });
const KEYFRAME_INTERVAL_SECONDS = 1;
const CODECS: readonly VideoCodec[] = ['avc'];

/**
 * A collectable heap, present only under --expose-gc, which `run.mjs` passes
 * for this measurement and for no other. A ladder that cannot let go of the
 * rung before it is measuring two rungs.
 *
 * Reached through `Reflect` rather than declared, because Node's own types
 * already declare a global of this name with a shape of its own, and a second
 * declaration is an error rather than a merge.
 */
function collect(): void {
  const found: unknown = Reflect.get(globalThis, 'gc');
  if (typeof found === 'function') Reflect.apply(found, undefined, []);
}

const collectable = (): boolean => typeof Reflect.get(globalThis, 'gc') === 'function';

interface Heap {
  readonly used: number;
  readonly limit: number;
}

/**
 * What the tab is holding, and what it is allowed to hold.
 *
 * `performance.memory` is declared by `clip-sink.ts`, which is the code being
 * measured, and it is the only thing here that answers the question at all:
 * `measureUserAgentSpecificMemory` needs cross-origin isolation, which this dev
 * server does not have and which would change what the rest of the page can
 * fetch. Checked rather than assumed to count the buffers this measurement is
 * about: a gigabyte of `ArrayBuffer` moves `usedJSHeapSize` by a gigabyte on
 * this build, and a resizable one resized and written to moves it by what the
 * resize committed.
 */
function heap(): Heap {
  const memory = performance.memory;
  if (!memory) throw new Error('no performance.memory: this needs Chrome');
  return { used: memory.usedJSHeapSize, limit: memory.jsHeapSizeLimit };
}

const mb = (bytes: number): number => Math.round(bytes / 1048576);
const round = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Let go of the last rung before measuring the next one.
 *
 * A rung that allocated three gigabytes and dropped them is still holding them
 * as far as the next rung's peak is concerned until V8 decides otherwise, and
 * "otherwise" is memory pressure, which is the thing being measured. Absent
 * without --expose-gc, in which case the ladder measures itself plus whatever
 * came before it, and `gc_available` in the output says which run this was.
 */
async function settle(): Promise<void> {
  collect();
  // A macrotask, so anything freed on a microtask has been.
  await new Promise((resolve) => setTimeout(resolve, 200));
  collect();
}

/**
 * The clip, handed round again for as long as it is asked for.
 *
 * Timestamps come from the position in the export rather than from the frame,
 * so the file that comes out is one continuous clip of the requested length
 * rather than the same ten seconds stamped over itself. That is the only thing
 * this pretends about: the pixels repeat, the packets do not.
 */
function loopingSource(frames: Frames, count: number): ExportSource {
  return {
    width: SIZE.width,
    height: SIZE.height,
    frames: Array.from({ length: count }, (_, index) => ({
      index,
      timestampMicros: index * FRAME_MICROS,
      durationMicros: FRAME_MICROS,
    })),
    async fill(device: GPUDevice, texture: GPUTexture): Promise<void> {
      let frame = await frames.next();
      if (!frame) {
        await frames.rewind();
        frame = await frames.next();
      }
      if (!frame) throw new Error('the clip produced no frames');
      try {
        device.queue.copyExternalImageToTexture(
          { source: frame, flipY: false },
          { texture, premultipliedAlpha: false },
          { width: frame.displayWidth, height: frame.displayHeight },
        );
      } finally {
        frame.close();
      }
    },
    release() {
      /* the reader belongs to the caller, and the next rung reuses it */
    },
  };
}

/** Everything selected, so the style chain and the composite both do their work. */
const COMMANDS: readonly SelectionCommand[] = [
  { frame: 0, kind: 'rect', rect: { x0: 0, y0: 0, x1: SIZE.width, y1: SIZE.height }, mode: 'paint' },
];

interface Rung {
  readonly minutes: number;
  readonly ok: boolean;
  /** How many frames are in the file, which is fewer than asked for if it stopped. */
  readonly frames?: number;
  readonly asked: number;
  readonly ended?: string;
  readonly seconds?: number;
  readonly ms_per_frame?: number;
  readonly file_mb?: number;
  /** What it was holding on the last frame, before anything was finalized. */
  readonly heap_while_writing_mb?: number;
  /** The largest `usedJSHeapSize` seen at all. */
  readonly peak_heap_mb?: number;
  readonly peak_over_file?: number;
  /**
   * How much the heap grows per thousand frames written, fitted across the run.
   *
   * THE NUMBER THIS MEASUREMENT IS ABOUT. A peak is a fact about one length; a
   * slope is a fact about every length, and it is the slope that decides
   * whether there is a ceiling at all. A path that holds the file has a slope
   * of about what the file costs, so its ceiling is the heap divided by it; a
   * path that writes the file out has a slope of nothing, and asking how long a
   * clip it can write is asking about the disk instead.
   */
  readonly heap_mb_per_1000_frames?: number | undefined;
  /**
   * How long finalizing took.
   *
   * The number that separates the two failures worth telling apart: a tab that
   * dies is one problem and a tab that swaps for four minutes and finishes is
   * another, and a path that assembles the file at the end does all of its
   * worst work here.
   */
  readonly finalize_seconds?: number;
  readonly heap_limit_mb: number;
  readonly failed_at?: string;
  readonly error?: string;
  /** Where the checkpoints had got to when it stopped, so a crash still leaves a trace. */
  readonly reached_frames?: number;
}

/**
 * Least squares through the checkpoints, in megabytes per thousand frames.
 *
 * Fitted rather than taken from the ends, because the heap is collected under
 * it: the last checkpoint before a collection is high and the first after it is
 * low, and either one on its own would answer with the noise.
 */
function heapSlope(points: readonly { frames: number; heapMb: number }[]): number | undefined {
  if (points.length < 3) return undefined;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const { frames, heapMb } of points) {
    n++;
    sx += frames;
    sy += heapMb;
    sxx += frames * frames;
    sxy += frames * heapMb;
  }
  const denominator = n * sxx - sx * sx;
  if (denominator === 0) return undefined;
  return round(((n * sxy - sx * sy) / denominator) * 1000);
}

/**
 * A sink that watches whichever one it is given.
 *
 * Wrapped rather than reimplemented: what is being measured is the sink, and a
 * copy of it here would measure this file.
 *
 * The peak is POLLED rather than sampled per frame, because the moment worth
 * catching is inside a single await: a path that assembles the file at the end
 * holds every packet, writes them all into a growing `ArrayBuffer`, and then
 * slices a second copy out of it, none of which yields to a per-frame
 * stopwatch. A hundred milliseconds is far finer than the seconds that step
 * takes and costs nothing beside a frame that is five.
 */
function watched(
  inner: FrameSink,
  onCheckpoint: (frames: number, heapUsed: number) => void,
): FrameSink & {
  peak: () => number;
  whileWriting: () => number;
  finalizeSeconds: () => number;
  stop: () => void;
} {
  let peak = 0;
  let whileWriting = 0;
  let finalizeSeconds = 0;
  let written = 0;
  const look = (): number => {
    const used = heap().used;
    if (used > peak) peak = used;
    return used;
  };
  const poll = setInterval(look, 100);

  return {
    peak: () => peak,
    whileWriting: () => whileWriting,
    finalizeSeconds: () => round(finalizeSeconds),
    stop: () => {
      clearInterval(poll);
    },
    open: (size, frames) => inner.open(size, frames),
    async accept(canvas, frame) {
      const state = await inner.accept(canvas, frame);
      written++;
      if (written % CHECKPOINT === 0) onCheckpoint(written, look());
      return state;
    },
    async finish() {
      whileWriting = look();
      const t0 = performance.now();
      const outcome = await inner.finish();
      finalizeSeconds = (performance.now() - t0) / 1000;
      look();
      return outcome;
    },
    cancel: () => inner.cancel(),
  };
}

interface Kit {
  readonly device: GPUDevice;
  readonly renderer: CompositeRenderer;
  readonly refiner: MaskRefiner;
  readonly frames: Frames;
  readonly maxTextureDimension: number;
}

/** What a rung produced, alongside the raw numbers a ratio should be taken off. */
interface RungResult {
  readonly row: Rung;
  readonly peak: number;
  readonly result?: ExportResult;
}

async function rung(kit: Kit, minutes: number, sink: FrameSink, label: string): Promise<RungResult> {
  const asked = Math.round(minutes * 60 * FPS);
  const limit = heap().limit;
  let reached = 0;
  const trace: { frames: number; heapMb: number }[] = [];
  const watcher = watched(sink, (written, used) => {
    reached = written;
    trace.push({ frames: written, heapMb: used / 1048576 });
    // Logged as well as returned. A rung that runs the tab out of memory takes
    // the return value with it, and the console is what survives that: run.mjs
    // keeps these lines and writes them out when the page stops answering.
    console.log(
      `bench: ${JSON.stringify({ measurement: 'long-clip', label, minutes, written, heap_mb: mb(used) })}`,
    );
  });

  await kit.frames.rewind();
  const t0 = performance.now();
  try {
    const result = await runExport({
      device: kit.device,
      maxTextureDimension: kit.maxTextureDimension,
      renderer: kit.renderer,
      refiner: kit.refiner,
      source: loopingSource(kit.frames, asked),
      sink: watcher,
      commands: COMMANDS,
      style: POSTER_STYLE,
      controls: defaultControls(POSTER_STYLE),
    });
    const seconds = (performance.now() - t0) / 1000;
    return {
      peak: watcher.peak(),
      result,
      row: {
        minutes,
        ok: true,
        frames: result.frames,
        asked,
        ended: result.ended,
        seconds: round(seconds),
        ms_per_frame: round((seconds * 1000) / result.frames),
        heap_while_writing_mb: mb(watcher.whileWriting()),
        peak_heap_mb: mb(watcher.peak()),
        heap_mb_per_1000_frames: heapSlope(trace),
        finalize_seconds: watcher.finalizeSeconds(),
        heap_limit_mb: mb(limit),
      },
    };
  } catch (error) {
    return {
      peak: watcher.peak(),
      row: {
        minutes,
        ok: false,
        asked,
        seconds: round((performance.now() - t0) / 1000),
        heap_while_writing_mb: mb(watcher.whileWriting()),
        peak_heap_mb: mb(watcher.peak()),
        heap_mb_per_1000_frames: heapSlope(trace),
        heap_limit_mb: mb(limit),
        failed_at: reached >= asked ? 'finalize' : 'while encoding',
        error: String(error),
        reached_frames: reached,
      },
    };
  } finally {
    watcher.stop();
  }
}

/**
 * A rung, said out loud the moment it exists.
 *
 * The ladder ends by running the tab out of memory, and a tab that dies takes
 * the return value of every rung before it as well as its own.
 */
async function loggedRung(kit: Kit, minutes: number, sink: FrameSink, label: string): Promise<RungResult> {
  const result = await rung(kit, minutes, sink, label);
  console.log(`bench: ${JSON.stringify({ measurement: 'long-clip', rung: label, ...result.row })}`);
  return result;
}

/**
 * The sink this project shipped before this chapter, which is what the ladder
 * finds the ceiling of.
 *
 * A `BufferTarget` with `fastStart` left alone, which for that target means
 * `'in-memory'`: every encoded packet is held as its own array until finalize,
 * and only then assembled into the buffer the file is made of. So the media
 * exists twice at the moment it is written out, and neither copy can be
 * released until the other exists.
 *
 * Reproduced here rather than imported because it no longer exists to import.
 * Everything else about it, the codec, the rate control and the keyframe
 * spacing, is what the product still asks for, so the only difference between
 * this row and the rows above it is where the bytes are while they are made.
 */
function heldInMemorySink(): FrameSink {
  const format = new Mp4OutputFormat();
  const target = new BufferTarget();
  const output = new Output({ format, target });
  let track: VideoSampleSource | undefined;

  return {
    async open(requested: Dimensions): Promise<Dimensions> {
      const fitted = { width: requested.width & ~1, height: requested.height & ~1 };
      const supported = format.getSupportedVideoCodecs();
      const codec = await getFirstEncodableVideoCodec(
        CODECS.filter((candidate) => supported.includes(candidate)),
        fitted,
      );
      if (!codec) throw new Error('no encodable codec');
      track = new VideoSampleSource({
        codec,
        quality: QUALITY,
        keyFrameInterval: KEYFRAME_INTERVAL_SECONDS,
      });
      output.addVideoTrack(track);
      await output.start();
      return fitted;
    },
    async accept(canvas: OffscreenCanvas, frame: ExportFrame): Promise<SinkState> {
      if (!track) throw new Error('not opened');
      const sample = new VideoSample(canvas, {
        timestamp: frame.timestampMicros / 1e6,
        duration: frame.durationMicros / 1e6,
      });
      try {
        await track.add(sample);
      } finally {
        sample.close();
      }
      return 'ready';
    },
    async finish(): Promise<Written> {
      track?.close();
      await output.finalize();
      return {
        to: 'download',
        blob: new Blob([target.buffer ?? new ArrayBuffer(0)], { type: format.mimeType }),
      };
    },
    async cancel(): Promise<void> {
      if (output.state === 'started' || output.state === 'pending') await output.cancel();
    },
  };
}

/**
 * The top-level box order and each box's size, so "the index is at the front"
 * is a fact rather than a hope.
 *
 * Read box by box out of the blob rather than out of one buffer, because the
 * box whose position this exists to establish is the one that is hundreds of
 * kilobytes on a long clip, and reading a header far enough to step over the
 * media would mean reading the media.
 */
async function boxOrder(blob: Blob): Promise<readonly { type: string; mb: number }[]> {
  const out: { type: string; mb: number }[] = [];
  let pos = 0;
  while (pos + 16 <= blob.size && out.length < 8) {
    const header = new DataView(await blob.slice(pos, pos + 16).arrayBuffer());
    let size = header.getUint32(0);
    const type = String.fromCharCode(
      header.getUint8(4),
      header.getUint8(5),
      header.getUint8(6),
      header.getUint8(7),
    );
    if (size === 1) size = Number(header.getBigUint64(8));
    if (size < 8) break;
    out.push({ type, mb: mb(size) });
    pos += size;
  }
  return out;
}

/**
 * The sizes the download path is asked to hand over, in megabytes.
 *
 * A clip export in a browser with nowhere to write ends by handing the browser
 * a blob and asking it to save it, and a blob large enough to be kept somewhere
 * other than memory can be created and then refuse to be read. That is a file
 * that never arrives and no word about why, so where it starts happening is
 * worth a number.
 */
const BLOB_SIZES_MB = [128, 256, 512, 768, 1024, 1536, 2048] as const;

/**
 * How large a blob this browser will still give a byte of back.
 *
 * One byte, because that is the question: not whether the bytes are right but
 * whether anything can read them at all, which is what a download does. Each
 * size on its own, with the buffer it was made from dropped and the heap
 * collected first, so what is being measured is one blob rather than the sum of
 * the ones before it.
 *
 * TAKEN FIRST, AND IT HAS TO BE. It is seconds where the rest of this is
 * twenty minutes, and the answer moves with how much the machine is holding, so
 * asking it after two gigabytes of exports would be asking a different
 * question.
 */
async function blobCeiling(): Promise<unknown> {
  const rows: Record<string, unknown>[] = [];
  for (const size of BLOB_SIZES_MB) {
    collect();
    await new Promise((resolve) => setTimeout(resolve, 200));
    let blob: Blob | undefined;
    try {
      const buffer = new ArrayBuffer(size * 1048576);
      // Touched rather than left untouched: an ArrayBuffer nobody writes to may
      // never be committed, and a blob made of pages that do not exist is not
      // the blob an export produces.
      const bytes = new Uint8Array(buffer);
      for (let at = 0; at < bytes.length; at += 4096) bytes[at] = 7;
      blob = new Blob([buffer]);
    } catch (error) {
      rows.push({ mb: size, made: false, read: false, error: String(error) });
      continue;
    }
    try {
      const head = new Uint8Array(await blob.slice(0, 1).arrayBuffer());
      rows.push({ mb: size, made: true, read: head[0] === 7 });
    } catch (error) {
      rows.push({ mb: size, made: true, read: false, error: String(error) });
    }
    blob = undefined;
  }
  const largest = rows.findLast((row) => row.read === true)?.mb;
  return { what: 'the largest blob a download can be handed', largest_readable_mb: largest, rows };
}

/**
 * A file handle without a save dialog.
 *
 * The origin private file system hands back the same `FileSystemFileHandle` a
 * picker does, with the same `createWritable`, and needs no gesture and no
 * dialog, which is what makes the streaming path measurable at all here and is
 * also how the end-to-end suite tests it. What it is not is the user's own
 * disk, so it answers what the path costs and not where the file ends up.
 *
 * AND IT HAS A QUOTA THE USER'S DISK DOES NOT. Measured on this machine by
 * writing sixteen megabytes at a time until it refuses: `estimate()` reports
 * three gigabytes and the write fails just past one, with or without
 * `mode: 'exclusive'`, and with durable storage granted. That is a limit of the
 * stand-in and not of the export, so the long rung writes into a stream that
 * counts and discards instead, and the rung that is read back is short enough
 * to fit.
 */
async function scratchFile(name: string): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name).catch(() => undefined);
  return root.getFileHandle(name, { create: true });
}

/**
 * A handle whose writable counts the bytes and throws them away.
 *
 * What it isolates is the export from the disk, which is the whole question at
 * a length the stand-in above cannot hold: whether what a streaming export
 * holds depends on how long the clip is. It is handed to the product's own
 * sink, so the muxer, the reserved index and the seek back at the end are all
 * the code that ships. The only thing that is not real is where the bytes land.
 *
 * No cast anywhere in it, which is the point of the sink taking a `WritableFile`
 * rather than a `FileSystemFileHandle`: what an export does with a handle is
 * open one writable stream on it, so a thing that opens one is a real
 * implementation of what it asks for rather than a pretend one.
 */
function countingHandle(): { handle: WritableFile; bytes: () => number } {
  let bytes = 0;
  return {
    bytes: () => bytes,
    handle: {
      name: 'counted.mp4',
      createWritable: (): Promise<WritableStream<FileSystemWriteChunkType>> =>
        Promise.resolve(
          new WritableStream<FileSystemWriteChunkType>({
            write(chunk) {
              // A positioned write of a view, which is the only shape the muxer
              // emits. Narrowed rather than asserted: what a writable file
              // stream accepts is a union, and most of it never arrives here.
              if (chunk instanceof Blob || typeof chunk === 'string') return;
              if (!('type' in chunk) || chunk.type !== 'write') return;
              const data = chunk.data;
              if (data === undefined || data === null || data instanceof Blob) return;
              if (typeof data === 'string') return;
              const end = (chunk.position ?? 0) + data.byteLength;
              if (end > bytes) bytes = end;
            },
          }),
        ),
    },
  };
}

/** The size a rung's file came out at, when the sink handed the bytes back. */
const sizeOf = (result: ExportResult | undefined): number =>
  result?.written.to === 'download' ? result.written.blob.size : 0;

const blobOf = (result: ExportResult | undefined): Blob | undefined =>
  result?.written.to === 'download' ? result.written.blob : undefined;

/**
 * The box order of an in-memory blob, or the reason there is not one.
 *
 * A blob large enough for the browser to keep somewhere other than memory can
 * be created and then refuse to be read, which is a finding rather than an
 * accident: it is what a download does, so a blob nobody can read is a file
 * that never arrives.
 */
async function readableBoxes(blob: Blob | undefined): Promise<Record<string, unknown>> {
  if (!blob) return { boxes: undefined };
  try {
    return { boxes: await boxOrder(blob) };
  } catch (error) {
    return { boxes: undefined, unreadable: String(error) };
  }
}

export async function longClip(device: GPUDevice, base: string): Promise<unknown> {
  const out: Record<string, unknown> = {
    what: 'how long a clip export can be, what stops it, and what a file handle changes',
    size: `${String(SIZE.width)}x${String(SIZE.height)}`,
    fps: FPS,
    style: POSTER_STYLE.id,
    heap_limit_mb: mb(heap().limit),
    storage_quota_mb: mb((await navigator.storage.estimate()).quota ?? 0),
    gc_available: collectable(),
    save_picker: 'showSaveFilePicker' in globalThis,
    writable_streams: 'createWritable' in FileSystemFileHandle.prototype,
  };

  const kit: Kit = {
    device,
    renderer: new CompositeRenderer(device),
    refiner: new MaskRefiner(device),
    frames: await Frames.fetch(`${base}/1080p30-gop30.mp4`),
    maxTextureDimension: device.limits.maxTextureDimension2D,
  };

  /**
   * One section, and its own failure if it has one.
   *
   * A measurement of what breaks under memory pressure is a measurement that
   * breaks under memory pressure, in places that are not the thing being
   * measured: reading sixteen bytes out of a gigabyte blob throws where the
   * same read at a quarter of that does not. Losing the four sections that
   * worked because the fifth did is how this measurement lost two runs.
   */
  const section = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      out[name] = await fn();
    } catch (error) {
      out[name] = { error: String(error) };
    }
    console.log(`bench: ${JSON.stringify({ measurement: 'long-clip', section: name, done: true })}`);
  };

  try {
    // --- what a download can be handed, before anything else runs ---------
    await section('handing it over', () => blobCeiling());

    // --- into a file, first, and in a clean tab ---------------------------
    //
    // ORDER IS LOAD-BEARING. The ladder at the bottom ends by running the
    // renderer out of memory, and what a path costs has to be measured in a
    // process that is not already holding four gigabytes it cannot let go of.
    // So the answers that have to be trustworthy are taken first.
    //
    // TWO RUNGS RATHER THAN ONE, and that is the stand-in's fault rather than
    // the design's. The question at the length the ladder fails at is whether
    // what a streaming export holds depends on how long the clip is, and the
    // origin private file system will not hold a file that long here. So the
    // long rung counts the bytes and discards them, and a shorter one writes a
    // real file and reads it back. Neither answers the other's question and
    // both say which one they are answering.
    const longest = LADDER_MINUTES.at(-1) ?? 25;
    await section('into a file, discarded at the writer', async () => {
      const counted = countingHandle();
      const discarded = await loggedRung(
        kit,
        longest,
        clipSink({ kind: 'file', handle: counted.handle, name: 'counted.mp4' }),
        `file ${String(longest)}m, discarded`,
      );
      return {
        ...discarded.row,
        file_mb: mb(counted.bytes()),
        peak_over_file: round(discarded.peak / Math.max(counted.bytes(), 1)),
      };
    });

    // --- into a real file, short enough for the quota, and read back -------
    await settle();
    const handle = await scratchFile('rotyl-long-clip.mp4');
    await section('into a file', async () => {
      const streamed = await loggedRung(
        kit,
        COMPARE_MINUTES,
        clipSink({ kind: 'file', handle, name: 'rotyl-long-clip.mp4' }),
        `file ${String(COMPARE_MINUTES)}m`,
      );
      const file = await handle.getFile();
      return {
        ...streamed.row,
        file_mb: mb(file.size),
        peak_over_file: round(streamed.peak / Math.max(file.size, 1)),
        boxes: await boxOrder(file),
      };
    });

    // --- and it decodes back ----------------------------------------------
    await section('decoded back', async () => {
      const file = await handle.getFile();
      const opened = await FrameProvider.open(file, device.limits.maxTextureDimension2D);
      if (!opened.ok) return { error: 'the exported clip could not be opened' };
      const provider = opened.value;
      const info = provider.info;
      const first = await provider.readFrame(0, () => undefined);
      const last = await provider.readFrame(info.timeline.frameCount - 1, () => undefined);
      provider.dispose();
      return {
        frames: info.timeline.frameCount,
        expected: Math.round(COMPARE_MINUTES * 60 * FPS),
        width: info.width,
        height: info.height,
        first_frame: first,
        last_frame: last,
        keyframes: info.timeline.keyTimestamps.length,
        seconds: round(((info.timeline.timestamps[info.timeline.frameCount - 1] ?? 0) + FRAME_MICROS) / 1e6),
      };
    });
    await navigator.storage
      .getDirectory()
      .then((root) => root.removeEntry('rotyl-long-clip.mp4'))
      .catch(() => undefined);

    // --- the same clip, in memory, at the same settings --------------------
    await settle();
    await section('in memory', async () => {
      const memory = await loggedRung(
        kit,
        COMPARE_MINUTES,
        clipSink({ kind: 'download' }),
        `memory ${String(COMPARE_MINUTES)}m`,
      );
      return {
        ...memory.row,
        file_mb: mb(sizeOf(memory.result)),
        peak_over_file: round(memory.peak / Math.max(sizeOf(memory.result), 1)),
        ...(await readableBoxes(blobOf(memory.result))),
      };
    });

    // --- and what it does when it runs out of room ------------------------
    await settle();
    await section('in memory, past the budget', async () => {
      const budgeted = await loggedRung(
        kit,
        PAST_THE_BUDGET_MINUTES,
        clipSink({ kind: 'download' }),
        `memory ${String(PAST_THE_BUDGET_MINUTES)}m, past the budget`,
      );
      return {
        ...budgeted.row,
        file_mb: mb(sizeOf(budgeted.result)),
        peak_over_file: round(budgeted.peak / Math.max(sizeOf(budgeted.result), 1)),
        minutes_written: round((budgeted.row.frames ?? 0) / (FPS * 60)),
        ...(await readableBoxes(blobOf(budgeted.result))),
      };
    });

    // --- the ladder, on the sink that shipped before this, last -----------
    await section('held in memory, the ladder', async () => {
      const ladder: Rung[] = [];
      for (const minutes of LADDER_MINUTES) {
        await settle();
        const { row, result, peak } = await loggedRung(
          kit,
          minutes,
          heldInMemorySink(),
          `held ${String(minutes)}m`,
        );
        const bytes = sizeOf(result);
        ladder.push({
          ...row,
          ...(bytes > 0 ? { file_mb: mb(bytes), peak_over_file: round(peak / bytes) } : {}),
        });
        if (!row.ok) break;
      }
      return ladder;
    });

    return out;
  } finally {
    kit.frames.dispose();
    kit.renderer.dispose();
    kit.refiner.dispose();
  }
}
