// The style benchmarks, as one entry point.
//
//   const bench = await import('/tools/style-bench/index.ts');
//   await bench.run(['chain']);
//
// or through run.mjs, which does the same in real Chrome and writes the JSON
// and the PNGs out. See the README for what each one answers.

import { adapterInfo, device } from '../video-bench/util.ts';
import { chain } from './chain.ts';
import { clips, perturbation } from './stability.ts';
import { stills } from './stills.ts';
import { sweep } from './sweep.ts';

export const MEASUREMENTS = ['chain', 'perturbation', 'clips', 'stills', 'sweep'] as const;

export type Measurement = (typeof MEASUREMENTS)[number];

export async function run(which: readonly string[]): Promise<unknown> {
  const dev = await device();
  const out: Record<string, unknown> = { adapter: await adapterInfo() };

  // WITHOUT THIS A BROKEN PASS IS INVISIBLE. A validation error kills the
  // submission and leaves the target texture holding whatever was in it, so a
  // style that fails to render reports the PREVIOUS style's pixels and every
  // number taken from it is a measurement of the wrong thing.
  const failures: string[] = [];
  dev.addEventListener('uncapturederror', (event) => {
    failures.push(event.error.message);
  });

  const step = async (name: Measurement, fn: () => Promise<unknown>): Promise<void> => {
    if (!which.includes(name)) return;
    const t0 = performance.now();
    try {
      out[name] = await fn();
    } catch (error) {
      // Reported rather than thrown: one measurement failing should not cost
      // the others, and the stack is the useful half.
      out[name] = { error: String(error), stack: error instanceof Error ? error.stack : undefined };
    }
    out[`${name}:wall-seconds`] = Math.round((performance.now() - t0) / 100) / 10;
  };

  await step('chain', () => chain(dev));
  await step('perturbation', () => perturbation(dev));
  await step('clips', () => clips(dev));
  await step('stills', () => stills(dev));
  await step('sweep', () => sweep(dev));

  if (failures.length > 0) out['gpu-errors'] = failures;
  dev.destroy();
  return out;
}
