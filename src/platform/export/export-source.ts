import { decodeImageFile } from '../image-file.ts';
import { uploadFrameToTexture, uploadImageToTexture } from '../texture-upload.ts';
import {
  carriesAudio,
  type ExportAudio,
  type ExportFormat,
  type ExportFrame,
  type ExportSource,
} from './export.ts';
// Type-only, so this module pulls in no demuxer: a session that never opens a
// video must not fetch one, and a static import here would defeat the dynamic
// import the frame provider is behind.
import type { FrameProvider } from '../video/frame-provider.ts';
import type { EncodedPacket } from 'mediabunny';

/**
 * What a source needs of the open video, which is less than a provider is.
 *
 * Narrower than `FrameProvider` on purpose: an export reads frames and asks
 * where they are, and nothing here should be in a position to seek, dispose or
 * supersede a request on the object the editor is still using.
 */
type FrameReader = Pick<FrameProvider, 'info' | 'readFrame' | 'countAudioPackets' | 'audioPackets'>;

/**
 * Which frames a clip export writes, as an inclusive pair of frame numbers.
 *
 * A RANGE ON THE EXPORT, AND NOT A TRIM OF THE DOCUMENT, which are not the same
 * thing and only one of them is right. Every command in the log carries an
 * absolute frame number and folds forward, so a selection made at frame 100
 * still applies at frame 500. A trim that renumbered frames would put the log
 * and the timeline into disagreement about what frame 500 means, and every
 * command made before the in point would either move or stop applying. So the
 * only thing a range changes is WHICH frames are handed over: the numbers on
 * them are the document's own, the fold answers for each one exactly as it did,
 * and a selection made before the range starts still reaches it.
 *
 * Do not be tempted to subtract `from` anywhere below. The one thing that IS
 * rebased is the presentation timestamp, so the written file starts at zero,
 * and that is a property of the file rather than of the document.
 */
export interface FrameRange {
  readonly from: number;
  readonly to: number;
}

/** A photograph is a one-frame document, and this is what that looks like. */
const ONE_FRAME: readonly ExportFrame[] = [{ index: 0, timestampMicros: 0, durationMicros: 0 }];

/** The original photograph, decoded again at full size. */
export async function imageFileSource(file: Blob, maxDimension: number): Promise<ExportSource> {
  const decoded = await decodeImageFile(file, maxDimension);
  if (!decoded.ok) throw new Error('The original file could no longer be decoded.');
  const { bitmap, width, height } = decoded.value;
  return {
    width,
    height,
    frames: ONE_FRAME,
    fill(device, texture) {
      uploadImageToTexture(device, bitmap, texture);
      return Promise.resolve();
    },
    release() {
      // An ImageBitmap holds a full RGBA copy: 192 MB for a 48 megapixel photograph.
      bitmap.close();
    },
  };
}

/**
 * Frames of the open video.
 *
 * `frames` is built from the container's own index, so the timestamps written
 * out are the timestamps that were read in, rebased so the first frame exported
 * sits at zero. Deriving them by multiplying an index by a frame rate would put
 * every frame of a variable-rate clip at a time it is not at, and would put
 * every frame of an ordinary one two frames early wherever an edit list removes
 * the initial composition delay.
 *
 * A video frame is already full resolution as the decoder hands it over, so
 * there is nothing to go back to the file for beyond the decode itself. Nothing
 * is released: the provider belongs to the open document and outlives the
 * export.
 */
export function videoSource(provider: FrameReader, frames: readonly number[]): ExportSource {
  const { width, height, timeline } = provider.info;
  const origin = timeline.timestamps[frames[0] ?? 0] ?? 0;

  return {
    width,
    height,
    frames: frames.map((index) => ({
      index,
      timestampMicros: (timeline.timestamps[index] ?? 0) - origin,
      // The next frame's start, or the clip's own idea of a frame's length at
      // the end. A container that gives no duration for the last frame is
      // ordinary, and a zero-length final frame is a file some players cut off.
      durationMicros: frameDuration(timeline.timestamps, index),
    })),
    async fill(device, texture, frame) {
      const shown = await provider.readFrame(frame.index, (decoded) => {
        uploadFrameToTexture(device, decoded, texture);
      });
      if (!shown) throw new Error('That frame could not be decoded again.');
    },
    release() {
      /* the provider belongs to the open file, not to this export */
    },
  };
}

/**
 * The frames of the clip a range asks for, in order, with the sound under them.
 *
 * Asynchronous where the still sources are not, and for one reason: the movie
 * box is reserved at the front of the file, so the number of audio packets has
 * to be known before the first frame is rendered. That is a walk of the audio
 * track's sample tables with none of its payload, measured at about a
 * microsecond a packet.
 */
export async function clipSource(
  provider: FrameReader,
  format: ExportFormat,
  range?: FrameRange,
): Promise<ExportSource> {
  const { timeline, audio } = provider.info;
  const from = Math.max(0, Math.min(range?.from ?? 0, timeline.frameCount - 1));
  const to = Math.max(from, Math.min(range?.to ?? timeline.frameCount - 1, timeline.frameCount - 1));
  const frames = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const video = videoSource(provider, frames);

  // Three ways of having no sound to write, and all of them are decided here
  // rather than part way through: no audio track, a codec this container cannot
  // carry, and a range with no packet starting inside it.
  if (!audio || !carriesAudio(format, audio.codec)) return video;

  const originMicros = timeline.timestamps[from] ?? 0;
  const endMicros = (timeline.timestamps[to] ?? 0) + frameDuration(timeline.timestamps, to);
  const packetCount = await provider.countAudioPackets(originMicros, endMicros);
  if (packetCount === 0) return video;

  const packets = provider.audioPackets(originMicros, endMicros);
  const originSeconds = originMicros / 1e6;
  /** Read from the cursor and not yet due, which is at most one packet held. */
  let waiting: EncodedPacket | undefined;

  const soundtrack: ExportAudio = {
    codec: audio.codec,
    config: audio.config,
    packetCount,
    async next(dueMicros) {
      waiting ??= (await packets.next()).value ?? undefined;
      if (!waiting) return undefined;
      const at = waiting.timestamp - originSeconds;
      if (at * 1e6 > dueMicros) return undefined;
      const packet = waiting;
      waiting = undefined;
      // Rebased and NOTHING ELSE. `clone` keeps the same bytes, so the sound in
      // the written clip is the source's own packets rather than a re-encode of
      // them, which is the one thing about a clip export that is exact.
      return packet.clone({ timestamp: at });
    },
  };

  return {
    ...video,
    audio: soundtrack,
    release() {
      // The generator holds a reader on the file. Left open it would keep one
      // for as long as the document does, which is the sort of leak that only
      // shows up on the fiftieth export.
      void packets.return();
      video.release();
    },
  };
}

function frameDuration(timestamps: Float64Array, index: number): number {
  const here = timestamps[index] ?? 0;
  const next = timestamps[index + 1];
  if (next !== undefined) return next - here;
  const previous = timestamps[index - 1];
  return previous === undefined ? 33_333 : here - previous;
}
