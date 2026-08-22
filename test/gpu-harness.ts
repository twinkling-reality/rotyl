import { create, globals } from 'webgpu';
import { gpuHarness, readTextureRgba, writeTextureRgba } from './gpu-harness-base.ts';

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

const harness = gpuHarness(() => create([]));

export const { testDevice, disposeWithTestDevice, disposeTestGpu } = harness;
export { readTextureRgba, writeTextureRgba };
