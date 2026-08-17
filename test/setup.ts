import { afterAll } from 'vitest';
import { disposeTestGpu } from './gpu-harness.ts';

/**
 * Release the GPU before the worker process exits.
 *
 * Dawn aborts if it is still working when the runner tears the worker down, so
 * this drains the queue and destroys the device explicitly rather than leaving
 * either to chance.
 */
afterAll(async () => {
  await disposeTestGpu();
});
