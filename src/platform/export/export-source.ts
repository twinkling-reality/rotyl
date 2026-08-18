import { decodeImageFile } from '../image-file.ts';
import { uploadFrameToTexture, uploadImageToTexture } from '../texture-upload.ts';
import type { ExportFrame, ExportSource } from './export.ts';
// Type-only, so this module pulls in no demuxer: a session that never opens a
// video must not fetch one, and a static import here would defeat the dynamic
// import the frame provider is behind.
import type { FrameProvider } from '../video/frame-provider.ts';

/**
 * What a source needs of the open video, which is less than a provider is.
 *
 * Narrower than `FrameProvider` on purpose: an export reads frames and asks
 * where they are, and nothing here should be in a position to seek, dispose or
 * supersede a request on the object the editor is still using.
 */
type FrameReader = Pick<FrameProvider, 'info' | 'readFrame'>;

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

/** Every frame of the clip, in order. */
export function clipSource(provider: FrameReader): ExportSource {
  const count = provider.info.timeline.frameCount;
  return videoSource(
    provider,
    Array.from({ length: count }, (_, index) => index),
  );
}

function frameDuration(timestamps: Float64Array, index: number): number {
  const here = timestamps[index] ?? 0;
  const next = timestamps[index + 1];
  if (next !== undefined) return next - here;
  const previous = timestamps[index - 1];
  return previous === undefined ? 33_333 : here - previous;
}
