import { describe, expect, it } from 'vitest';
import { SelectionDocument } from '../src/core/document/selection-document.ts';
import { packCoverage, type CoverageMask } from '../src/core/document/coverage-mask.ts';
import { TrackingStore } from '../src/core/perception/tracking-store.ts';
import type { SceneEmbedding } from '../src/core/perception/segmentation-engine.ts';
import type { ObjectTrack, TrackingEngine } from '../src/core/perception/tracking-engine.ts';
import type { TrackedScene } from '../src/core/perception/tracking-job.ts';

/**
 * The seam a run's own account of itself used to die at.
 *
 * `runTracking` has always returned how many frames it reached and how many of
 * those the model said the object was not in. This store awaited it and
 * returned nothing, so the only thing outside a run that knew anything about it
 * was the progress figure, which is gone by the time it matters.
 *
 * `tracking-job.test.ts` covers the loop. What is left here is the boundary:
 * that the result crosses it, that a stop is a value rather than an exception,
 * and that the three cases with nothing to report say so by returning nothing.
 */

const mask = (fill: number): CoverageMask => packCoverage(4, 4, new Uint8Array(16).fill(fill));

/** A tracker made of arithmetic, with a set of frames it says nothing is in. */
function fakeEngine(
  absentAt: ReadonlySet<number> = new Set(),
  onAdvance?: (at: number) => void,
): TrackingEngine {
  return {
    begin: (): Promise<ObjectTrack> => {
      let step = 0;
      return Promise.resolve({
        advance: (): Promise<{ mask: CoverageMask; present: boolean }> => {
          const at = step++;
          const present = !absentAt.has(at);
          onAdvance?.(at);
          return Promise.resolve({ mask: mask(present ? 200 : 0), present });
        },
        dispose: (): void => {},
      });
    },
    dispose: (): void => {},
  };
}

function scene(frames: readonly number[]): TrackedScene & { dispose: () => void } {
  return {
    frames,
    understand: (): Promise<SceneEmbedding> => Promise.resolve({ dispose: (): void => {} }),
    dispose: (): void => {},
  };
}

function storeOver(
  document: SelectionDocument,
  frames: readonly number[],
  absentAt?: ReadonlySet<number>,
  onAdvance?: (at: number) => void,
): TrackingStore {
  return new TrackingStore(
    document,
    () => Promise.resolve(fakeEngine(absentAt, onAdvance)),
    () => Promise.resolve(scene(frames)),
  );
}

describe('a tracking run, from the interface side', () => {
  it('hands back what the run found', async () => {
    const document = new SelectionDocument();
    const store = storeOver(document, [4, 5, 6, 7], new Set([1]));

    const result = await store.track(4, [mask(255)]);

    expect(result).toEqual({ tracked: 3, absent: [1], lastFrame: 7, stopped: false });
    // The same fact in the two places it has to be in: a count for the sentence
    // that gets said, and a field on the command that outlives the session.
    expect(
      document.appliedCommands.map((command) =>
        command.kind === 'applyMask' ? (command.absent ?? false) : 'not a mask',
      ),
    ).toEqual([false, true, false]);
  });

  it('reports a stop as a result rather than as a failure', async () => {
    const document = new SelectionDocument();
    // Stopped part way through, which is what the button does: from inside the
    // run, because a stop asked for before the engine has even loaded is the
    // other case below and is not a run at all.
    let store: TrackingStore | undefined;
    store = storeOver(document, [0, 1, 2, 3, 4, 5, 6, 7], undefined, (at) => {
      if (at === 2) store?.stop();
    });

    const result = await store.track(0, [mask(255)]);

    expect(result?.stopped).toBe(true);
    expect(result?.tracked).toBe(3);
    // A stop is not a failure and must not leave the status saying it was one,
    // which is the whole reason this used to have to recognise an exception in
    // order to stay quiet about it.
    expect(store.status).toEqual({ kind: 'idle' });
    expect(store.running).toBe(false);
    // And what it found is still in the document.
    expect(document.appliedCommands.length).toBe(result?.tracked);
  });

  it('says nothing happened when nothing did', async () => {
    const document = new SelectionDocument();
    // One frame is the anchor and nothing else, so there is nothing ahead to
    // follow the object into. Over rather than failed, and nothing to report.
    expect(await storeOver(document, [9]).track(9, [mask(255)])).toBeUndefined();
    expect(await storeOver(document, [0, 1]).track(0, [])).toBeUndefined();

    const disposed = storeOver(document, [0, 1, 2]);
    disposed.dispose();
    expect(await disposed.track(0, [mask(255)])).toBeUndefined();
    expect(document.appliedCommands).toHaveLength(0);
  });

  it('says a failure is a failure, which a stop is not', async () => {
    const store = new TrackingStore(
      new SelectionDocument(),
      () => Promise.reject(new Error('The tracker could not be fetched.')),
      () => Promise.resolve(scene([0, 1, 2])),
    );

    expect(await store.track(0, [mask(255)])).toBeUndefined();
    expect(store.status).toEqual({ kind: 'failed', message: 'The tracker could not be fetched.' });
  });
});
