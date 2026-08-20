import { afterEach, describe, expect, it } from 'vitest';
import { exportFilename } from '../src/platform/export/export.ts';
import { chooseFile } from '../src/platform/export/destination.ts';
import { clipSource, videoSource } from '../src/platform/export/export-source.ts';
import type { VideoTimeline } from '../src/platform/video/frame-provider.ts';

/**
 * What an export writes, and when it says each frame is.
 *
 * No GPU here, deliberately. What can go wrong on this path without a renderer
 * is a timestamp, and a timestamp is exactly the kind of thing that is wrong by
 * a constant offset in a way nobody notices until a mask no longer lines up
 * with the frame it was drawn on.
 *
 * A photograph's one-frame source is not here, because decoding one needs
 * `createImageBitmap` and Node has none. The end-to-end suite exports a
 * photograph in a browser instead.
 */

/**
 * Just enough provider to answer the questions a source asks of one.
 *
 * No cast: a source takes the narrow reader rather than the whole provider, so
 * a stub that answers those two things is a real one rather than a pretend one.
 */
function provider(timestamps: readonly number[]): Parameters<typeof clipSource>[0] {
  const timeline: VideoTimeline = {
    timestamps: Float64Array.from(timestamps),
    keyTimestamps: Float64Array.from(timestamps.slice(0, 1)),
    frameCount: timestamps.length,
    durationSeconds: (timestamps.at(-1) ?? 0) / 1e6,
    frameRate: 30,
  };
  return {
    info: { width: 1920, height: 1080, codec: 'avc1.640028', timeline },
    readFrame: () => Promise.resolve(false),
  };
}

const CONSTANT = [0, 33_333, 66_666, 100_000, 133_333];

describe('what an export is given to write', () => {
  it('takes every frame of the clip, in order', () => {
    const source = clipSource(provider(CONSTANT));
    expect(source.frames.map((frame) => frame.index)).toEqual([0, 1, 2, 3, 4]);
    expect(source.width).toBe(1920);
    expect(source.height).toBe(1080);
  });

  it('takes timestamps from the container rather than from a frame rate', () => {
    // A variable frame rate: the third frame is held twice as long. Multiplying
    // an index by a rate would put every frame after it in the wrong place.
    const source = clipSource(provider([0, 33_333, 66_666, 133_333, 166_666]));
    expect(source.frames.map((frame) => frame.timestampMicros)).toEqual([
      0, 33_333, 66_666, 133_333, 166_666,
    ]);
    expect(source.frames.map((frame) => frame.durationMicros)).toEqual([
      33_333, 33_333, 66_667, 33_333, 33_333,
    ]);
  });

  it('rebases to zero, so an edit list does not leave silence at the front', () => {
    // An ordinary ffmpeg file with B-frames starts its presentation two frames
    // in. Writing that out unchanged is a clip that begins with a gap.
    const source = clipSource(provider([66_666, 100_000, 133_333]));
    expect(source.frames[0]?.timestampMicros).toBe(0);
    expect(source.frames.map((frame) => frame.timestampMicros)).toEqual([0, 33_334, 66_667]);
  });

  it('gives the last frame a duration rather than none', () => {
    // A zero-length final frame is a file some players cut short.
    const source = clipSource(provider(CONSTANT));
    expect(source.frames.at(-1)?.durationMicros).toBe(33_333);
  });

  it('writes one frame of a clip at that frame’s own time', () => {
    const source = videoSource(provider(CONSTANT), [3]);
    expect(source.frames).toHaveLength(1);
    expect(source.frames[0]?.index).toBe(3);
    // Rebased against itself: one frame written on its own starts at zero.
    expect(source.frames[0]?.timestampMicros).toBe(0);
  });
});

describe('what an export is called', () => {
  it('names a photograph and a clip after the document', () => {
    expect(exportFilename('holiday.jpg', 'png')).toBe('holiday-rotyl.png');
    expect(exportFilename('city.mov', 'mp4')).toBe('city-rotyl.mp4');
    expect(exportFilename('holiday.png', 'jpeg')).toBe('holiday-rotyl.jpg');
  });

  it('names one frame of a clip after the frame', () => {
    // Exporting three frames of the same clip should not write one file three
    // times, and the number is the one the timeline shows rather than the index.
    expect(exportFilename('city.mp4', 'png', 0)).toBe('city-rotyl-f00001.png');
    expect(exportFilename('city.mp4', 'png', 1042)).toBe('city-rotyl-f01043.png');
  });

  it('survives a name with no extension, and one that is only an extension', () => {
    expect(exportFilename('screenshot', 'png')).toBe('screenshot-rotyl.png');
    expect(exportFilename('.hidden', 'png')).toBe('image-rotyl.png');
  });
});

/**
 * Where an export is sent, which is a decision taken before any of the work.
 *
 * No DOM here either, and it needs none: what this module does is ask a global
 * that may not exist and turn one exception into a value. Both of those are
 * exactly the kind of thing that is written once and then quietly stops being
 * true, and neither needs a browser to check.
 */
function setPicker(value: typeof globalThis.showSaveFilePicker): void {
  globalThis.showSaveFilePicker = value;
}

describe('where an export is sent', () => {
  afterEach(() => {
    setPicker(undefined);
  });

  it('takes the downloads folder where there is no picker to ask', async () => {
    expect(globalThis.showSaveFilePicker).toBeUndefined();
    // Safari and Firefox. Not an error and not a question: there is one place a
    // file can go, so it goes there.
    await expect(chooseFile('clip-rotyl.mp4', 'mp4')).resolves.toEqual({ kind: 'download' });
  });

  it('takes the file that was picked, by the name the picker gave it', async () => {
    // The user may rename it in the dialog, so the suggested name is a
    // suggestion and the handle's name is the fact.
    // A real handle is not available in Node and is not needed: what a
    // destination asks of one is a name and a way to open a writable, and this
    // answers the half the picker decides.
    setPicker(() =>
      Promise.resolve({
        name: 'somewhere else.mp4',
        createWritable: () => Promise.resolve(new WritableStream<FileSystemWriteChunkType>()),
      }),
    );
    const chosen = await chooseFile('clip-rotyl.mp4', 'mp4');
    expect(chosen?.kind).toBe('file');
    expect(chosen?.kind === 'file' ? chosen.name : undefined).toBe('somewhere else.mp4');
  });

  it('says nothing at all when the dialog is dismissed', async () => {
    // They were asked a question and declined to answer it. Reported as a
    // failure it would be the product arguing with a decision the user made.
    setPicker(() => Promise.reject(new DOMException('The user aborted a request.', 'AbortError')));
    await expect(chooseFile('clip-rotyl.mp4', 'mp4')).resolves.toBeUndefined();
  });

  it('lets a real failure through rather than reading it as a dismissal', async () => {
    setPicker(() => Promise.reject(new DOMException('Not allowed', 'SecurityError')));
    await expect(chooseFile('clip-rotyl.mp4', 'mp4')).rejects.toThrow('Not allowed');
  });
});
