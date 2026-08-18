import { create, globals } from 'webgpu';
import { acquireRenderDevice, type RenderDevice } from '../src/core/gpu/render-device.ts';

/**
 * Real WGSL execution in Node, via Dawn, the same engine Chrome uses.
 *
 * This is what makes each stage of the style chain independently testable:
 * shaders run for real, on real hardware, with no browser and no mocking of the
 * thing under test. It works only because `src/core` is DOM-free by
 * construction, which `tsconfig.core.json` enforces.
 *
 * TEARDOWN IS DELIBERATE AND ORDERED. Dawn aborts the process if it is still
 * working when the runner tears a worker down. After every assertion has
 * already passed, so it surfaces as an unexplained crash rather than a test
 * failure. `disposeTestGpu` therefore drains the queue first, then releases
 * objects built from the device, then the device itself, in that order.
 */

Object.assign(globalThis, globals);

let cached: Promise<RenderDevice> | undefined;
const cleanups: (() => void)[] = [];

export function testDevice(): Promise<RenderDevice> {
  cached ??= (async () => {
    const result = await acquireRenderDevice(create([]));
    if (!result.ok) throw new Error(`no GPU in test environment: ${result.reason}`);
    return result.value;
  })();
  return cached;
}

/**
 * Register a GPU resource that must be released before the device is.
 *
 * Ordering matters independently of the above: destroying a device while
 * pipelines and textures created from it are still alive is its own crash. Test
 * files holding GPU objects across cases register them here rather than relying
 * on hook ordering between a setup file and a suite.
 */
export function disposeWithTestDevice(dispose: () => void): void {
  cleanups.push(dispose);
}

/** Drain, release, and destroy, in that order. */
export async function disposeTestGpu(): Promise<void> {
  const pending = cached;
  cached = undefined;
  if (!pending) return;

  const { device } = await pending;
  // The step that actually matters: returning only once the GPU has no
  // outstanding work, so nothing is running when the worker process exits.
  await device.queue.onSubmittedWorkDone();

  for (const dispose of cleanups.splice(0)) dispose();
  device.destroy();
}

/**
 * Read a texture back as tightly-packed RGBA bytes.
 *
 * `bytesPerRow` must be a multiple of 256, and the final row is *not* padded,
 * so the buffer needs `bytesPerRow * (height - 1) + unpaddedRow`, not
 * `bytesPerRow * height`. Sizing it the intuitive way fails validation.
 */
export async function readTextureRgba(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const unpaddedBytesPerRow = width * 4;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const size = Math.ceil((bytesPerRow * (height - 1) + unpaddedBytesPerRow) / 4) * 4;

  const staging = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, { width, height });
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(staging.getMappedRange()).slice();
  staging.unmap();
  staging.destroy();

  const packed = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    packed.set(
      padded.subarray(y * bytesPerRow, y * bytesPerRow + unpaddedBytesPerRow),
      y * unpaddedBytesPerRow,
    );
  }
  return packed;
}

/** Upload tightly-packed RGBA bytes into a texture. */
export function writeTextureRgba(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  pixels: Uint8Array,
): void {
  device.queue.writeTexture(
    { texture },
    pixels,
    { bytesPerRow: width * 4, rowsPerImage: height },
    { width, height },
  );
}
