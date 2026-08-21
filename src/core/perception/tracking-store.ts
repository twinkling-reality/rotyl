import { runTracking, type StopSignal, type TrackedScene, type TrackingResult } from './tracking-job.ts';
import type { CoverageMask } from '../document/coverage-mask.ts';
import type { SelectionDocument } from '../document/selection-document.ts';
import type { TrackingEngine } from './tracking-engine.ts';

/**
 * A tracking run, as something the interface can watch and stop.
 *
 * `runTracking` is the loop and knows nothing about being watched: it takes a
 * scene, an engine and a list of seeds, and returns when it has walked to the
 * end of the clip. Everything around that is what this holds. Which is the same
 * split `PerceptionStore` makes for object selection, for the same reasons:
 * loading the model on first use rather than on load, keeping one status
 * somebody can render, and being the single place that knows whether anything
 * is in flight.
 *
 * IT IS NOT A SECOND PERCEPTION STORE, and the difference is worth saying.
 * That one answers questions about the frame on screen and its answers are
 * immediate. This one runs for half a minute over frames nobody is looking at,
 * and the only thing the user does while it runs is watch it or stop it.
 *
 * WHAT IT DOES NOT DO IS TOUCH A MASK TEXTURE. Every frame it reaches becomes
 * an ordinary undoable command, in one group, exactly as a click does.
 */

export type TrackingStatus =
  | { readonly kind: 'idle' }
  /** Fetching the two graphs, which is nineteen megabytes and happens once. */
  | { readonly kind: 'loading'; readonly progress: number }
  | { readonly kind: 'running'; readonly tracked: number; readonly total: number }
  | { readonly kind: 'failed'; readonly message: string };

/** Loads the tracker, reporting progress from 0 to 1 while it does. */
export type TrackerLoader = (onProgress: (progress: number) => void) => Promise<TrackingEngine>;

/**
 * Opens the frames a run walks, starting at `from`.
 *
 * A SEAM AND NOT A PARAMETER because what is behind it is a second decoder over
 * the same file, a texture of its own and a vision encoder, none of which core
 * is allowed to name. The scene is disposed by this store when the run ends,
 * however it ends.
 */
export type SceneOpener = (from: number) => Promise<TrackedScene & { dispose: () => void }>;

/**
 * A stop, as a value core is allowed to hold.
 *
 * `AbortController` is a DOM type, so it is not nameable here: the whole point
 * of `tracking-job.ts` taking a structural `StopSignal` is that this layer
 * compiles under a config with no `dom` lib. One mutable boolean is the whole
 * of what a stop is anyway, and the check happens once per frame.
 */
interface Stop extends StopSignal {
  aborted: boolean;
}

export class TrackingStore {
  readonly #document: SelectionDocument;
  readonly #load: TrackerLoader;
  readonly #openScene: SceneOpener;
  readonly #listeners = new Set<() => void>();

  #engine: TrackingEngine | undefined;
  #loading: Promise<TrackingEngine> | undefined;
  #status: TrackingStatus = { kind: 'idle' };
  #stop: Stop | undefined;
  #disposed = false;

  constructor(document: SelectionDocument, load: TrackerLoader, openScene: SceneOpener) {
    this.#document = document;
    this.#load = load;
    this.#openScene = openScene;
  }

  get status(): TrackingStatus {
    return this.#status;
  }

  /** Whether a run is in flight, which is what turns Track into Stop. */
  get running(): boolean {
    return this.#stop !== undefined;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Follow the seeds forward from the frame they were made on.
   *
   * Resolves when the run is over, whether it reached the end of the clip or
   * was stopped. It does not reject on either, because neither is a failure:
   * stopping is a button somebody pressed, and finishing is what it was for.
   *
   * AND IT HANDS BACK WHAT THE RUN FOUND, which for most of this file's life it
   * did not: `runTracking` has always returned how many frames it reached and
   * how many of those the model said the object was not in, and this method
   * awaited it and returned nothing. Undefined means there was no run rather
   * than a run with nothing to report: disposed, already running, or a clip
   * with nothing ahead of the anchor.
   */
  async track(from: number, seeds: readonly CoverageMask[]): Promise<TrackingResult | undefined> {
    if (this.#stop || this.#disposed) return undefined;
    if (seeds.length === 0) return undefined;

    const stop: Stop = { aborted: false };
    this.#stop = stop;

    let scene: (TrackedScene & { dispose: () => void }) | undefined;
    try {
      const engine = await this.#ensureEngine();
      if (stop.aborted || this.#disposed) return undefined;

      scene = await this.#openScene(from);
      // One frame is the anchor and nothing else, so there is nothing ahead to
      // follow the object into. Over rather than failed: it is what tracking
      // from the last frame of a clip means.
      if (scene.frames.length < 2) return undefined;

      this.#setStatus({ kind: 'running', tracked: 0, total: scene.frames.length - 1 });
      return await runTracking({
        scene,
        engine,
        document: this.#document,
        seeds,
        onProgress: (tracked, total) => {
          this.#setStatus({ kind: 'running', tracked, total });
        },
        signal: stop,
      });
    } catch (cause) {
      // Only a failure reaches here now. Stopping used to as well, as an
      // exception this had to recognise in order to stay quiet about it, which
      // was the product arguing with a button it had just watched somebody
      // press. A stop is a field on the result instead.
      this.#setStatus({
        kind: 'failed',
        message: cause instanceof Error ? cause.message : 'Tracking is unavailable.',
      });
      return undefined;
    } finally {
      // Every way out lands here, including the two early returns above, which
      // is the point: a run that left `#stop` set would leave the button saying
      // Stop for the rest of the session.
      scene?.dispose();
      this.#stop = undefined;
      if (this.#status.kind !== 'failed') this.#setStatus({ kind: 'idle' });
    }
  }

  /** Ask the run to stop. What it has already found stays in the document. */
  stop(): void {
    if (this.#stop) this.#stop.aborted = true;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#stop) this.#stop.aborted = true;
    this.#stop = undefined;
    this.#engine?.dispose();
    this.#engine = undefined;
    this.#loading = undefined;
    this.#listeners.clear();
  }

  async #ensureEngine(): Promise<TrackingEngine> {
    if (this.#engine) return this.#engine;
    this.#loading ??= (async () => {
      this.#setStatus({ kind: 'loading', progress: 0 });
      const engine = await this.#load((progress) => {
        if (this.#status.kind === 'loading') this.#setStatus({ kind: 'loading', progress });
      });
      if (this.#disposed) {
        engine.dispose();
        throw new Error('TrackingStore: disposed while the tracker was loading');
      }
      this.#engine = engine;
      return engine;
    })();

    try {
      return await this.#loading;
    } catch (cause) {
      // Cleared so a later attempt retries rather than resolving the same
      // rejected promise for the rest of the session.
      this.#loading = undefined;
      throw cause;
    }
  }

  #setStatus(status: TrackingStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener();
  }
}
