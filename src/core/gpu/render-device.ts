/**
 * Device acquisition and loss handling.
 *
 * Takes a `GPU` rather than reaching for `navigator.gpu`, which is what lets
 * the entire renderer run under Dawn in Node and be unit-tested against real
 * WGSL execution with no browser and no mocks.
 */

export type UnsupportedReason = 'no-webgpu' | 'no-adapter' | 'no-device';

export interface RenderDevice {
  readonly device: GPUDevice;
  /** Largest texture edge this device will allocate; caps OUTPUT resolution. */
  readonly maxTextureDimension: number;
  /**
   * Whether this hardware can compile half-precision shaders.
   *
   * Read from the adapter and deliberately not requested on the device: nothing
   * in the renderer uses half precision, and asking for a feature in order to
   * answer a question about it is how unused capability accumulates. It is
   * reported because the segmentation runtime brings up its own device from the
   * same hardware, and which build of the model is worth downloading — half the
   * size, and unable to compile without this — follows from it.
   */
  readonly supportsF16: boolean;
}

export type DeviceResult =
  | { readonly ok: true; readonly value: RenderDevice }
  | { readonly ok: false; readonly reason: UnsupportedReason };

/**
 * Acquire a device.
 *
 * `maxTextureDimension2D` defaults to 8192 even on adapters that report 16384,
 * so it is requested explicitly. Without this a 9000 px photograph fails to
 * allocate on hardware that is perfectly capable of holding it.
 */
export async function acquireRenderDevice(gpu: GPU | undefined): Promise<DeviceResult> {
  if (!gpu) return { ok: false, reason: 'no-webgpu' };

  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { ok: false, reason: 'no-adapter' };

  const maxTextureDimension = adapter.limits.maxTextureDimension2D;
  const supportsF16 = adapter.features.has('shader-f16');
  try {
    const device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: maxTextureDimension },
    });
    return { ok: true, value: { device, maxTextureDimension, supportsF16 } };
  } catch {
    return { ok: false, reason: 'no-device' };
  }
}

/**
 * Run `onLost` when the device is lost for a reason that is not our own
 * teardown.
 *
 * Recovering from `'destroyed'` would fight the caller's own disposal and loop
 * forever, so that case is deliberately ignored.
 *
 * NOT IMPLEMENTED: automatic recovery. The app currently asks for a reload. The
 * pieces for something better are in place — the selection command log is
 * authoritative, so recovery would be rebuild resources, re-decode the source,
 * replay the log — but none of that is written, and an unimplemented recovery
 * path described as if it existed is worse than none.
 *
 * When it is written, it must restart from `requestAdapter`: an adapter can
 * only ever produce one device, so holding the old adapter is useless.
 */
export function onDeviceLost(device: GPUDevice, onLost: (reason: string) => void): void {
  void device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    onLost(info.reason || 'unknown');
  });
}
