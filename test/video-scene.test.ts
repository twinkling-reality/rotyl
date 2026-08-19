import { beforeAll, describe, expect, it } from 'vitest';
import { disposeWithTestDevice, testDevice } from './gpu-harness.ts';
import { VideoScene } from '../src/platform/perception/video-scene.ts';
import type { VideoInfo } from '../src/platform/video/frame-provider.ts';
import type { TrackedFrames } from '../src/platform/perception/video-scene.ts';
import type {
  MaskProposal,
  SceneEmbedding,
  SceneFrame,
  SegmentationEngine,
} from '../src/core/perception/segmentation-engine.ts';

/**
 * The frame-walking half of the tracking seam.
 *
 * What is worth testing here is what the seam promises `runTracking`, which is
 * a list of frames starting with the anchor and a read that either understands
 * one or says it could not. The upload itself is not: it is one call to
 * `copyExternalImageToTexture` with a `VideoFrame`, and Node has neither, so a
 * test of it here would be a test of a fake. Playwright exercises that path in
 * a browser, where both exist.
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
  disposed = false;
  refuse = false;

  readonly info: VideoInfo;

  constructor(clip: VideoInfo) {
    this.info = clip;
  }

  readFrame(index: number): Promise<boolean> {
    this.asked.push(index);
    // `use` is deliberately never called: it would have to be handed a
    // VideoFrame, and the point of this fake is the frames asked for and the
    // refusal, both of which happen either side of it.
    return Promise.resolve(!this.refuse);
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** An embedding is opaque, so a fake one is a handle with nothing behind it. */
const NO_ENGINE: SegmentationEngine = {
  encode: (_frame: SceneFrame): Promise<SceneEmbedding> =>
    Promise.resolve({ dispose: (): void => undefined }),
  decode: (): Promise<readonly MaskProposal[]> => Promise.resolve([]),
  dispose: (): void => undefined,
};

const sceneOver = (provider: TrackedFrames, device: GPUDevice, from: number, through?: number): VideoScene =>
  new VideoScene({
    device,
    engine: NO_ENGINE,
    provider,
    from,
    ...(through === undefined ? {} : { through }),
  });

describe('the frames a tracking run follows', () => {
  let device: GPUDevice;

  beforeAll(async () => {
    device = (await testDevice()).device;
  });

  it('starts on the frame the selection was made on and walks forward', () => {
    const scene = sceneOver(new FakeProvider(clipOf(10)), device, 4);
    disposeWithTestDevice(() => scene.dispose());
    // Ascending, contiguous, and beginning with the anchor: the seam says the
    // first entry is the frame the tracker is seeded from, and the provider is
    // only cheap while it never goes backwards.
    expect([...scene.frames]).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('stops where it is told to, and at the end of the clip whatever it is told', () => {
    const short = sceneOver(new FakeProvider(clipOf(10)), device, 0, 3);
    const past = sceneOver(new FakeProvider(clipOf(10)), device, 8, 400);
    const beyond = sceneOver(new FakeProvider(clipOf(10)), device, 12);
    disposeWithTestDevice(() => short.dispose());
    disposeWithTestDevice(() => past.dispose());
    disposeWithTestDevice(() => beyond.dispose());

    expect([...short.frames]).toEqual([0, 1, 2]);
    expect([...past.frames]).toEqual([8, 9]);
    // An anchor past the end is a run with nothing to follow, which
    // `runTracking` refuses rather than something this has to invent.
    expect([...beyond.frames]).toEqual([]);
  });

  it('refuses a frame it could not read rather than skipping it', async () => {
    // A gap in the masks is invisible downstream: the fold holds the previous
    // frame forward, so a skipped frame looks exactly like a tracked one that
    // did not move.
    const provider = new FakeProvider(clipOf(10));
    provider.refuse = true;
    const scene = sceneOver(provider, device, 0);
    disposeWithTestDevice(() => scene.dispose());

    await expect(scene.understand(3)).rejects.toThrow(/frame 3/);
    expect(provider.asked).toEqual([3]);
  });

  it('gives back the decoder it held open', async () => {
    // A run holds a second decode session for its whole length, which is the
    // price of the tracker and the playhead being two cursors.
    const provider = new FakeProvider(clipOf(10));
    const scene = sceneOver(provider, device, 0);
    scene.dispose();
    expect(provider.disposed).toBe(true);

    // And says so rather than reading into a destroyed texture.
    await expect(scene.understand(1)).rejects.toThrow(/disposed/);
  });
});
