import { useEffect, useRef, useState } from 'preact/hooks';
import { acquireRenderDevice, onDeviceLost, type UnsupportedReason } from '../core/gpu/render-device.ts';
import { RotylEngine } from '../core/render/rotyl-engine.ts';

/** sRGB value of --surface-sunken, the ground the image sits on. */
const VIEWPORT_BACKGROUND = [0.9412, 0.9412, 0.9412] as const;

export interface RotylRuntime {
  readonly engine: RotylEngine;
  readonly device: GPUDevice;
  readonly maxTextureDimension: number;
  readonly canvasFormat: GPUTextureFormat;
}

export type RuntimeState =
  | { readonly status: 'starting' }
  | { readonly status: 'ready'; readonly runtime: RotylRuntime }
  | { readonly status: 'unsupported'; readonly reason: UnsupportedReason }
  | { readonly status: 'lost' };

/**
 * Bring up the GPU device and the engine, once.
 *
 * The engine deliberately outlives every render: it holds textures measured in
 * hundreds of megabytes, and recreating it per commit would be catastrophic.
 * It is a ref rather than state for the same reason — nothing about it should
 * participate in reconciliation.
 */
export function useRotyl(): RuntimeState {
  const [state, setState] = useState<RuntimeState>({ status: 'starting' });
  const runtimeRef = useRef<RotylRuntime | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await acquireRenderDevice(navigator.gpu);
      if (cancelled) return;

      if (!result.ok) {
        setState({ status: 'unsupported', reason: result.reason });
        return;
      }

      const { device, maxTextureDimension } = result.value;
      const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
      const engine = new RotylEngine(device, maxTextureDimension, canvasFormat, VIEWPORT_BACKGROUND);

      const runtime: RotylRuntime = { engine, device, maxTextureDimension, canvasFormat };
      runtimeRef.current = runtime;

      // A lost device invalidates every GPU object. Recovery would mean a new
      // adapter, a rebuilt engine and a replay of the command log; until that
      // is built, say so plainly rather than leaving a dead canvas on screen.
      onDeviceLost(device, () => {
        setState({ status: 'lost' });
      });

      setState({ status: 'ready', runtime });
    })();

    return () => {
      cancelled = true;
      runtimeRef.current?.engine.dispose();
      runtimeRef.current = undefined;
    };
  }, []);

  return state;
}
