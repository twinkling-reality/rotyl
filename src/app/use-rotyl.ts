import { useEffect, useRef, useState } from 'preact/hooks';
import { acquireRenderDevice, watchDevice, type UnsupportedReason } from '../core/gpu/render-device.ts';
import { SelectionDocument } from '../core/document/selection-document.ts';
import { RotylEngine } from '../core/render/rotyl-engine.ts';
import { PerceptionStore } from '../core/perception/perception-store.ts';
import { loadEdgeTamEngine } from '../platform/perception/edgetam-engine.ts';

/** sRGB value of --surface-sunken, the ground the image sits on. */
const VIEWPORT_BACKGROUND = [0.9412, 0.9412, 0.9412] as const;

/**
 * How many times in quick succession a session will rebuild itself before
 * giving up.
 *
 * A driver that resets once is an event; a driver that resets three times
 * within a minute is a driver that is going to keep doing it, and rebuilding
 * into that forever is worse than saying so. The window matters as much as the
 * count: three losses over an afternoon of real work are three events, and
 * counting them together would eventually refuse to recover a session that has
 * been recovering perfectly well.
 */
const MAX_RECOVERIES = 3;
const RECOVERY_WINDOW_MS = 60_000;

export interface RotylRuntime {
  readonly engine: RotylEngine;
  /**
   * What the system understands about the frame, as opposed to what it draws.
   *
   * Constructed alongside the engine but costing nothing until it is used: the
   * model, and the inference runtime it needs, are fetched on first demand.
   */
  readonly perception: PerceptionStore;
  readonly device: GPUDevice;
  readonly maxTextureDimension: number;
  readonly canvasFormat: GPUTextureFormat;
  /**
   * Increments every time these objects were rebuilt on a new device.
   *
   * The host watches it to know its uploaded image is gone: the command log
   * survives a lost device and the pixels do not.
   */
  readonly generation: number;
}

export type RuntimeState =
  /** Rebuilding after a lost device. The runtime is the dead one; do not draw with it. */
  | { readonly status: 'ready'; readonly runtime: RotylRuntime; readonly recovering: boolean }
  | { readonly status: 'starting' }
  | { readonly status: 'unsupported'; readonly reason: UnsupportedReason }
  | { readonly status: 'lost' };

declare global {
  /**
   * A handle for the console, and for the test that forces a device loss.
   *
   * `import.meta.env.DEV` is a compile-time constant, so both the assignment
   * below and this declaration's only writer vanish from a production build.
   */
  // eslint-disable-next-line no-var
  var rotyl: RotylRuntime | undefined;
}

/**
 * Bring up the GPU device and the engine, and bring them up again if the device
 * is lost.
 *
 * The engine deliberately outlives every render: it holds textures measured in
 * hundreds of megabytes, and recreating it per commit would be catastrophic. It
 * is a ref rather than state for the same reason — nothing about it should
 * participate in reconciliation.
 *
 * THE DOCUMENT IS CREATED HERE, ONCE, and handed to each engine in turn. That
 * is the whole of what makes recovery cheap: a lost device costs the pixels,
 * which can be decoded again, and never the work, which is a list of commands
 * in ordinary memory. What this hook cannot do is put the image back — it does
 * not own the file — so it reports a new `generation` and the host re-uploads.
 */
export function useRotyl(): RuntimeState {
  const [state, setState] = useState<RuntimeState>({ status: 'starting' });
  const documentRef = useRef<SelectionDocument | undefined>(undefined);
  documentRef.current ??= new SelectionDocument();

  useEffect(() => {
    const document = documentRef.current ?? new SelectionDocument();
    let cancelled = false;
    let live: RotylRuntime | undefined;
    let release: (() => void) | undefined;
    let recoveries = 0;
    let lastRecovery = 0;

    const teardown = (): void => {
      live?.perception.dispose();
      live?.engine.dispose();
      live = undefined;
      // Releasing after disposal, and last: it destroys the device, which is
      // also what tells the watcher that this loss was ours.
      release?.();
      release = undefined;
    };

    const start = async (generation: number, view?: RotylEngine['view']): Promise<void> => {
      const result = await acquireRenderDevice(navigator.gpu);
      if (cancelled) return;

      if (!result.ok) {
        // A first failure is a browser that cannot run this at all; a later one
        // is hardware that has gone away mid-session, and those read very
        // differently to the person holding the machine.
        setState(generation === 0 ? { status: 'unsupported', reason: result.reason } : { status: 'lost' });
        return;
      }

      const { device, maxTextureDimension, supportsF16 } = result.value;
      const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
      const engine = new RotylEngine(
        document,
        device,
        maxTextureDimension,
        canvasFormat,
        VIEWPORT_BACKGROUND,
      );
      // Carried across so a rebuild does not also throw away where the user was
      // looking. The canvas element is never unmounted during one, so nothing
      // downstream refits over it.
      if (view) engine.setView(view);

      // Given Rotyl's device so the model's input tensor can be built where the
      // image already lives. The runtime declines to share a device and brings
      // up its own; see edgetam-engine for what that costs and what it does not.
      const perception = new PerceptionStore(document, (onProgress) =>
        loadEdgeTamEngine({ device, supportsF16, onProgress }),
      );

      const runtime: RotylRuntime = {
        engine,
        perception,
        device,
        maxTextureDimension,
        canvasFormat,
        generation,
      };
      live = runtime;
      release = watchDevice(device, () => {
        void recover();
      });
      if (import.meta.env.DEV) globalThis.rotyl = runtime;
      setState({ status: 'ready', runtime, recovering: false });
    };

    const recover = async (): Promise<void> => {
      const dying = live;
      if (cancelled || !dying) return;

      const now = Date.now();
      recoveries = now - lastRecovery > RECOVERY_WINDOW_MS ? 1 : recoveries + 1;
      lastRecovery = now;

      // Announced before anything is torn down, and still carrying the dead
      // runtime: the host pauses on it rather than unmounting the canvas, which
      // is what lets the new device reconfigure the same one.
      setState({ status: 'ready', runtime: dying, recovering: true });

      const view = dying.engine.view;
      const generation = dying.generation + 1;
      teardown();

      if (recoveries > MAX_RECOVERIES) {
        setState({ status: 'lost' });
        return;
      }
      await start(generation, view);
    };

    void start(0);

    return () => {
      cancelled = true;
      teardown();
      if (import.meta.env.DEV) globalThis.rotyl = undefined;
    };
  }, []);

  return state;
}
