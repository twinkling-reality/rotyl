import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { TrackingStore, type TrackingStatus } from '../core/perception/tracking-store.ts';
import { seedsFrom } from '../core/perception/tracking-seeds.ts';
import { trackingHost } from '../platform/perception/tracking-host.ts';
import type { TrackingResult } from '../core/perception/tracking-job.ts';
import type { RotylRuntime } from './use-rotyl.ts';

/**
 * A tracking run, from the interface's side.
 *
 * The store is the run; this is its lifetime. It exists as a hook rather than
 * as more of `App` because everything here is bookkeeping about when a store
 * has to be thrown away, which is on three separate events: the file changes,
 * the device is rebuilt, or the session ends. A run in flight when any of those
 * happens is stopped, and what it had already found is already in the document.
 *
 * NOTHING IS BUILT UNTIL IT IS ASKED FOR. The two graphs are nineteen megabytes
 * and the tracker's module pulls in the inference runtime, so both are behind
 * the first press of Track. What is decided earlier, and cheaply, is whether
 * the button exists at all: with no host configured there is nowhere to fetch
 * them from and the only honest interface is one that does not offer it.
 */

export interface TrackingHandle {
  /** Whether there is anything to offer: a clip, and somewhere to fetch from. */
  readonly available: boolean;
  readonly status: TrackingStatus;
  readonly running: boolean;
  /** Follow what is selected on `frame` forward through the rest of the clip. */
  readonly track: (frame: number) => void;
  readonly stop: () => void;
}

export interface TrackingOptions {
  readonly runtime: RotylRuntime | undefined;
  /** The open video, or undefined for a photograph or nothing. */
  readonly file: File | undefined;
  /**
   * What the run found, once it is over. Not called when there was no run.
   *
   * The status line says what is HAPPENING and takes itself down when it stops;
   * this is what happened, which is the other line and the other lifetime. It
   * is the same split a clip export already makes, and for the same reason: a
   * run that followed the object through two hundred frames and lost it behind
   * a lorry for forty of them looks exactly like one that did not.
   */
  readonly onFinished?: (result: TrackingResult) => void;
}

export function useTracking({ runtime, file, onFinished }: TrackingOptions): TrackingHandle {
  const [status, setStatus] = useState<TrackingStatus>({ kind: 'idle' });
  const [running, setRunning] = useState(false);
  const storeRef = useRef<TrackingStore | undefined>(undefined);
  const host = trackingHost();
  // Through a ref, because the store is built in an effect keyed on the file
  // and the runtime. A callback in that dependency list would throw away the
  // tracker and its nineteen megabytes every time App re-rendered.
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    if (!runtime || !file || !host) {
      storeRef.current?.dispose();
      storeRef.current = undefined;
      setStatus({ kind: 'idle' });
      setRunning(false);
      return undefined;
    }

    const store = new TrackingStore(
      runtime.engine.document,
      async (onProgress) => {
        const { loadEdgeTamTracker } = await import('../platform/perception/edgetam-tracker.ts');
        return loadEdgeTamTracker({ host, onProgress });
      },
      async (from) => {
        // A SECOND DECODER OVER THE SAME FILE, which is what `VideoScene`
        // documents and requires. The playhead's provider supersedes whatever
        // is in flight when a newer request arrives, which is exactly right for
        // a pointer being dragged along a timeline and exactly wrong for two
        // readers: each would cancel the other and neither would be wrong.
        const [{ FrameProvider }, { VideoScene }] = await Promise.all([
          import('../platform/video/frame-provider.ts'),
          import('../platform/perception/video-scene.ts'),
        ]);
        const opened = await FrameProvider.open(file, runtime.maxTextureDimension);
        if (!opened.ok) throw new Error('Tracking could not open a second reader for this clip.');
        // Borrowed from the perception store, which owns it: a run reads each
        // frame with the same vision encoder a click is answered by, so
        // tracking costs no second download and no second copy in memory.
        const engine = await runtime.perception.segmentationEngine();
        return new VideoScene({ device: runtime.device, engine, provider: opened.value, from });
      },
    );
    storeRef.current = store;

    const unsubscribe = store.subscribe(() => {
      setStatus(store.status);
      setRunning(store.running);
    });
    return () => {
      unsubscribe();
      store.dispose();
      storeRef.current = undefined;
      setStatus({ kind: 'idle' });
      setRunning(false);
    };
  }, [runtime, file, host]);

  const track = useCallback(
    (frame: number): void => {
      const store = storeRef.current;
      if (!runtime || !store || store.running) return;
      setRunning(true);
      void (async () => {
        // What gets followed is the answer rather than the question: the
        // selection as it stands on this frame, clicks, chosen reading,
        // brushwork and all.
        const coverage = await runtime.engine.readSelection();
        if (!coverage) {
          setRunning(false);
          return;
        }
        // AND IT IS FOLLOWED AS THE SEVERAL THINGS IT IS, which is the whole of
        // what this line had to change for multi-object tracking to be
        // reachable. `runTracking` has taken a list since it landed; the reason
        // one was passed is that nobody had noticed the log already says which
        // objects somebody pointed at. It does: a fresh prompt writes its own
        // `applyMask` and a refinement replaces one. See `tracking-seeds.ts`.
        const result = await store.track(frame, seedsFrom(coverage, runtime.engine.frameCommands));
        setRunning(store.running);
        // AND ONLY IF THIS IS STILL THE RUN THE SESSION IS HAVING. Closing the
        // file disposes the store, which aborts the run, which resolves this a
        // frame later with a perfectly good result about a clip that is no
        // longer open. Reported, that is a sentence about somebody else's work
        // arriving over whatever they opened next.
        if (result && storeRef.current === store) finished.current?.(result);
      })();
    },
    [runtime],
  );

  const stop = useCallback((): void => {
    storeRef.current?.stop();
  }, []);

  return { available: Boolean(host && file), status, running, track, stop };
}
