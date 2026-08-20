import { afterEach, describe, expect, it } from 'vitest';
import { EncodedPacket, Mp4OutputFormat } from 'mediabunny';
import { MP4_AUDIO_CODECS, carriesAudio, exportFilename } from '../src/platform/export/export.ts';
import { chooseFile } from '../src/platform/export/destination.ts';
import { clipSource, videoSource } from '../src/platform/export/export-source.ts';
import type { Soundtrack, VideoTimeline } from '../src/platform/video/frame-provider.ts';

/**
 * What an export writes, and when it says each frame is.
 *
 * No GPU here, deliberately. What can go wrong on this path without a renderer
 * is a timestamp, and a timestamp is exactly the kind of thing that is wrong by
 * a constant offset in a way nobody notices until a mask no longer lines up
 * with the frame it was drawn on. The soundtrack doubles that risk, since it
 * has a grid of its own that does not line up with the frames.
 *
 * A photograph's one-frame source is not here, because decoding one needs
 * `createImageBitmap` and Node has none. The end-to-end suite exports a
 * photograph in a browser instead.
 */

/** 1024 samples at 48 kHz, which is what an AAC packet is. */
const PACKET_SECONDS = 1024 / 48_000;

const AAC: Soundtrack = {
  codec: 'aac',
  config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
  sampleRate: 48_000,
  channels: 2,
};

/** Distinct bytes per packet, so "the same packet came out" is checkable. */
function audioPacket(index: number): EncodedPacket {
  return new EncodedPacket(
    Uint8Array.from([index & 0xff, (index >> 8) & 0xff, 0xab]),
    'key',
    index * PACKET_SECONDS,
    PACKET_SECONDS,
    index,
  );
}

/**
 * Just enough provider to answer the questions a source asks of one.
 *
 * No cast: a source takes the narrow reader rather than the whole provider, so
 * a stub that answers those four things is a real one rather than a pretend one.
 */
function provider(
  timestamps: readonly number[],
  audio?: { track: Soundtrack; packets: number },
): Parameters<typeof clipSource>[0] {
  const timeline: VideoTimeline = {
    timestamps: Float64Array.from(timestamps),
    keyTimestamps: Float64Array.from(timestamps.slice(0, 1)),
    frameCount: timestamps.length,
    durationSeconds: (timestamps.at(-1) ?? 0) / 1e6,
    frameRate: 30,
  };
  const inSpan = function* (from: number, to: number): Generator<EncodedPacket> {
    for (let index = 0; index < (audio?.packets ?? 0); index++) {
      const at = index * PACKET_SECONDS * 1e6;
      // Packets whose presentation STARTS inside the span, which is the rule
      // the real walk follows and the reason a range loses at most one packet.
      if (at < from) continue;
      if (at >= to) return;
      yield audioPacket(index);
    }
  };
  return {
    info: { width: 1920, height: 1080, codec: 'avc1.640028', timeline, audio: audio?.track },
    readFrame: () => Promise.resolve(false),
    countAudioPackets: (from, to) => Promise.resolve([...inSpan(from, to)].length),
    // eslint-disable-next-line @typescript-eslint/require-await
    audioPackets: async function* (from, to) {
      yield* inSpan(from, to);
    },
  };
}

const CONSTANT = [0, 33_333, 66_666, 100_000, 133_333];

