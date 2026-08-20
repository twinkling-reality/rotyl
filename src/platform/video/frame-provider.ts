import {
  BlobSource,
  EncodedPacketSink,
  Input,
  MP4,
  QTFF,
  type AudioCodec,
  type EncodedPacket,
  type InputAudioTrack,
} from 'mediabunny';
import { looksLikeVideo, type VideoLoadError } from './video-file.ts';

/**
 * Frames out of a video file, one at a time, on demand.
 *
 * THERE IS NO SUCH THING AS DECODING FRAME N. There is decoding from the
 * keyframe at or before N and discarding what comes between, so the cost of
 * asking for a frame is set by keyframe spacing and by nothing else. Measured
 * on 1080p30 (tools/video-bench): decoding the next frame costs 0.47 ms, and
 * seeking costs 15 ms on a clip with one-second keyframes and 88 ms on the same
 * content with one keyframe in it.
 *
 * That single fact is the whole design. A scrub that moves forward must never
 * re-seek, so this holds one decoder open and feeds it, and re-seeks only when
 * the target is behind the playhead or when a keyframe lies between the two.
 * the second case being exactly when starting again is cheaper than continuing.
 *
 * TWO WEBCODECS RULES THAT BITE SILENTLY, both handled here so that no caller
 * has to know them:
 *
 *   A VideoFrame that is not closed holds part of the decoder's frame pool.
 *   Leak enough of them and `decode` stops producing output, with no error and
 *   no way to tell it from a slow file. So frames are never handed out: a
 *   caller is given one inside a callback and it is closed on the way out.
 *
 *   `flush()` resets the decoder's "next chunk must be a keyframe" state. It is
 *   therefore only used to drain the end of the file, and doing so forces the
 *   next request to seek.
 */

/** A decoded frame, for as long as the callback runs and not one moment longer. */
export type UseFrame = (frame: VideoFrame) => void;

export interface VideoTimeline {
  /**
   * Presentation time of every frame in microseconds, ascending.
   *
   * Built by walking the container's index, not by assuming a constant frame
   * rate: a frame's identity has to be exact, because it is what a per-frame
   * edit will eventually be keyed on. Variable frame rate and B-frame
   * reordering are both handled by this being a sorted list of what is actually
   * in the file.
   */
  readonly timestamps: Float64Array;
  /** Presentation time of each keyframe, ascending. Decides seek cost. */
  readonly keyTimestamps: Float64Array;
  readonly frameCount: number;
  readonly durationSeconds: number;
  /** Frames divided by duration. For display; nothing here depends on it. */
  readonly frameRate: number;
}

/**
 * The file's soundtrack, as much of it as an export needs to know.
 *
 * PACKETS AND NOT SAMPLES. A clip export copies the encoded packets across
 * rather than decoding and re-encoding them, so what it needs is the codec, the
 * config a decoder would want, and nothing else. There is no `AudioDecoder`
 * anywhere in this product and this does not add one.
 *
 * Absent when the file has no audio track, and absent as well when it has one
 * this demuxer cannot describe: a track whose codec or decoder config comes
 * back null is one nothing downstream could do anything with, and reporting it
 * as present would push that discovery into the middle of an export.
 */
export interface Soundtrack {
  readonly codec: AudioCodec;
  readonly config: AudioDecoderConfig;
  readonly sampleRate: number;
  readonly channels: number;
}

export interface VideoInfo {
  readonly width: number;
  readonly height: number;
  readonly codec: string;
  readonly timeline: VideoTimeline;
  readonly audio: Soundtrack | undefined;
}

export type VideoOpenResult =
  | { readonly ok: true; readonly value: FrameProvider }
  | { readonly ok: false; readonly error: VideoLoadError };

/**
 * How many chunks may be in flight before we wait.
 *
 * Without a limit a seek across a long group of pictures hands the decoder
 * every packet at once, and the queue becomes the thing being measured. Eight
 * is enough to keep a hardware decoder fed across the reordering delay of a
 * three-B-frame stream.
 */
const DECODE_QUEUE_LIMIT = 8;

const NOTHING = (): void => undefined;

export class FrameProvider {
  readonly info: VideoInfo;

