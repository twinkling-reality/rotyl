import { ExportRenderer, exportDimensions } from '../../core/render/export-renderer.ts';
import {
  OUTPUT_FORMAT,
  OUTPUT_VIEW_FORMAT,
  SOURCE_FORMAT,
  SOURCE_VIEW_FORMAT,
} from '../../core/gpu/formats.ts';
import { stillSink } from './still-sink.ts';
import type { Destination } from './destination.ts';
import type { Dimensions } from '../../core/render/resolution.ts';
import type { SelectionCommand } from '../../core/document/selection-command.ts';
import type { StyleControls, StyleDefinition } from '../../core/style/style.ts';
import type { CompositeRenderer } from '../../core/render/composite-renderer.ts';
import type { MaskRefiner } from '../../core/mask/mask-refiner.ts';
// Type-only, so nothing here pulls in a container library. A demuxed packet is
// the currency between the source and the sink, and copying one into a shape of
// this project's own would be the single thing capable of stopping the sound in
// a written clip being the sound that was read.
import type { AudioCodec, EncodedPacket } from 'mediabunny';

/**
 * Writing the work out.
 *
 * ONE LOOP. A source hands over frames, the renderer composites each one, and a
 * sink takes them. A photograph is a one-frame document and goes through the
 * same loop once, which is the same rule the command log is built on: nothing
 * below asks which kind of file this is, only how many frames it has and where
 * they are going.
 *
 * The two seams are `ExportSource` and `FrameSink`, and everything that varies
 * lives behind one of them. A second container is an entry in the table at the
 * bottom of this file; a second codec is an entry in the one in `clip-sink.ts`.
 *
 * AND SOUND IS NOT MORE FRAMES. A soundtrack is a second stream whose packets
 * do not land on frame boundaries and are not the same number as the frames, so
 * it gets a cursor of its own on the source and a second method on the sink
 * rather than being folded into `ExportFrame`. What it does NOT get is a loop
 * of its own. Measured (`node tools/video-bench/run.mjs interleave`), a file
 * whose video is one contiguous run and whose audio is another puts the sound
 * of a given second a median of half the file away from its picture, growing
 * with the length of the clip, which is not a progressive file whatever order
 * the boxes are in. Worse, it is usually not a file at all: with the index
 * reserved at the front, the muxer cannot size the movie box until it has seen
 * a packet from every track, so a run of video with the audio behind it fails
 * before a byte is written. Interleaved, the same distance is a constant of
 * about two megabytes at every length measured.
 */

/** One frame of the document, as the thing being written needs to see it. */
export interface ExportFrame {
  /** Index into the document, which is what a command's `frame` refers to. */
  readonly index: number;
  /**
   * Presentation time in microseconds, taken from the container's own index.
   *
   * Never derived by multiplying an index by a frame rate: a variable frame
   * rate, or the two-frame offset an edit list introduces, would put a frame at
   * a time it is not at. A photograph is at zero, and nothing reads it.
   */
  readonly timestampMicros: number;
  readonly durationMicros: number;
}

/**
 * The soundtrack, copied across rather than decoded.
 *
 * A CURSOR, NOT A LIST. The loop below asks on every frame whether the sound is
 * behind, and hands over whatever is due; nothing holds more than one packet at
 * a time, which is what keeps a twenty minute export holding nothing.
 *
 * `packetCount` has to be answered before the first frame is rendered, because
 * the movie box is reserved at the front of the file and cannot be sized
 * without a maximum for every track. That is a walk of the whole audio track's
 * sample tables up front, measured at about a microsecond a packet, which is
 * 50 ms on twenty minutes of 48 kHz audio. It is paid once and before anything
 * slow, which is the same rule the destination follows.
 */
export interface ExportAudio {
  readonly codec: AudioCodec;
  readonly config: AudioDecoderConfig;
  /** The most packets this will hand over. Fewer arrive if the export stops early. */
  readonly packetCount: number;
  /**
   * The next packet, if it is due at or before `dueMicros`, in the export's own
   * timeline. `Infinity` takes whatever is next regardless.
   */
  next(dueMicros: number): Promise<EncodedPacket | undefined>;
}

