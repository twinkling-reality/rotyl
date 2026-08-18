// Run the style benchmarks in real Chrome, write the JSON out, and write the
// pictures out so the look can be judged rather than only scored.
//
//   node tools/style-bench/run.mjs chain
//   node tools/style-bench/run.mjs all
//
// Headed, and channel:'chrome', for the reason playwright.config.ts gives:
// bundled Chromium falls back to SwiftShader, which reports success while
// producing different pixels and entirely different timings.
//
// Needs the dev server on 5180 (pnpm dev --port 5180) and the inputs from
// make-clips.sh.

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodePng } from './png.mjs';

const ALL = ['chain', 'perturbation', 'clips', 'stills', 'sweep'];

const args = process.argv.slice(2);
const which = args.length === 1 && args[0] === 'all' ? ALL : args;
if (which.length === 0) {
  console.error(`usage: node tools/style-bench/run.mjs <all|${ALL.join('|')}>...`);
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

// Pictures out, so the look can be judged rather than only scored.
for (const key of ['stills', 'sweep']) {
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
const out = `tools/style-bench/results${which === ALL ? '' : `-${which.join('-')}`}.json`;
writeFileSync(out, `${json}\n`);
console.log(`\nwritten to ${out}`);

await browser.close();