  readonly #input: Input;
  readonly #sink: EncodedPacketSink;
  readonly #config: VideoDecoderConfig;
  /**
   * The soundtrack's packets, if there are any.
   *
   * A SECOND CURSOR OVER THE SAME FILE, and deliberately not a second decoder.
   * Two readers of one video track would cancel each other's seeks, which is
   * why a tracking run opens a provider of its own; a packet sink on a
   * different track shares nothing with the video decoder but the byte source
   * underneath, which is what a byte source is for.
   */
  readonly #audio: EncodedPacketSink | undefined;

  #decoder: VideoDecoder | undefined;
  /** The next packet to submit, in decode order. */
  #cursor: EncodedPacket | undefined;
  /** Decoded and not yet consumed, in presentation order. */
  #ready: VideoFrame[] = [];
  /** Presentation time of the last frame taken off the queue. */
  #playhead = Number.NEGATIVE_INFINITY;
  /** Set after a flush or an error, when continuing is no longer valid. */
  #mustSeek = true;
  #failure: Error | undefined;

  /** Requests are serialised, and a newer one abandons whatever is in flight. */
  #sequence = 0;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;

  private constructor(
    input: Input,
    sink: EncodedPacketSink,
    config: VideoDecoderConfig,
    info: VideoInfo,
    audio: EncodedPacketSink | undefined,
  ) {
    this.#input = input;
    this.#sink = sink;
    this.#config = config;
    this.info = info;
    this.#audio = audio;
  }

