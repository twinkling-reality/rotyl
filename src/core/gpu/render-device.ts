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
 * Watch a device, and get back the way to give it up.
 *
 * `onLost` runs for a loss WE DID NOT CAUSE. The returned function destroys the
 * device and marks that as deliberate, which is the whole distinction: a device
 * torn down by the caller must not trigger a rebuild, or disposal and recovery
 * would fight each other forever. Reading `'destroyed'` from the reason cannot
 * make that distinction, because a device destroyed by something else is a
 * device we have genuinely lost and should recover from.
 *
 * Recovery itself is not here: it means a new device, rebuilt resources, a
 * re-decoded source and a replayed command log, and only the host knows where
 * those come from. What is here is the signal, and the guarantee that our own
 * teardown does not raise it.
 *
 * A rebuild must restart from `requestAdapter`: an adapter can only ever
 * produce one device, so holding the old adapter is useless.
 */
export function watchDevice(
  // Narrowed to what is actually touched, which is also what makes the rule
  // above checkable without a GPU.
  device: Pick<GPUDevice, 'lost' | 'destroy'>,
  onLost: (reason: string) => void,
): () => void {
  let released = false;

  void device.lost.then((info) => {
    if (released) return;
    onLost(info.reason || 'unknown');
  });

  return () => {
    released = true;
    device.destroy();
  };
}
