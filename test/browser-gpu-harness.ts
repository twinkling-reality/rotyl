import { gpuHarness, readTextureRgba, writeTextureRgba } from './gpu-harness-base.ts';

/**
 * Real WGSL execution in the same installed Chrome that runs the application.
 * The browser owns Dawn's process lifetime, so Vitest cannot tear it down
 * between files while native GPU work is still unwinding.
 */
const harness = gpuHarness(() => navigator.gpu);

export const { testDevice, disposeWithTestDevice, disposeTestGpu } = harness;
export { readTextureRgba, writeTextureRgba };