describe('what an export is given to write', () => {
  it('takes every frame of the clip, in order', async () => {
    const source = await clipSource(provider(CONSTANT), 'mp4');
    expect(source.frames.map((frame) => frame.index)).toEqual([0, 1, 2, 3, 4]);
    expect(source.width).toBe(1920);
    expect(source.height).toBe(1080);
  });

  it('takes timestamps from the container rather than from a frame rate', async () => {
    // A variable frame rate: the third frame is held twice as long. Multiplying
    // an index by a rate would put every frame after it in the wrong place.
    const source = await clipSource(provider([0, 33_333, 66_666, 133_333, 166_666]), 'mp4');
    expect(source.frames.map((frame) => frame.timestampMicros)).toEqual([
      0, 33_333, 66_666, 133_333, 166_666,
    ]);
    expect(source.frames.map((frame) => frame.durationMicros)).toEqual([
      33_333, 33_333, 66_667, 33_333, 33_333,
    ]);
  });

  it('rebases to zero, so an edit list does not leave silence at the front', async () => {
    // An ordinary ffmpeg file with B-frames starts its presentation two frames
    // in. Writing that out unchanged is a clip that begins with a gap.
    const source = await clipSource(provider([66_666, 100_000, 133_333]), 'mp4');
    expect(source.frames[0]?.timestampMicros).toBe(0);
    expect(source.frames.map((frame) => frame.timestampMicros)).toEqual([0, 33_334, 66_667]);
  });

  it('gives the last frame a duration rather than none', async () => {
    // A zero-length final frame is a file some players cut short.
    const source = await clipSource(provider(CONSTANT), 'mp4');
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

describe('a range, which is a range on the export and not a trim', () => {
  it('hands over the frames it was asked for and no others', async () => {
    const source = await clipSource(provider(CONSTANT), 'mp4', { from: 1, to: 3 });
    expect(source.frames.map((frame) => frame.index)).toEqual([1, 2, 3]);
  });

  it('keeps the document’s own frame numbers on them', async () => {
    // THE WHOLE POINT OF THE DECISION. Every command in the log carries an
    // absolute frame number and folds forward, so a selection made at frame 0
    // still applies at frame 3. Renumbering here would put the log and the
    // timeline into disagreement about what frame 3 means.
    const source = await clipSource(provider(CONSTANT), 'mp4', { from: 2, to: 4 });
    expect(source.frames.map((frame) => frame.index)).toEqual([2, 3, 4]);
  });

  it('starts the written file at zero even though the frames do not', async () => {
    const source = await clipSource(provider(CONSTANT), 'mp4', { from: 2, to: 4 });
    expect(source.frames.map((frame) => frame.timestampMicros)).toEqual([0, 33_334, 66_667]);
  });

  it('clamps a range that runs off either end rather than refusing it', async () => {
    const source = await clipSource(provider(CONSTANT), 'mp4', { from: -5, to: 99 });
    expect(source.frames.map((frame) => frame.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('writes one frame where the two ends meet', async () => {
    const source = await clipSource(provider(CONSTANT), 'mp4', { from: 3, to: 3 });
    expect(source.frames.map((frame) => frame.index)).toEqual([3]);
  });
});

describe('the soundtrack, which is copied rather than encoded', () => {
  it('counts its packets before a frame is rendered', async () => {
    // The movie box is reserved at the front of the file and cannot be sized
    // without a maximum on every track, so this number has to exist up front.
    const source = await clipSource(provider(CONSTANT, { track: AAC, packets: 16 }), 'mp4');
    // Five frames is 166 ms; a 21.3 ms packet starts inside that eight times.
    expect(source.audio?.packetCount).toBe(8);
  });

  it('hands over a packet only once it is due', async () => {
    const source = await clipSource(provider(CONSTANT, { track: AAC, packets: 16 }), 'mp4');
    const audio = source.audio;
    expect(audio).toBeDefined();
    if (!audio) return;
    // Nothing is due before the first frame by time, and the loop asks for one
    // anyway, which is what stops the muxer holding every frame in memory.
    await expect(audio.next(0)).resolves.toBeDefined();
    // The second packet starts at 21.3 ms and frame one is at 33.3 ms.
    await expect(audio.next(0)).resolves.toBeUndefined();
    await expect(audio.next(33_333)).resolves.toBeDefined();
  });

  it('gives back the source’s own bytes, with only the timestamp moved', async () => {
    const source = await clipSource(provider(CONSTANT, { track: AAC, packets: 16 }), 'mp4', {
      from: 2,
      to: 4,
    });
    const audio = source.audio;
    expect(audio).toBeDefined();
    if (!audio) return;
    const packet = await audio.next(Infinity);
    // Frame two is at 66.666 ms, and the first packet starting at or after it
    // is the fourth, at 85.3 ms. The one straddling the in point is dropped:
    // keeping it would mean a negative timestamp or the whole track shifted.
    expect(packet?.data).toEqual(Uint8Array.from([4, 0, 0xab]));
    expect(packet?.timestamp).toBeCloseTo(4 * PACKET_SECONDS - 66_666 / 1e6, 9);
  });

  it('says there is none when the container cannot carry it', async () => {
    const mulaw: Soundtrack = { ...AAC, codec: 'ulaw' };
    const source = await clipSource(provider(CONSTANT, { track: mulaw, packets: 16 }), 'mp4');
    expect(source.audio).toBeUndefined();
  });

  it('says there is none when no packet starts inside the range', async () => {
    // One frame at the end of a clip whose sound ran out before it.
    const source = await clipSource(provider(CONSTANT, { track: AAC, packets: 1 }), 'mp4', {
      from: 4,
      to: 4,
    });
    expect(source.audio).toBeUndefined();
  });

  it('says there is none on a format that holds no sound at all', async () => {
    const source = await clipSource(provider(CONSTANT, { track: AAC, packets: 16 }), 'png');
    expect(source.audio).toBeUndefined();
  });
});

describe('what an MP4 will carry', () => {
  it('claims exactly what the container writer claims', () => {
    // A COPIED LIST, so this is the thing that stops it drifting. The list has
    // to live in `export.ts`, which no video session may pay 42.8 KB to reach,
    // and a library upgrade that changed it would otherwise tell somebody their
    // soundtrack cannot be written when it can.
    expect(MP4_AUDIO_CODECS.toSorted()).toEqual(new Mp4OutputFormat().getSupportedAudioCodecs().toSorted());
  });

  it('answers for a codec without opening anything', () => {
    expect(carriesAudio('mp4', 'aac')).toBe(true);
    expect(carriesAudio('mp4', 'ulaw')).toBe(false);
    expect(carriesAudio('png', 'aac')).toBe(false);
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
