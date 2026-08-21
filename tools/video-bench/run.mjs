// Run the benchmarks in real Chrome and write the JSON out.
//
//   node tools/video-bench/run.mjs decode colour
//   node tools/video-bench/run.mjs all
//   node tools/video-bench/run.mjs log     # its own file; see APART below
//   node tools/video-bench/run.mjs document        # its own file; see APART below
//   node tools/video-bench/run.mjs occlusion       # its own file; see APART below
//   node tools/video-bench/run.mjs recovery        # its own file; see APART below
//   node tools/video-bench/run.mjs tracked-frame   # needs VITE_TRACKING_HOST
//   node tools/video-bench/run.mjs long-clip       # twenty minutes; see below
//   node tools/video-bench/run.mjs interleave      # its own file; see APART below
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
 * `document` is the same class and is kept apart from `log` as well as from
 * `all`: what a tracked run costs to HOLD and what it costs to WRITE are two
 * findings answered in two chapters, and folding them into one file would
 * re-date the first one every time the second is re-taken.
 *
 * `occlusion` is the same again and is kept out of `document` in particular
 * rather than only out of `all`. It asks what one more optional field on a
 * command costs, which is the same class of question and shares helpers with
 * it, and that is exactly why it must not share a file: measurement 12's
 * ten-minute write and read are quoted in three documents, and taken inside
 * that run this moved both of them by noise on a path it does not touch.
 *
 * `recovery` is the same again, one chapter further on. It writes tens of
 * megabytes into the origin private file system and cleans up after itself,
 * which is not a thing to have running in the middle of an export measurement.
 *
 * `tracked-frame` needs a dev server started with VITE_TRACKING_HOST pointing
 * at the two graphs `tools/edgetam-export` produces, which most machines will
 * not have. In `all` it would leave an error where every other number is.
 *
 * `long-clip` deliberately runs the tab out of memory, which is the measurement
 * rather than a hazard of it, and it takes twenty minutes where `all` takes
 * three. Neither belongs in the middle of a run with nine other measurements
 * still to take.
 *
 * `interleave` needs no GPU and answers a question about byte layout. Taking it
 * inside `all` would re-date every decode and encode figure beside it whenever
 * somebody asked where the sound goes.
 */
const APART = ['log', 'document', 'occlusion', 'recovery', 'tracked-frame', 'long-clip', 'interleave'];

/**
 * The export ladder, apart from `all` for a reason this file learned the hard
 * way.
 *
 * It is the only measurement in here that runs a STYLE CHAIN, so a change to a
 * style makes it stale and makes nothing else in `all` stale. Left in `all`,
 * re-taking it meant re-timing an ONNX session, four decode figures and a
 * readback ladder that had not moved, on a machine that stalls one run in
 * several: the diff was forty numbers of noise around the one that had actually
 * changed. `encode-colour` comes with it because it is the same pass and is a
 * probe rather than a timing.
 */
const EXPORT = ['encode', 'encode-colour'];

const ALL = [
  'readback',
  'ort-device',
  'attention',
  'bank-rampup',
  'half-precision',
  'decode',
  'colour',
  'shared-device',
];

const args = process.argv.slice(2);
const named = { all: ALL, export: EXPORT };
const which = args.length === 1 && named[args[0]] ? named[args[0]] : args;
if (which.length === 0) {
  console.error(
    `usage: node tools/video-bench/run.mjs <all|export|${[...ALL, ...EXPORT, ...APART].join('|')}>...`,
  );
  process.exit(1);
}

/**
 * A collectable heap, only where a measurement needs one.
 *
 * `long-clip` walks a ladder of exports, each holding a gigabyte or more, and
 * without a way to drop the last rung before the next one starts each rung
 * measures the one before it as well. Not passed otherwise: a browser told to
 * expose gc is not the browser anybody runs, and every other figure here is
 * taken in the one that is.
 */
const NEEDS_GC = which.includes('long-clip');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  ...(NEEDS_GC ? { args: ['--js-flags=--expose-gc'] } : {}),
});
const page = await browser.newPage();
page.on('pageerror', (error) => console.error(`  [page] ${error.message}`));

/**
 * What the page said before it stopped answering.
 *
 * A measurement that runs the tab out of memory takes its own return value with
 * it, and the checkpoints it logged on the way are then the only evidence of
 * how far it got. Kept for every run and written out only when the evaluate
 * fails, so nothing changes for the runs that finish.
 */
const checkpoints = [];
page.on('console', (message) => {
  const text = message.text();
  if (!text.startsWith('bench: ')) return;
  try {
    checkpoints.push(JSON.parse(text.slice(7)));
  } catch {
    checkpoints.push({ line: text.slice(7) });
  }
});

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

let result;
try {
  result = await page.evaluate(async (names) => {
    const bench = await import('/tools/video-bench/index.ts');
    return bench.run(names);
  }, which);
} catch (error) {
  // The page died rather than the measurement failing. That IS a result for
  // long-clip, so it is written out with everything the checkpoints saw rather
  // than lost to a stack trace on a terminal.
  result = {
    'the page stopped answering': String(error),
    checkpoints,
  };
}

const json = JSON.stringify(result, null, 2);
console.log(json);
const out = `tools/video-bench/results${
  which === ALL ? '' : which === EXPORT ? '-export' : `-${which.join('-')}`
}.json`;
writeFileSync(out, `${json}\n`);
console.log(`\nwritten to ${out}`);

await browser.close();
