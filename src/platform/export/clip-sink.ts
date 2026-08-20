import {
  BufferTarget,
  EncodedAudioPacketSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  getFirstEncodableVideoCodec,
  type EncodedPacket,
  type Target,
  type VideoCodec,
} from 'mediabunny';
import type { Dimensions } from '../../core/render/resolution.ts';
import type { Destination } from './destination.ts';
import type { ExportAudio, ExportFrame, FrameSink, SinkState, Written } from './export.ts';

/**
 * Every frame, as a video file.
 *
 * REACHED ONLY THROUGH A DYNAMIC IMPORT. Writing a container costs 42.8 KB
 * gzipped on top of the demuxer already in the video chunk, measured through
 * this project's own build (`node tools/video-bench/bundle-size.mjs`), which is
 * nine tenths of the whole application bundle and was all of it until the
 * chapter that let a selection be saved. Someone
 * who opens a photograph never fetches it, and someone who opens a video does
 * not fetch it either until they ask for a clip.
 *
 * The library owns the encoder as well as the container, and that is a measured
 * choice rather than the easy one. Driving `VideoEncoder` here and piping
 * packets in through `EncodedVideoPacketSource` saves 18.0 KB gzipped inside
 * this chunk and costs 0.26 ms a frame, 5%, at 1080p. What it also costs is owning
 * codec-string construction, backpressure, flush ordering and getting the
 * decoder config into the muxer's first packet, which is exactly the class of
 * detail the demuxer was chosen for rather than hand-rolled.
 *
 * ONE SINK, TWO TARGETS. Where the bytes go is the only thing that differs
 * between a browser that can be handed a file and one that cannot, and it is
 * one line below. Everything that decides what the file IS, the codec, the rate
 * control, the keyframe spacing and where the index sits, is the same for both,
 * because a file that changed shape depending on which browser wrote it would
 * be two products.
 *
 * AND THE SOUND IS COPIED, NOT ENCODED. The video is re-encoded because it was
 * re-drawn; the audio was not touched, so it is written across as the packets
 * it arrived as. There is no `AudioEncoder` and no `AudioDecoder` anywhere in
 * this product, and passing packets through needs neither: what comes out is
 * bit-identical to what went in, which is the one thing about a clip export
 * that is exact. Whether the container can hold a given codec is decided in
 * `export.ts` before the picker is shown, so nothing here has to refuse.
 */

/**
 * The codecs this will write, in preference order.
 *
 * ONE ENTRY, ON PURPOSE. H.264 is the codec whose decode was measured at
 * seventy times real time and whose colour round trip was measured, patch for
 * patch, identical to ffmpeg's. HEVC and AV1 encode in some browsers and have
 * been measured in none here, and shipping a format on an unmeasured path is
 * how a feature becomes slow in a way nobody can explain. A second one is a
 * line in this array once somebody has the numbers.
 */
const CODECS: readonly VideoCodec[] = ['avc'];

/**
 * How good the picture is, stated rather than defaulted.
 *
 * A qualitative level resolves to a QUANTIZER where the codec supports one,
 * which is constant quality and an unbounded file: measured on a styled 1080p
 * frame, `high` that way produces 23 Mbit/s against 6 for the same level asked
 * for as a bitrate, and it is the one figure in that table that moves between
 * runs, because constant quality prices the picture rather than the setting.
 * Neither is faster than the other, so this is a decision about the size of
 * every file anybody exports and nothing else. `very-high` as a bitrate is
 * about 12 Mbit/s at 1080p and scales with resolution.
 */
const QUALITY = new Quality({ quality: 'very-high', preferBitrate: true });

/**
 * A keyframe every second, rather than the two-second default.
 *
 * The file this writes is a file this tool can open, and seek cost is set by
 * keyframe spacing and by nothing else: measured on 1080p30, a clip with
 * one-second keyframes scrubs in 12 ms where the same content with one keyframe
 * takes 88. The extra keyframes are the price of the export being editable.
 */
const KEYFRAME_INTERVAL_SECONDS = 1;

