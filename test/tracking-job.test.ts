import { describe, expect, it } from 'vitest';
import { SelectionDocument } from '../src/core/document/selection-document.ts';
import { commandsForFrame, type CoverageMask } from '../src/core/document/selection-command.ts';
import { runTracking, TrackingCancelled, type TrackedScene } from '../src/core/perception/tracking-job.ts';
import type { SceneEmbedding } from '../src/core/perception/segmentation-engine.ts';
import type { ObjectTrack, TrackingEngine } from '../src/core/perception/tracking-engine.ts';

/**
 * The tracking loop, against a tracker made of arithmetic.
 *
 * NO MODEL AND NO GPU, deliberately. What is being tested is the thing that is
 * this project's own design rather than EdgeTAM's: that a run writes commands
 * on frames the user is not looking at, that it takes one undo to remove, that
 * a second object is a second seed rather than a second code path, and that
 * stopping keeps what it found. Whether a mask follows an object is a question
 * for `tools/edgetam-export`, which answers it against ground truth.
 */

const mask = (fill: number, size = 4): CoverageMask => ({
  width: size,
  height: size,
  coverage: new Uint8Array(size * size).fill(fill),
});

/** Records what it was asked and hands back a mask that says which frame it is. */
class FakeEngine implements TrackingEngine {
  readonly begun: CoverageMask[] = [];
  readonly advanced: number[] = [];
  disposed = 0;
  /** Frames the object is not in, by index into the advance sequence. */
  absentAt = new Set<number>();

  #frames: number[];

  constructor(frames: number[]) {
    this.#frames = frames;
  }