/**
 * Where the full-resolution pixels come from.
 *
 * Export does not re-read the preview texture, which may have been capped for
 * memory. It goes back to the original. What "the original" is differs between
 * a photograph, one frame of a video and a whole clip, and this is the whole of
 * that difference: everything after it is one path.
 */
export interface ExportSource {
  readonly width: number;
  readonly height: number;
  /** The frames to write, in order. A photograph has one. */
  readonly frames: readonly ExportFrame[];
  /**
   * The sound that goes under them, where there is any and the file can hold
   * it. Absent for a photograph, for a clip with no audio track, and for one
   * whose audio the container being written cannot carry, which is a decision
   * taken before the picker is even shown.
   */
  readonly audio?: ExportAudio;
  /** Fill a texture of exactly these dimensions with `frame`. */
  fill(device: GPUDevice, texture: GPUTexture, frame: ExportFrame): Promise<void>;
  /** Always called, including when the render fails. */
  release(): void;
}

/**
 * Where rendered frames go.
 *
 * A sink is handed the canvas rather than pixels, because both of them want it:
 * a still encodes straight out of GPU memory with `convertToBlob`, and a clip
 * builds a `VideoFrame` from the same surface. Measured, on this machine:
 * capturing the canvas costs nothing detectable, where copying the composite
 * into a buffer and rebuilding a frame from it costs a millisecond a frame at
 * 1080p and needs every row de-padded to undo the 256-byte alignment WebGPU
 * imposes on texture-to-buffer copies.
 */
export interface FrameSink {
  /**
   * Called once, before any frame, with the size the renderer would like to
   * work at and how many frames are coming. Returns the size it will actually
   * be given, so a sink with a constraint of its own can state it rather than
   * failing on the first frame.
   *
   * The count is here because a sink that puts its index at the FRONT of the
   * file has to leave room for it before writing any media, and how much room
   * is a function of how many frames there will be. A photograph's sink ignores
   * it, as it ignores everything about being one of many.
   */
  open(size: Dimensions, frames: number, audio?: ExportAudio): Promise<Dimensions>;
  /**
   * Take one frame, and say whether there is room for another.
   *
   * `full` is not an error and does not mean the frame was refused: it means
   * this one landed and the next one will not. Only a sink building the file in
   * memory ever says it, and what happens then is what happens when the user
   * presses Stop, because it is the same situation: the export ends where it
   * got to and the caller is handed what was written.
   */
  accept(canvas: OffscreenCanvas, frame: ExportFrame): Promise<SinkState>;
  /**
   * Take one soundtrack packet, written where it falls between the frames.
   *
   * Absent on a sink that cannot hold sound, which is how a photograph's sink
   * says so: the loop only reads the source's audio when this is here, so a
   * still is never handed a packet it would have to ignore.
   */
  acceptAudio?(packet: EncodedPacket): Promise<void>;
  finish(): Promise<Written>;
  /** Release everything. Called instead of `finish` when an export is abandoned. */
  cancel(): Promise<void>;
}

export type SinkState = 'ready' | 'full';

/**
 * Where a finished export ended up.
 *
 * A sink either hands back bytes for the caller to save, or has already put
 * them somewhere. That difference is the whole of what a file handle changes,
 * and stating it here rather than returning an empty blob is what keeps the
 * caller from having to guess.
 */
export type Written =
  { readonly to: 'download'; readonly blob: Blob } | { readonly to: 'file'; readonly name: string };

