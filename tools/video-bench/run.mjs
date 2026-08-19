// Run the benchmarks in real Chrome and write the JSON out.
//
//   node tools/video-bench/run.mjs decode colour
//   node tools/video-bench/run.mjs all
//   node tools/video-bench/run.mjs log     # its own file; see APART below
//   node tools/video-bench/run.mjs tracked-frame   # needs VITE_TRACKING_HOST
//
// Headed, and channel:'chrome', for the same reason playwright.config.ts uses
// them: bundled Chromium falls back to SwiftShader, which reports success while
// producing different pixels and entirely different timings. A benchmark that
// silently measures a CPU rasteriser is worse than no benchmark.
//
// Needs the dev server on 5180 (pnpm dev --port 5180) and the clips from
// make-clips.sh.

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * Kept out of `all`, and out of the file `all` writes, each for its own reason.
 *
 * `log` shares nothing with the rest: no GPU, no clips, nothing to fetch, and
 * running it inside the same run would re-date every decode and encode figure
 * beside it for a measurement about a data structure.
 *
 * `tracked-frame` needs a dev server started with VITE_TRACKING_HOST pointing
 * at the two graphs `tools/edgetam-export` produces, which most machines will
 * not have. In `all` it would leave an error where every other number is.
 */
const APART = ['log', 'tracked-frame'];

const ALL = [
  'readback',
  'ort-device',
  'attention',
  'bank-rampup',
  'half-precision',
  'decode',
  'colour',
  'encode',
  'encode-colour',
  'shared-device',
];

const args = process.argv.slice(2);
const which = args.length === 1 && args[0] === 'all' ? ALL : args;
if (which.length === 0) {
  console.error(`usage: node tools/video-bench/run.mjs <all|${[...ALL, ...APART].join('|')}>...`);
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage();
page.on('pageerror', (error) => console.error(`  [page] ${error.message}`));

const url = process.env.ROTYL_URL ?? 'http://localhost:5180';
await page.goto(url, { waitUntil: 'domcontentloaded' });

// Vite pre-bundles a bare import the first time it sees one and reloads the page
// underneath whatever was running. Provoke that here, before anything is timed.
await page
  .evaluate(async () => {
    await Promise.all([import('mediabunny'), import('onnxruntime-web/webgpu')]);
  })
  .catch(() => undefined);
await page.goto(url, { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async (names) => {
  const bench = await import('/tools/video-bench/index.ts');
  return bench.run(names);
}, which);

const json = JSON.stringify(result, null, 2);
console.log(json);
const out = `tools/video-bench/results${which === ALL ? '' : `-${which.join('-')}`}.json`;
writeFileSync(out, `${json}\n`);
console.log(`\nwritten to ${out}`);

await browser.close();