/**
 * The index goes at the front, and it is reserved rather than held.
 *
 * `fastStart` decides where the movie box lands, and a file with it at the end
 * is a different file: nothing can play it until the last byte has arrived, and
 * nothing can seek it without reading to the end first. That is a property this
 * export has always had and is not giving up.
 *
 * There are two ways to have it and they are not equivalent. `'in-memory'`,
 * which is what a `BufferTarget` gets by default and what this used to take,
 * keeps every encoded packet as its own array until finalize and only then
 * assembles the file, so the media exists twice at the moment it is written
 * out. `'reserve'` leaves room at the front, writes each packet into the file
 * as its chunk closes, and seeks back at the end to fill the room in. It needs
 * a target that can seek, which both of these are, and an exact packet count,
 * which an export has: it knows how many frames it is writing before it writes
 * the first one.
 *
 * The reserved room that is not used becomes a `free` box, measured at under a
 * megabyte on an eighteen thousand frame clip.
 */
const FAST_START = 'reserve' as const;

/**
 * How large a file this will build in memory before it stops.
 *
 * ONLY EVER REACHED WITHOUT A FILE TO WRITE INTO. Given a handle the bytes
 * leave as they are made and the length of the clip stops being a variable;
 * given none the whole file is in the tab, and past some length that fails.
 *
 * The divisor is the mechanism rather than a guess. A file of N bytes is
 * assembled in a buffer that grows by doubling, so up to 2N; finalizing slices
 * a second copy out of it, N more; and the download is handed a blob, which is
 * another. Four times the file, at the moment it is finished, is what has to
 * fit. `node tools/video-bench/run.mjs long-clip` takes it end to end: on an
 * Apple M3 Pro under Chrome, whose heap limit reads 4.19 GB, a 1.66 GB file
 * finishes at a peak of 4.36 GB and a 2.2 GB file does not finish at all.
 *
 * Where there is no heap figure to read, which is every browser that also has
 * no file picker, four gigabytes is assumed. It is the wrong number to be sure
 * of and the right order of magnitude, and being wrong here costs a clip that
 * stops early rather than a tab that dies.
 *
 * IT IS NOT A GUARANTEE, and nothing here can make it one: how much a tab can
 * hold depends on what else the machine is doing at that moment, and the same
 * export succeeds and fails on the same browser an hour apart. What the budget
 * buys is that the common case ends in a file rather than in a dead tab. The
 * uncommon one is caught where the blob is handed over.
 */
declare global {
  interface Performance {
    /**
     * Chrome's, and non-standard, and the only thing that answers the question
     * at all: the standard `measureUserAgentSpecificMemory` needs cross-origin
     * isolation, which this application does not have and which would change
     * what it is allowed to fetch. Optional because it genuinely is: the
     * browsers with no save picker mostly have no heap figure either.
     */
    readonly memory?: {
      readonly jsHeapSizeLimit: number;
      readonly usedJSHeapSize: number;
    };
  }
}

const ASSUMED_HEAP_LIMIT = 4 * 2 ** 30;
const COPIES_AT_FINALIZE = 4;

function memoryBudget(): number {
  return (performance.memory?.jsHeapSizeLimit ?? ASSUMED_HEAP_LIMIT) / COPIES_AT_FINALIZE;
}

