import { afterAll, describe, expect, it } from 'vitest';
import { testDevice } from './gpu-harness.ts';
import { framesToFollow, VideoScene, type TrackedFrames } from '../src/platform/perception/video-scene.ts';
import type { VideoInfo } from '../src/platform/video/frame-provider.ts';
import type {
  MaskProposal,
  SceneEmbedding,
  SegmentationEngine,
} from '../src/core/perception/segmentation-engine.ts';

/**
 * The frame-walking half of the tracking seam.
 *
 * What is worth testing is what the seam promises `runTracking`: a list of
 * frames starting with the anchor, and a read that either understands one or
 * says it could not. The upload itself is not: it is one call to
 * `copyExternalImageToTexture` with a `VideoFrame`, and Node has neither, so a
 * test of it here would be a test of a fake. Playwright exercises that path in
 * a browser, where both exist.
 *
 * ONE SCENE, AND THEREFORE ONE TEXTURE. The frame list is arithmetic and is
 * tested as arithmetic, with no device at all, because this suite pays for
 * every file that touches one: `mask-refine` and its neighbours abort under
 * load with every assertion passed, and five scenes here to check five lists
 * measurably made that worse.
 */

function clipOf(frameCount: number): VideoInfo {
  return {
    width: 8,
    height: 4,
    codec: 'avc1.640028',
    timeline: {
      timestamps: Float64Array.from({ length: frameCount }, (_, i) => i * 33333),
      keyTimestamps: Float64Array.from([0]),
      frameCount,
      durationSeconds: frameCount / 30,
      frameRate: 30,
    },
  };
}

/** Records what it was asked for, and can refuse, which is the case that matters. */
class FakeProvider implements TrackedFrames {
  readonly asked: number[] = [];
  readonly info: VideoInfo;
  disposed = false;
  refuse = false;

  constructor(clip: VideoInfo) {
    this.info = clip;
  }

  readFrame(index: number): Promise<boolean> {
    this.asked.push(index);
    // `use` is deliberately never called: it would have to be handed a
    // VideoFrame, and what this fake is for happens either side of it.
    return Promise.resolve(!this.refuse);
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** An embedding is opaque, so a fake one is a handle with nothing behind it. */
const NO_ENGINE: SegmentationEngine = {
  encode: (): Promise<SceneEmbedding> => Promise.resolve({ dispose: (): void => undefined }),
  decode: (): Promise<readonly MaskProposal[]> => Promise.resolve([]),
  dispose: (): void => undefined,
};

describe('the frames a tracking run follows', () => {
  it('starts on the frame the selection was made on and walks forward', () => {
    // Ascending, contiguous, and beginning with the anchor: the seam says the
    // first entry is the frame the tracker is seeded from, and the provider is
    // only cheap while it never goes backwards.
    expect(framesToFollow(4, undefined, 10)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('stops where it is told to, and at the end of the clip whatever it is told', () => {
    expect(framesToFollow(0, 3, 10)).toEqual([0, 1, 2]);
    expect(framesToFollow(8, 400, 10)).toEqual([8, 9]);
    // An anchor past the end is a run with nothing to follow, which
    // `runTracking` refuses rather than something this has to invent.
    expect(framesToFollow(12, undefined, 10)).toEqual([]);
  });
});

describe('reading a frame for a tracking run', () => {
  const provider = new FakeProvider(clipOf(10));
  let scene: VideoScene | undefined;

  afterAll(() => scene?.dispose());

  it('refuses a frame it could not read rather than skipping it', async () => {
    // A gap in the masks is invisible downstream: the fold holds the previous
    // frame forward, so a skipped frame looks exactly like a tracked one that
    // did not move.
    const device = (await testDevice()).device;
    scene = new VideoScene({ device, engine: NO_ENGINE, provider, from: 0 });
    provider.refuse = true;

    await expect(scene.understand(3)).rejects.toThrow(/frame 3/);
    expect(provider.asked).toEqual([3]);
  });

  it('gives back the decoder it held open, and says so afterwards', async () => {
    // A run holds a second decode session for its whole length, which is the
    // price of the tracker and the playhead being two cursors.
    scene?.dispose();
    expect(provider.disposed).toBe(true);
    await expect(scene?.understand(1)).rejects.toThrow(/disposed/);
  });
});
