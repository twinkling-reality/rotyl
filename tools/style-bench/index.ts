// The style benchmarks, as one entry point.
//
//   const bench = await import('/tools/style-bench/index.ts');
//   await bench.run(['chain']);
//
// or through run.mjs, which does the same in real Chrome and writes the JSON
// and the PNGs out. See the README for what each one answers.

import { adapterInfo, device } from '../video-bench/util.ts';
import { chain, realChain } from './chain.ts';
import { clips, perturbation, realClips, realPerturbation } from './stability.ts';
import { stills } from './stills.ts';
import { sweep } from './sweep.ts';
import { figures } from './figures.ts';
import { lightnessStats } from './lightness.ts';
import { flicker } from './flicker.ts';
import { motion, motionPictures } from './motion.ts';
import { attribution } from './attribution.ts';
import { animeEval } from './anime-eval.ts';
import { selectiveEval } from './selective-eval.ts';

export const MEASUREMENTS = [
  'chain',
  'perturbation',
  'clips',
  'stills',
  'sweep',
  'figures',
  // The same three, against inputs a camera produced. See fetch-real.sh, which
  // has to have been run first.
  'real-chain',
  'real-perturbation',
  'real-clips',
  'real-lightness',
  // Pictures rather than numbers: which pixels move, not how many.
  'real-flicker',
  // What a temporal method would cost, on a clip where things move against
  // things that do not. Its own name because it needs its own clip, and out of
  // `all` because it is the counter-metric rather than one of the six the
  // existing tables come from: re-taking it must not re-date them.
  'motion',
  'motion-pictures',
  // And where the residue comes from, which is the question the counter-metric
  // exists to let anybody answer honestly. Same clip, same group.
  'attribution',
  // Person-to-animation stills. Own name so it cannot re-date the tables above.
  'anime-eval',
  // Selective composites through the real compositor. Own name for the same reason.
  'anime-selective',
] as const;

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
  await step('figures', () => figures(dev));

  await step('real-chain', () => realChain(dev));
  await step('real-perturbation', () => realPerturbation(dev));
  await step('real-clips', () => realClips(dev));
  await step('real-lightness', () => lightnessStats());
  await step('real-flicker', () => flicker(dev));
  await step('motion', () => motion(dev));
  await step('motion-pictures', () => motionPictures(dev));
  await step('attribution', () => attribution(dev));
  await step('anime-eval', () => animeEval(dev));
  await step('anime-selective', () => selectiveEval(dev));

  if (failures.length > 0) out['gpu-errors'] = failures;
  dev.destroy();
  return out;
}
