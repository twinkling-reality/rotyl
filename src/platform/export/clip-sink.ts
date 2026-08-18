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
import type { Dimensions } from '../../core/render/resolution.ts';
import type { ExportFrame, FrameSink } from './export.ts';

/**
 * Every frame, as a video file.
 *
 * REACHED ONLY THROUGH A DYNAMIC IMPORT. Writing a container costs 41.6 KB
 * gzipped on top of the demuxer already in the video chunk, measured through
 * this project's own build (`node tools/video-bench/bundle-size.mjs`), which is
 * the size of the whole application bundle to the tenth of a kilobyte. Someone
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
 * frame, `high` that way produces 30 Mbit/s against 12 for the same level asked
 * for as a bitrate. Neither is faster than the other, so this is a decision
 * about the size of every file anybody exports and nothing else. `very-high`
 * as a bitrate is about 12 Mbit/s at 1080p and scales with resolution.
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

export function clipSink(): FrameSink {
  const format = new Mp4OutputFormat();
  // fastStart defaults to 'in-memory' for a BufferTarget, which puts the index
  // at the front of the file. That is what makes an exported clip start playing
  // before it has finished downloading, and it costs nothing here because the
  // whole file is already being held in memory anyway.
  const output = new Output({ format, target: new BufferTarget() });
  let track: VideoSampleSource | undefined;

  return {
    async open(size: Dimensions): Promise<Dimensions> {
      // H.264 samples chroma at half resolution in each direction, so an odd
      // dimension has no representation. One pixel off a 4000 px edge is not
      // worth a message; silently producing a file the encoder refuses is.
      const fitted = { width: size.width & ~1, height: size.height & ~1 };

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

      track = new VideoSampleSource({
        codec,
        quality: QUALITY,
        keyFrameInterval: KEYFRAME_INTERVAL_SECONDS,
      });
      // No frameRate in the metadata, deliberately: setting one snaps every
      // timestamp to it, and the timestamps below are the container's own,
      // which is the whole reason a frame index means the same thing here as it
      // does to the person who selected it.
      output.addVideoTrack(track);
      await output.start();
      return fitted;
    },

    async accept(canvas: OffscreenCanvas, frame: ExportFrame): Promise<void> {
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
    },

    async finish(): Promise<Blob> {
      track?.close();
      await output.finalize();
      return new Blob([output.target.buffer ?? new ArrayBuffer(0)], { type: format.mimeType });
    },

    async cancel(): Promise<void> {
      // Releases the encoder, which holds a hardware session, and stops the
      // muxer growing a buffer nobody is going to read.
      if (output.state === 'started' || output.state === 'pending') await output.cancel();
    },
  };
}
