// Hosted illustrated stills, on the licensed evaluation set.
//
//   ./tools/style-bench/fetch-evaluation.sh
//   node tools/style-bench/illustrated-eval.mjs
//   FAL_KEY=... pnpm exec vite-node tools/style-bench/illustrated-eval.ts
//
// Without a key this rewrites the skipped result and does not claim a pass.
// A configured run still leaves publishReady false. That is a visual
// judgement on the sheets, not a JSON flag.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const set = JSON.parse(await readFile(join(here, 'evaluation-set.json'), 'utf8'));
const resultsPath = join(here, 'results-illustrated-eval.json');

if (process.env.FAL_KEY) {
  console.error('A configured run is pnpm exec vite-node tools/style-bench/illustrated-eval.ts');
  process.exit(2);
}

const skipped = {
  schema: 1,
  publishReady: false,
  path: 'PhotoMaker (Tencent ARC, Apache-2.0) on Fal, photomaker-style, img2img from this still',
  termsVersion: 'illustrated-v1',
  skipped: true,
  reason: 'FAL_KEY is not set. The visual bar has not been run.',
  stills: set.stills.map((still) => still.id),
};

await writeFile(resultsPath, `${JSON.stringify(skipped, null, 2)}\n`);
console.log('illustrated-eval: skipped, no FAL_KEY. Not publish-ready.');
