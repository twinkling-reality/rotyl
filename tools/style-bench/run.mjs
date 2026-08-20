// Run the style benchmarks in real Chrome, write the JSON out, and write the
// pictures out so the look can be judged rather than only scored.
//
//   node tools/style-bench/run.mjs chain
//   node tools/style-bench/run.mjs all
//   node tools/style-bench/run.mjs motion    # its own file; needs traffic-720p
//
// Headed, and channel:'chrome', for the reason playwright.config.ts gives:
// bundled Chromium falls back to SwiftShader, which reports success while
// producing different pixels and entirely different timings.
//
// Needs the dev server on 5180 (pnpm dev --port 5180) and the inputs from
// make-clips.sh.

import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { encodePng } from './png.mjs';

const ALL = ['chain', 'perturbation', 'clips', 'stills', 'sweep', 'figures'];
// Needs fetch-real.sh to have been run; kept out of `all` so the offline
// benchmarks stay runnable without a network.
const REAL = ['real-chain', 'real-perturbation', 'real-clips', 'real-lightness', 'real-flicker'];
// The counter-metric, and the pictures that show what it is counting. Its own
// group and its own results file: it needs a clip the other two do not, it
// answers a question about a method rather than about a chain, and re-taking it
// must not re-date the tables the existing findings come from.
const MOTION = ['motion', 'motion-pictures', 'attribution'];

const args = process.argv.slice(2);
const named = { all: ALL, real: REAL, motion: MOTION };
const which = args.length === 1 && named[args[0]] ? named[args[0]] : args;
if (which.length === 0) {
  console.error(
    `usage: node tools/style-bench/run.mjs <all|real|motion|${[...ALL, ...REAL, ...MOTION].join('|')}>...`,
  );
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage();
page.on('pageerror', (error) => console.error(`  [page] ${error.message}`));

const url = process.env.ROTYL_URL ?? 'http://localhost:5180';
await page.goto(url, { waitUntil: 'domcontentloaded' });

// Vite pre-bundles a bare import the first time it sees one and reloads the
// page underneath whatever was running. Provoke that here, before anything is
// timed.
await page.evaluate(async () => import('mediabunny')).catch(() => undefined);
await page.goto(url, { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async (names) => {
  const bench = await import('/tools/style-bench/index.ts');
  return bench.run(names);
}, which);

// The figures the research pages carry are the one set that is COMMITTED: they
// are the evidence for an argument about a look, they are a few tens of
// kilobytes each, and one command regenerates them. WebP because a halftone is
// the worst case a lossy codec can be handed and even so it is a third of the
// PNG; cwebp ships with libwebp and is optional here, since a PNG left in place
// is a larger file rather than a missing one.
//
// MERGED INTO THE INDEX RATHER THAN OVERWRITING IT, because two groups produce
// figures now and each one owns its own. `all` draws the styles and the
// palettes off the still; `motion` draws the smear off a clip. A run of either
// that replaced the index wholesale would leave the research page linking a
// picture that is still on disk and no longer described, which the build turns
// into a caption for the wrong thing.
const figures = [result.figures, result['motion-pictures']].flatMap((set) => (Array.isArray(set) ? set : []));
delete result.figures;
delete result['motion-pictures'];
if (figures.length > 0) {
  mkdirSync('tools/style-bench/figures', { recursive: true });
  let index = [];
  try {
    index = JSON.parse(readFileSync('tools/style-bench/figures/index.json', 'utf8'));
  } catch {
    index = [];
  }
  const written = new Set(figures.map((figure) => figure.name));
  // What each tile is, written beside the pictures, so the caption on the
  // research page is composed from the figure rather than remembered about it.
  writeFileSync(
    'tools/style-bench/figures/index.json',
    `${JSON.stringify(
      [...index.filter((entry) => !written.has(entry.name)), ...figures.map(described)],
      null,
      2,
    )}\n`,
  );
  for (const figure of figures) {
    const png = `tools/style-bench/figures/${figure.name}.png`;
    writeFileSync(png, encodePng(Buffer.from(figure.rgb, 'base64'), figure.width, figure.height));
    try {
      execFileSync('cwebp', ['-quiet', '-q', '84', png, '-o', png.replace(/\.png$/, '.webp')]);
      rmSync(png);
      console.log(`  ${png.replace(/\.png$/, '.webp')}  [${figure.tiles.join(' | ')}]`);
    } catch {
      console.log(`  ${png}  (cwebp not found, left as PNG)  [${figure.tiles.join(' | ')}]`);
    }
  }
}

// Pictures out, so the look can be judged rather than only scored.
for (const key of ['stills', 'sweep', 'real-flicker']) {
  const images = result[key];
  delete result[key];
  if (!Array.isArray(images)) continue;
  mkdirSync('tools/style-bench/out', { recursive: true });
  for (const image of images) {
    const file = `tools/style-bench/out/${image.name.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    writeFileSync(file, encodePng(Buffer.from(image.rgb, 'base64'), image.width, image.height));
    console.log(`  ${file}${image.labels ? `  [${image.labels.join(' | ')}]` : ''}`);
  }
}

const json = JSON.stringify(result, null, 2);
console.log(json);
const out = `tools/style-bench/results${
  which === ALL ? '' : which === REAL ? '-real' : which === MOTION ? '-motion' : `-${which.join('-')}`
}.json`;
writeFileSync(out, `${json}\n`);
console.log(`\nwritten to ${out}`);

await browser.close();