export function clipSink(destination: Destination): FrameSink {
  const format = new Mp4OutputFormat({ fastStart: FAST_START });
  const budget = destination.kind === 'file' ? Infinity : memoryBudget();

  let target: Target | undefined;
  let output: Output | undefined;
  let track: VideoSampleSource | undefined;
  let sound: EncodedAudioPacketSource | undefined;
  /**
   * The decoder config, on the first packet and no other.
   *
   * The muxer wants it once, to write the sample description, and the source
   * has it up front because it came off the file the packets came off.
   */
  let soundMeta: EncodedAudioChunkMetadata | undefined;
  /** How long the file is so far, which `reserve` makes knowable as it grows. */
  let size = 0;

  return {
    async open(requested: Dimensions, frames: number, audio?: ExportAudio): Promise<Dimensions> {
      // H.264 samples chroma at half resolution in each direction, so an odd
      // dimension has no representation. One pixel off a 4000 px edge is not
      // worth a message; silently producing a file the encoder refuses is.
      const fitted = { width: requested.width & ~1, height: requested.height & ~1 };

      // Our preference order, narrowed to what this container can hold, then
      // narrowed again to what this browser will encode at this size.
      const supported = format.getSupportedVideoCodecs();
      const codec = await getFirstEncodableVideoCodec(
        CODECS.filter((candidate) => supported.includes(candidate)),
        { width: fitted.width, height: fitted.height },
      );
      if (!codec) {
        throw new Error(
          `This browser cannot encode video at ${String(fitted.width)} × ${String(fitted.height)}.`,
        );
      }

      // The one line that differs. A writable file stream takes a positioned
      // write, which is the same shape mediabunny's stream target emits, so
      // seeking back to fill in the index needs nothing in between.
      target =
        destination.kind === 'file'
          ? new StreamTarget(await destination.handle.createWritable())
          : new BufferTarget();
      target.on('write', ({ end }) => {
        if (end > size) size = end;
      });

      output = new Output({ format, target });
      track = new VideoSampleSource({
        codec,
        quality: QUALITY,
        keyFrameInterval: KEYFRAME_INTERVAL_SECONDS,
      });
      // No frameRate in the metadata, deliberately: setting one snaps every
      // timestamp to it, and the timestamps below are the container's own,
      // which is the whole reason a frame index means the same thing here as it
      // does to the person who selected it.
      //
      // maximumPacketCount is what `reserve` needs and what an export can
      // answer: one packet per frame, and the frames are known before the first
      // one is rendered.
      output.addVideoTrack(track, { maximumPacketCount: frames });

      // EVERY track needs one, not just this one. `reserve` sizes the sample
      // tables before the first sample lands, so a second track with no maximum
      // is a table it cannot leave room for, and the source counted the audio
      // packets up front for exactly this line.
      if (audio) {
        sound = new EncodedAudioPacketSource(audio.codec);
        soundMeta = { decoderConfig: audio.config };
        output.addAudioTrack(sound, { maximumPacketCount: audio.packetCount });
      }
      await output.start();
      return fitted;
    },

    async accept(canvas: OffscreenCanvas, frame: ExportFrame): Promise<SinkState> {
      if (!track) throw new Error('The clip was not opened.');
      // Seconds, which is what a VideoSample is measured in.
      const sample = new VideoSample(canvas, {
        timestamp: frame.timestampMicros / 1e6,
        duration: frame.durationMicros / 1e6,
      });
      try {
        // Awaited, so the encoder's own queue is what limits the loop rather
        // than the loop filling it. Measured at 5 ms a frame end to end on a
        // 1080p clip with a cheap style, which is the encoder's own cost: it
        // runs on its own threads and everything before it overlaps with it.
        await track.add(sample);
      } finally {
        sample.close();
      }
      return size < budget ? 'ready' : 'full';
    },

    async acceptAudio(packet: EncodedPacket): Promise<void> {
      if (!sound) throw new Error('The clip has no sound track to write into.');
      // Awaited like a frame is, so the writer's backpressure is what limits
      // the loop. The packet is the source's own bytes: nothing here rewrites
      // them, and the only thing the export changed is when it plays.
      await sound.add(packet, soundMeta);
      soundMeta = undefined;
    },

    async finish(): Promise<Written> {
      track?.close();
      sound?.close();
      await output?.finalize();
      if (destination.kind === 'file') return { to: 'file', name: destination.name };
      const buffer = target instanceof BufferTarget ? target.buffer : undefined;
      return { to: 'download', blob: new Blob([buffer ?? new ArrayBuffer(0)], { type: format.mimeType }) };
    },

    async cancel(): Promise<void> {
      // Releases the encoder, which holds a hardware session, and stops the
      // muxer growing a buffer nobody is going to read.
      //
      // IT DOES NOT UNDO THE FILE, and nothing here can. A writable file stream
      // commits on close and a page cannot delete a handle it was given, so an
      // export abandoned before its first frame leaves a file with a header in
      // it and no index, where the user asked for a video. That is why this is
      // only ever reached when there is genuinely nothing to keep: past the
      // first frame a stop finishes the file instead.
      if (output && (output.state === 'started' || output.state === 'pending')) await output.cancel();
    },
  };
}