  begin(_embedding: SceneEmbedding, seed: CoverageMask): Promise<ObjectTrack> {
    this.begun.push(seed);
    let step = 0;
    const track: ObjectTrack = {
      advance: (): Promise<{ mask: CoverageMask; present: boolean }> => {
        const at = step++;
        this.advanced.push(this.#frames[at + 1] ?? -1);
        const present = !this.absentAt.has(at);
        return Promise.resolve({ mask: mask(present ? 200 : 0), present });
      },
      dispose: (): void => {
        this.disposed++;
      },
    };
    return Promise.resolve(track);
  }

  dispose(): void {}
}

/** Counts the embeddings it made and complains if one is not released. */
function fakeScene(frames: readonly number[]): TrackedScene & { live: number; understood: number[] } {
  const scene = {
    frames,
    live: 0,
    understood: [] as number[],
    understand(frame: number): Promise<SceneEmbedding> {
      scene.live++;
      scene.understood.push(frame);
      return Promise.resolve({
        dispose(): void {
          scene.live--;
        },
      });
    },
  };
  return scene;
}

describe('a tracking run', () => {
  it('writes a command on every frame after the anchor, and none on the anchor', async () => {
    // The anchor already carries the user's own command. Writing the tracker's
    // opinion of a click over the click would be the product disagreeing with a
    // decision it just watched somebody make.
    const document = new SelectionDocument();
    const frames = [10, 11, 12, 13];
    const result = await runTracking({
      scene: fakeScene(frames),
      engine: new FakeEngine(frames),
      document,
      seeds: [mask(255)],
    });

    expect(result.tracked).toBe(3);
    expect(result.lastFrame).toBe(13);
    expect(document.appliedCommands.map((command) => command.frame)).toEqual([11, 12, 13]);
  });

  it('takes one undo, and lands on the frame the selection was made on', async () => {
    const document = new SelectionDocument();
    // A stroke first, so undo has somewhere to stop that is not the beginning.
    document.apply({ kind: 'clear', frame: 10 });
    const frames = [10, 11, 12, 13, 14, 15];
    await runTracking({
      scene: fakeScene(frames),
      engine: new FakeEngine(frames),
      document,
      seeds: [mask(255)],
    });
    expect(document.appliedCommands).toHaveLength(6);

    const undone = document.undo();
    expect(document.appliedCommands).toHaveLength(1);
    // The FIRST frame of the run, so a caller following the cursor goes to
    // where the gesture started rather than to where it stopped.
    expect(undone?.frame).toBe(11);

    // And back again, as one.
    expect(document.redo()?.frame).toBe(11);
    expect(document.appliedCommands).toHaveLength(6);

    // The stroke underneath is still its own undo.
    document.undo();
    expect(document.undo()?.kind).toBe('clear');
    expect(document.appliedCommands).toHaveLength(0);
  });

  it('follows a second object without a second code path', async () => {
    const document = new SelectionDocument();
    const frames = [0, 1, 2];
    const engine = new FakeEngine(frames);
    await runTracking({
      scene: fakeScene(frames),
      engine,
      document,
      seeds: [mask(255), mask(128)],
    });

    // Two tracks, seeded with what they were given, in order.
    expect(engine.begun.map((seed) => seed.coverage[0])).toEqual([255, 128]);
    // Two commands per frame, and the frame was read once for both of them:
    // reading is the expensive half and it does not scale with objects.
    const onFrameOne = document.appliedCommands.filter((command) => command.frame === 1);
    expect(onFrameOne).toHaveLength(2);
    // The first replaces what was held forward, which is the drift being
    // removed; the second adds, so two objects are two regions and not a race.
    expect(onFrameOne.map((command) => (command.kind === 'applyMask' ? command.op : ''))).toEqual([
      'replace',
      'add',
    ]);
    // Still one undo for the whole run, across both objects.
    document.undo();
    expect(document.appliedCommands).toHaveLength(0);
  });

  it('reads each frame once however many objects are followed', async () => {
    const frames = [0, 1, 2, 3];
    const scene = fakeScene(frames);
    await runTracking({
      scene,
      engine: new FakeEngine(frames),
      document: new SelectionDocument(),
      seeds: [mask(255), mask(200), mask(128)],
    });
    expect(scene.understood).toEqual([0, 1, 2, 3]);
  });

  it('releases every embedding, including the anchor', async () => {
    const frames = [0, 1, 2, 3, 4];
    const scene = fakeScene(frames);
    await runTracking({
      scene,
      engine: new FakeEngine(frames),
      document: new SelectionDocument(),
      seeds: [mask(255)],
    });
    // Tens of megabytes each, hundreds of frames. A leak here is the feature
    // being unusable rather than a tidiness question.
    expect(scene.live).toBe(0);
  });

  it('keeps what it found when it is stopped, and releases the tracks', async () => {
    const document = new SelectionDocument();
    const frames = [0, 1, 2, 3, 4, 5, 6, 7];
    const engine = new FakeEngine(frames);
    const controller = new AbortController();

    await expect(
      runTracking({
        scene: fakeScene(frames),
        engine,
        document,
        seeds: [mask(255)],
        signal: controller.signal,
        onProgress: (tracked) => {
          if (tracked === 3) controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(TrackingCancelled);

    // Stop is not undo. Three frames were followed and three frames are kept;
    // there is already a button for taking them back.
    expect(document.appliedCommands.map((command) => command.frame)).toEqual([1, 2, 3]);
    expect(engine.disposed).toBe(1);
    // And they are still one group, so that button is one press.
    document.undo();
    expect(document.appliedCommands).toHaveLength(0);
  });

  it('counts the frames the object was not in', async () => {
    const frames = [0, 1, 2, 3, 4, 5];
    const engine = new FakeEngine(frames);
    // Hidden for the middle of the run, which is what an occlusion looks like.
    engine.absentAt = new Set([1, 2]);
    const result = await runTracking({
      scene: fakeScene(frames),
      engine,
      document: new SelectionDocument(),
      seeds: [mask(255)],
    });
    expect(result.absent).toBe(2);
  });

  it('leaves frames it has not reached showing what they showed before', async () => {
    // The playhead and the tracker are two cursors over one document, so a
    // frame beyond where it got to must still fold to the held-forward value
    // rather than to nothing.
    const document = new SelectionDocument();
    document.apply({ kind: 'applyMask', mask: mask(255), op: 'add', frame: 0 });
    const frames = [0, 1, 2];
    await runTracking({
      scene: fakeScene(frames),
      engine: new FakeEngine(frames),
      document,
      seeds: [mask(255)],
    });

    const beyond = commandsForFrame(document.appliedCommands, 50);
    expect(beyond.at(-1)?.frame).toBe(2);
    expect(beyond).toHaveLength(3);
  });

  it('refuses a run with nothing to follow', async () => {
    await expect(
      runTracking({
        scene: fakeScene([0, 1]),
        engine: new FakeEngine([0, 1]),
        document: new SelectionDocument(),
        seeds: [],
      }),
    ).rejects.toThrow(/nothing to follow/);
  });
});