export interface ExportRequest {
  readonly device: GPUDevice;
  readonly maxTextureDimension: number;
  /** Borrowed from the engine so export does not duplicate the pipeline set. */
  readonly renderer: CompositeRenderer;
  readonly refiner: MaskRefiner;
  readonly source: ExportSource;
  readonly sink: FrameSink;
  /**
   * The whole log, not one frame's.
   *
   * Which commands are in effect on a frame is a question core answers, and an
   * export that filtered for itself could answer it differently from the
   * preview the user was looking at.
   */
  readonly commands: readonly SelectionCommand[];
  readonly style: StyleDefinition;
  readonly controls: StyleControls;
  /**
   * A hosted illustrated still, when one is showing.
   *
   * Stills only. A clip export must not pass this: the layer is one frame of
   * one photograph, and drawing it on every frame of a clip would be faking
   * a video treatment that does not exist.
   */
  readonly illustrated?: GPUTexture;
  /** Called after each frame, so a long export can say how far along it is. */
  readonly onProgress?: (written: number, total: number) => void;
  readonly signal?: AbortSignal;
}

export interface ExportResult {
  readonly written: Written;
  readonly width: number;
  readonly height: number;
  /** How many frames are in the file. */
  readonly frames: number;
  /** How many were asked for, which is more than `frames` unless it ran to the end. */
  readonly total: number;
  readonly ended: ExportEnding;
}

/**
 * How an export finished, which is three things rather than two.
 *
 * `stopped` and `full` both leave a shorter file than was asked for and are
 * otherwise identical, and telling them apart is the caller's whole job
 * afterwards: one of them is a button the user pressed and needs no
 * explanation, and the other is a limit of the browser they are in and needs
 * one.
 */
export type ExportEnding = 'complete' | 'stopped' | 'full';

/**
 * Thrown when an export was stopped before a single frame was written.
 *
 * The one case where stopping keeps nothing, because there is nothing to keep.
 * Past the first frame a stop finishes the file at what it reached, for the
 * reason a stopped tracking run keeps what it found: the work is worth what it
 * would have been if the clip had ended there.
 */
export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'ExportCancelled';
  }
}

/**
 * Render every frame of the source and write it into the sink.
 *
 * The source is read again from the original rather than reusing the preview
 * texture, which may have been capped for memory. Everything else, the style
 * chain, the parameters, the composite, is the same code the preview ran, so
 * this cannot drift from what the user was looking at.
 */