  static async open(file: Blob, maxDimension: number): Promise<VideoOpenResult> {
    const format = await looksLikeVideo(file);
    if (format !== 'mp4' && format !== 'quicktime') {
      return { ok: false, error: { kind: 'unsupported-format', format } };
    }

    // Both formats, always: a QuickTime file is an ISO base media file with a
    // different brand, so the second one is the same demuxer and costs nothing.
    const input = new Input({ formats: [MP4, QTFF], source: new BlobSource(file) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) {
        input.dispose();
        return { ok: false, error: { kind: 'no-video-track' } };
      }

      const config = await track.getDecoderConfig();
      const codec = (await track.getCodec()) ?? 'unknown';
      if (!config) {
        input.dispose();
        return { ok: false, error: { kind: 'unsupported-codec', codec } };
      }

      const width = track.displayWidth;
      const height = track.displayHeight;
      if (width > maxDimension || height > maxDimension) {
        input.dispose();
        return { ok: false, error: { kind: 'too-large', width, height, limit: maxDimension } };
      }

      // Asked rather than assumed, and asked before anything is decoded: an
      // H.265 clip in an MP4 is a perfectly ordinary file that some browsers
      // decode and others do not, and finding out at the first frame would mean
      // failing after the image had already been replaced.
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) {
        input.dispose();
        return { ok: false, error: { kind: 'unsupported-codec', codec } };
      }

      const sink = new EncodedPacketSink(track);
      const timeline = await buildTimeline(sink);
      if (timeline.frameCount === 0) {
        input.dispose();
        return { ok: false, error: { kind: 'no-video-track' } };
      }

      // Asked for once, here, so that everything downstream can be told about
      // the soundtrack before any work starts rather than discovering it part
      // way through an export. A file with no audio costs one null track.
      const soundtrack = await describeAudio(input);

      return {
        ok: true,
        value: new FrameProvider(
          input,
          sink,
          config,
          { width, height, codec, timeline, audio: soundtrack?.info },
          soundtrack?.sink,
        ),
      };
    } catch {
      input.dispose();
      return { ok: false, error: { kind: 'unreadable' } };
    }
  }

  /**
   * Show frame `index`.
   *
   * Returns false when the request was superseded by a later one, which is the
   * normal case while scrubbing and not an error: a pointer that has moved on
   * has already asked for somewhere else. The frame is closed as this returns,
   * so `use` must do its work synchronously. Uploading it to a texture is a
   * queue operation and qualifies.
   */
  async readFrame(index: number, use: UseFrame): Promise<boolean> {
    const target = this.info.timeline.timestamps[index];
    if (target === undefined || this.#disposed) return false;

    const sequence = ++this.#sequence;
    const previous = this.#queue;
    // One request at a time: two of them driving the same decoder would
    // interleave packets from two seeks. A newer one still supersedes the old
    // through #sequence, which the older one checks as it goes.
    let admit = NOTHING;
    this.#queue = new Promise<void>((resolve) => {
      admit = resolve;
    });
    await previous;

    try {
      if (this.#disposed || sequence !== this.#sequence) return false;
      if (this.#needsSeek(target)) await this.#seek(target);
      if (this.#disposed || sequence !== this.#sequence) return false;

      const frame = await this.#advanceTo(target, sequence);
      if (!frame) return false;
      try {
        use(frame);
      } finally {
        frame.close();
      }
      return true;
    } finally {
      admit();
    }
  }

  /**
   * How many soundtrack packets start inside this span, counted and not read.
   *
   * A packet count has to be known before the first frame is rendered, because
   * the movie box is reserved at the front of the file and cannot be sized
   * without one. `metadataOnly` reads the sample tables and none of the
   * payload: measured, about a microsecond a packet, which is 50 ms on the
   * twenty minutes of audio the last chapter's export ladder reached.
   */
  async countAudioPackets(fromMicros: number, toMicros: number): Promise<number> {
    let count = 0;
    for await (const _ of this.#walkAudio(fromMicros, toMicros, true)) count++;
    return count;
  }

  /**
   * The soundtrack's packets, in order, with their bytes.
   *
   * Handed over exactly as they were read. Nothing decodes them, nothing
   * re-encodes them, and the only thing an export changes about one is the
   * timestamp it is written at, which is what makes the sound in a written clip
   * bit-identical to the sound in the file it came from.
   */
  audioPackets(fromMicros: number, toMicros: number): AsyncGenerator<EncodedPacket, void, unknown> {
    return this.#walkAudio(fromMicros, toMicros, false);
  }

  /**
   * Packets whose presentation STARTS inside the span.
   *
   * A packet straddling the in point is dropped rather than kept, and that is
   * the decision rather than an oversight. Audio does not cut where video does:
   * the packet holding the in point began before it, so keeping it means either
   * a negative timestamp the container has no room for or the whole track
   * shifted early by up to one packet. Dropping it costs at most one packet of
   * sound at the head, 21 ms at 48 kHz and less than a frame, and it leaves
   * every remaining packet at exactly the moment it was at in the source.
   */
  async *#walkAudio(
    fromMicros: number,
    toMicros: number,
    metadataOnly: boolean,
  ): AsyncGenerator<EncodedPacket, void, unknown> {
    const sink = this.#audio;
    if (!sink) return;
    const from = fromMicros / 1e6;
    const to = toMicros / 1e6;
    // Located in the same mode as the walk, which is not an accident: a
    // metadata-only packet is refused as a starting point for a walk that wants
    // bytes. The seek itself is an index lookup either way, so locating a range
    // that begins ten minutes in reads one packet rather than ten minutes.
    const at = await sink.getPacket(from, { metadataOnly });
    const start = at ?? (await sink.getFirstPacket({ metadataOnly }));
    for await (const packet of sink.packets(start ?? undefined, undefined, { metadataOnly })) {
      if (packet.timestamp < from) continue;
      if (packet.timestamp >= to) return;
      yield packet;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sequence++;
    this.#discard();
    this.#closeDecoder();
    this.#input.dispose();
  }

  #needsSeek(target: number): boolean {
    if (this.#mustSeek || !this.#decoder || this.#decoder.state !== 'configured') return true;
    if (target <= this.#playhead) return true;
    // A keyframe between the playhead and the target means starting again there
    // decodes strictly fewer frames than continuing from here.
    const keys = this.info.timeline.keyTimestamps;
    for (const key of keys) {
      if (key > this.#playhead && key <= target) return true;
      if (key > target) break;
    }
    return false;
  }

  async #seek(target: number): Promise<void> {
    this.#discard();
    // Reset rather than replace: the decoder object survives, and with it
    // whatever the browser has already set up for this stream.
    if (this.#decoder && this.#decoder.state !== 'closed') this.#decoder.reset();
    else this.#openDecoder();
    this.#decoder?.configure({ ...this.#config, optimizeForLatency: true });

    const key = await this.#sink.getKeyPacket(target / 1e6);
    this.#cursor = key ?? undefined;
    this.#playhead = Number.NEGATIVE_INFINITY;
    this.#mustSeek = false;
    this.#failure = undefined;
  }

  /**
   * Feed packets until a frame at or after `target` comes out.
   *
   * The loop consumes before it feeds, because a decoder holding a reordering
   * delay emits nothing for the first few chunks and then several at once. Each
   * pass yields at the `getNextPacket` await, which is what lets the output
   * callback run at all.
   */
  async #advanceTo(target: number, sequence: number): Promise<VideoFrame | undefined> {
    for (;;) {
      if (this.#disposed || sequence !== this.#sequence) return undefined;
      if (this.#failure) {
        const failure = this.#failure;
        this.#failure = undefined;
        this.#mustSeek = true;
        throw failure;
      }

      while (this.#ready.length > 0) {
        const frame = this.#ready.shift();
        if (!frame) break;
        this.#playhead = frame.timestamp;
        if (frame.timestamp >= target) return frame;
        frame.close();
      }

      const decoder = this.#decoder;
      if (!decoder || decoder.state !== 'configured') return undefined;

      const packet = this.#cursor;
      if (!packet) {
        // Out of packets, so anything still inside the decoder has to be
        // pushed out. This is the one flush, and it costs the ability to
        // continue: the next request seeks.
        await decoder.flush();
        this.#mustSeek = true;
        if (this.#ready.length === 0) return undefined;
        continue;
      }

      decoder.decode(packet.toEncodedVideoChunk());
      this.#cursor = (await this.#sink.getNextPacket(packet)) ?? undefined;
      if (decoder.decodeQueueSize > DECODE_QUEUE_LIMIT) await this.#waitForQueue(decoder);
    }
  }

  #openDecoder(): void {
    this.#decoder = new VideoDecoder({
      output: (frame) => {
        if (this.#disposed) {
          frame.close();
          return;
        }
        this.#ready.push(frame);
      },
      error: (error) => {
        this.#failure = error;
      },
    });
  }

  async #waitForQueue(decoder: VideoDecoder): Promise<void> {
    await new Promise<void>((resolve) => {
      const onDequeue = (): void => {
        if (decoder.decodeQueueSize > DECODE_QUEUE_LIMIT / 2) return;
        decoder.removeEventListener('dequeue', onDequeue);
        resolve();
      };
      decoder.addEventListener('dequeue', onDequeue);
    });
  }

  #discard(): void {
    for (const frame of this.#ready) frame.close();
    this.#ready = [];
    this.#cursor = undefined;
  }

  #closeDecoder(): void {
    if (this.#decoder && this.#decoder.state !== 'closed') this.#decoder.close();
    this.#decoder = undefined;
  }
}

/**
 * What the file's soundtrack is, or nothing at all.
 *
 * Three ways of having no usable audio are one answer here: no audio track, a
 * codec this demuxer does not recognise, and a track with no decoder config.
 * The last two are files that exist, and a product that reported them as
 * "there is sound" would go looking for it in the middle of an export.
 */
async function describeAudio(
  input: Input,
): Promise<{ info: Soundtrack; sink: EncodedPacketSink } | undefined> {
  const track: InputAudioTrack | null = await input.getPrimaryAudioTrack();
  if (!track) return undefined;
  const codec = await track.getCodec();
  const config = await track.getDecoderConfig();
  if (!codec || !config) return undefined;
  return {
    info: {
      codec,
      config,
      sampleRate: await track.getSampleRate(),
      channels: await track.getNumberOfChannels(),
    },
    sink: new EncodedPacketSink(track),
  };
}

/**
 * Walk the container's index and record where every frame is.
 *
 * `metadataOnly` reads the sample tables without any of the payload, so this is
 * a millisecond or two even on a long file. Timestamps are sorted because
 * packets arrive in DECODE order and a frame's index is its position in
 * PRESENTATION order, which is what a person scrubbing a timeline means.
 */
async function buildTimeline(sink: EncodedPacketSink): Promise<VideoTimeline> {
  const timestamps: number[] = [];
  const keyTimestamps: number[] = [];
  let end = 0;

  for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
    timestamps.push(packet.microsecondTimestamp);
    if (packet.type === 'key') keyTimestamps.push(packet.microsecondTimestamp);
    end = Math.max(end, packet.microsecondTimestamp + packet.microsecondDuration);
  }

  timestamps.sort((a, b) => a - b);
  keyTimestamps.sort((a, b) => a - b);

  const first = timestamps[0] ?? 0;
  const durationSeconds = Math.max(0, end - first) / 1e6;
  return {
    timestamps: Float64Array.from(timestamps),
    keyTimestamps: Float64Array.from(keyTimestamps),
    frameCount: timestamps.length,
    durationSeconds,
    frameRate: durationSeconds > 0 ? timestamps.length / durationSeconds : 0,
  };
}