export async function runExport(request: ExportRequest): Promise<ExportResult> {
  const { device, maxTextureDimension, renderer, refiner, source, sink, commands } = request;
  const { style, controls, onProgress, signal } = request;
  const { width, height } = source;

  // Everything from here is inside the try: a full-resolution source texture is
  // hundreds of megabytes, and every step below can fail.
  let sourceTexture: GPUTexture | undefined;
  let exporter: ExportRenderer | undefined;
  let finished = false;
  try {
    sourceTexture = device.createTexture({
      label: 'export-source',
      size: { width, height },
      format: SOURCE_FORMAT,
      viewFormats: [SOURCE_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Only where the sink can take it. A still's sink has no `acceptAudio`, so
    // it is never told there is sound and never has to ignore any.
    const audio = sink.acceptAudio ? source.audio : undefined;
    const outputSize = await sink.open(
      exportDimensions({ width, height }, maxTextureDimension),
      source.frames.length,
      audio,
    );
    const canvas = new OffscreenCanvas(outputSize.width, outputSize.height);
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not create a rendering context for export.');
    context.configure({
      device,
      format: OUTPUT_FORMAT,
      viewFormats: [OUTPUT_VIEW_FORMAT],
      // Matches the preview canvas, so the exported file is the image that was
      // on screen. Source transparency is flattened in both.
      alphaMode: 'opaque',
    });

    exporter = new ExportRenderer({
      device,
      renderer,
      refiner,
      sourceTexture,
      sourceSize: { width, height },
      outputSize,
    });

    /**
     * Everything the soundtrack owes by `dueMicros`, and never more than `limit`.
     *
     * ONE LOOP, WITH A SECOND CURSOR IN IT. This is called from inside the frame
     * loop rather than before or after it, and that is the measurement rather
     * than a preference: audio added in one run after the video puts the sound
     * of a given second half a file away from its picture and grows with the
     * clip, and audio added in one run BEFORE the video does the same in
     * reverse. Interleaved it is a constant two megabytes at every length
     * measured. See `node tools/video-bench/run.mjs interleave`.
     */
    const pushAudio = async (dueMicros: number, limit = Infinity): Promise<void> => {
      if (!audio) return;
      for (let taken = 0; taken < limit; taken++) {
        const packet = await audio.next(dueMicros);
        if (!packet) return;
        // Always taken: `audio` is only set where the sink has this method.
        await sink.acceptAudio?.(packet);
      }
    };

    // ONE PACKET BEFORE THE FIRST FRAME, whether or not it is due yet. The
    // movie box is reserved at the front of the file, and the muxer cannot size
    // it until it has seen a packet from every track it was told about, so
    // until this lands nothing can be written at all and every rendered frame
    // waits in memory. Measured: on a clip whose video carries B-frames the
    // whole export fails rather than merely stalling.
    await pushAudio(Infinity, 1);

    const total = source.frames.length;
    let written = 0;
    /**
     * How this ended, which decides nothing here and everything afterwards.
     *
     * STOPPING KEEPS WHAT WAS WRITTEN. It used to abandon, which was right
     * while the file existed only in memory: nothing had been promised and
     * nothing was lost. It is not right once the bytes are on the user's disk
     * in a file they named, where abandoning leaves an empty file where they
     * asked for a video. It is the rule a stopped tracking run already follows,
     * for the same reason: a run cut short did the work up to where it got to,
     * and that work is worth what it would have been had the clip ended there.
     */
    let ended: ExportEnding = 'complete';
    /** The last frame that landed, which is what the sound has to stop with. */
    let lastFrame: ExportFrame | undefined;
    for (const frame of source.frames) {
      if (signal?.aborted) {
        ended = 'stopped';
        break;
      }
      // The sound that is already due, before the picture it plays under.
      await pushAudio(frame.timestampMicros);
      await source.fill(device, sourceTexture, frame);

      // Validation errors in WebGPU are asynchronous: createTexture returns an
      // object and reports the failure later, so a failed allocation would
      // otherwise be discovered as a silently blank download. Scoped per frame
      // rather than per export because the pop resolves against work the render
      // has already fenced on, so it costs nothing and a clip that fails on
      // frame five hundred says so at frame five hundred.
      device.pushErrorScope('out-of-memory');
      device.pushErrorScope('validation');
      await exporter.render(
        context.getCurrentTexture(),
        commands,
        frame.index,
        style,
        controls,
        request.illustrated,
      );
      const validationError = await device.popErrorScope();
      const memoryError = await device.popErrorScope();
      if (memoryError) throw new Error('Not enough graphics memory to export this at full size.');
      if (validationError) throw new Error(`Export failed while rendering: ${validationError.message}`);

      const state = await sink.accept(canvas, frame);
      written++;
      lastFrame = frame;
      onProgress?.(written, total);
      // The frame landed; it is the next one there is no room for. Handled the
      // same way a stop is because it IS the same situation, and the only thing
      // that differs is what the caller says about it afterwards.
      if (state === 'full') {
        ended = 'full';
        break;
      }
    }

    // The one case where stopping keeps nothing. Finalizing zero frames would
    // write a container with an empty track, which is a file that opens and
    // shows nothing, and that is worse than the download that never happened.
    if (written === 0 || !lastFrame) throw new ExportCancelled();

    // The sound under the last frame, and not a moment more. Draining to the
    // end of the SOURCE here would give an export that stopped four minutes
    // into a fourteen minute clip a fourteen minute soundtrack over a four
    // minute picture, which is the one way a stop could produce a file worse
    // than the part that was rendered.
    await pushAudio(lastFrame.timestampMicros + lastFrame.durationMicros);

    const outcome = await sink.finish();
    finished = true;
    return {
      written: outcome,
      width: outputSize.width,
      height: outputSize.height,
      frames: written,
      total,
      ended,
    };
  } finally {
    if (!finished) await sink.cancel();
    source.release();
    exporter?.dispose();
    sourceTexture?.destroy();
  }
}

/**
 * The audio codecs an MP4 can carry, written out rather than asked for.
 *
 * ASKING WOULD COST 42.8 KB TO EVERY VIDEO SESSION. The container writer knows
 * this list and is behind a dynamic import that only a clip export fetches, and
 * the question "will this file's sound survive" has to be answered while a
 * video is merely open, so that it can be said BEFORE the work rather than
 * discovered after it. Importing the writer to ask would put the whole muxer in
 * the chunk that opens a video, which measurement 6 costed at the size of the
 * entire application bundle.
 *
 * A COPIED LIST CAN DRIFT, so it is not left to be noticed: a unit test asserts
 * this against `Mp4OutputFormat.getSupportedAudioCodecs()`, and a library
 * upgrade that changes it fails the suite rather than silently telling somebody
 * their soundtrack cannot be written when it can.
 */
const MP4_AUDIO = [
  'aac',
  'opus',
  'mp3',
  'vorbis',
  'flac',
  'ac3',
  'eac3',
  'dts',
  'pcm-s16',
  'pcm-s16be',
  'pcm-s24',
  'pcm-s24be',
  'pcm-s32',
  'pcm-s32be',
  'pcm-f32',
  'pcm-f32be',
  'pcm-f64',
  'pcm-f64be',
] as const;

/**
 * The formats this can write, and how to reach the code that writes them.
 *
 * A SECOND CONTAINER IS AN ENTRY HERE. The clip writer is behind a dynamic
 * import because it is 42.8 KB gzipped on top of the demuxer, measured through
 * this project's own build, which is the size of the entire application bundle.
 * Someone who opens a photograph never fetches it, the same treatment the
 * inference runtime and the demuxer get and for the same reason.
 */
const FORMATS = {
  png: { extension: 'png', audio: [], open: () => Promise.resolve(stillSink('image/png')) },
  jpeg: { extension: 'jpg', audio: [], open: () => Promise.resolve(stillSink('image/jpeg')) },
  mp4: {
    extension: 'mp4',
    audio: MP4_AUDIO,
    open: async (destination: Destination): Promise<FrameSink> =>
      (await import('./clip-sink.ts')).clipSink(destination),
  },
} as const;

export type ExportFormat = keyof typeof FORMATS;

/**
 * A sink for this format, writing to this destination.
 *
 * A picture ignores the destination and hands back a blob: it is a megabyte or
 * two of a file that has already been decoded once at that size, so where it
 * goes is a question with no consequences. A clip is the one that has to be
 * told, and it has to be told before it starts.
 */
export function openSink(format: ExportFormat, destination: Destination): Promise<FrameSink> {
  return FORMATS[format].open(destination);
}

/**
 * Whether a soundtrack in this codec survives being written into this format.
 *
 * Answered from the track and the format alone, with nothing decoded and
 * nothing encoded, which is what lets the interface say it while the file is
 * merely open. Measured at nothing at all: it is a list lookup.
 */
export function carriesAudio(format: ExportFormat, codec: string): boolean {
  return (FORMATS[format].audio as readonly string[]).includes(codec);
}

/** The codecs this project claims an MP4 holds, so a test can check the claim. */
export const MP4_AUDIO_CODECS: readonly string[] = MP4_AUDIO;

/**
 * Filename for an export, derived from the original.
 *
 * A frame number when one frame of a clip is being written, because exporting
 * three frames of the same clip would otherwise write the same name three
 * times. A whole clip is the document and takes the document's name.
 */
export function exportFilename(originalName: string, format: ExportFormat, frame?: number): string {
  const stem = originalName.replace(/\.[^.]+$/, '') || 'image';
  const at = frame === undefined ? '' : `-f${String(frame + 1).padStart(5, '0')}`;
  return `${stem}-rotyl${at}.${FORMATS[format].extension}`;
}
