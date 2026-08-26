// The tracked-selection demo, taken by driving the real application.
//
//   pnpm dev --port 5180                     # in another shell
//   node tools/shots/tracked-clip.mjs
//
// This is the claim on the front of the README, moving: a selection that
// follows one person through a clip while the photograph around them stays the
// photograph. A still cannot show it and a description of it is worth nothing,
// so it is generated the same way the other media is, by driving the app.
//
// Real Chrome and headed, for the reason playwright.config.ts gives: bundled
// Chromium falls back to SwiftShader, which reports success while producing
// different pixels.
//
// Two people stand in one frame and one of them is drawn. The comparison is
// inside the shot, so nothing has to be said about what is being looked at.
//
// The clip is Tears of Steel, CC-BY 3.0, Blender Foundation, mango.blender.org.
// It stays in the ignored bench cache; only the generated media is committed.

import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const OUT = 'docs/media';
const FRAMES = '.shots-tracked';
const URL_BASE = process.env.ROTYL_URL ?? 'http://localhost:5180';
const CLIP = process.env.ROTYL_CLIP ?? '/tools/style-bench/real/evaluation/tos-occlusion.mp4';
const SOURCE = CLIP.replace(/^\//, '');
const VIEWPORT = { width: 1280, height: 760 };

// Where the walker is at frame 1, and the proposal that is the whole person
// rather than the print on her shirt.
const SUBJECT = process.env.ROTYL_SUBJECT ? process.env.ROTYL_SUBJECT.split(',').map(Number) : [0.42, 0.72];
const GROW = Number(process.env.ROTYL_GROW ?? 1);

if (!existsSync(SOURCE)) {
  throw new Error(`${SOURCE} is not here. Run ./tools/style-bench/fetch-evaluation.sh first.`);
}

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

// Chrome would open a native save dialog, which no script can answer. Without
// the picker the exporter takes its download branch, which is the same bytes by
// the route Safari and Firefox already use.
await page.addInitScript(() => {
  Reflect.deleteProperty(globalThis, 'showSaveFilePicker');
});

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(async (from) => {
  const bytes = await (await fetch(from)).arrayBuffer();
  const input = document.querySelector('input[type=file]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], from.split('/').pop(), { type: 'video/mp4' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, CLIP);
await page.locator('canvas').waitFor();
await page.waitForTimeout(1500);

// Segment the walker, then take the proposal that is all of her.
await page.getByRole('button', { name: 'Object', exact: true }).click();
const canvas = await page.locator('canvas').boundingBox();
if (!canvas) throw new Error('no canvas');
await page.mouse.click(canvas.x + canvas.width * SUBJECT[0], canvas.y + canvas.height * SUBJECT[1]);
await page.waitForTimeout(1200);
for (let i = 0; i < GROW; i++) {
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(1500);
}
// The proposal has to be the committed selection before tracking reads it.
// Seeding from a half-settled mask is what sends the track into the trees.
await page.waitForTimeout(2500);

// Tracking is minutes long, so the click that seeds it gets checked first.
// SELECT_ONLY writes the seeded frame and stops.
//
// Nothing is pressed between choosing the proposal and tracking it. Escape here
// cancels the proposal, and the preview goes on showing the one that was
// highlighted, so the sheet looks right while the track follows the smaller
// default and wanders off the subject.
await page.screenshot({ path: `${FRAMES}/seed.png` });
if (process.env.SELECT_ONLY) {
  await browser.close();
  console.log(`wrote ${FRAMES}/seed.png`);
  process.exit(0);
}

// Follow her through the clip. EdgeTAM runs on this machine, so this is the
// slow part and there is no network in it.
console.log('tracking the walker through the clip');
await page.getByRole('button', { name: 'Track', exact: true }).click();
await page.waitForFunction(() => !document.body.textContent?.includes('Tracking, frame'), null, {
  timeout: 15 * 60 * 1000,
  polling: 1000,
});
await page.waitForTimeout(800);

// Let the app write the clip. This is its own export path, so what lands here
// is what a user gets, without the editor's selection outline over it.
console.log('exporting the clip');
const download = await (async () => {
  const wait = page.waitForEvent('download', { timeout: 20 * 60 * 1000 });
  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  return wait;
})();
const exported = `${FRAMES}/export.mp4`;
await download.saveAs(exported);
await browser.close();

if (!existsSync(exported)) throw new Error('the app did not write a clip');

const mp4 = `${OUT}/tracked-clip.mp4`;
execFileSync('ffmpeg', [
  '-y',
  '-v',
  'error',
  '-i',
  exported,
  '-vf',
  'scale=1000:-2:flags=lanczos,format=yuv420p',
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  '20',
  '-movflags',
  '+faststart',
  mp4,
]);

// A GIF as well, because a repository path is the only place GitHub will play
// something without a click, and the README is where this has to land.
const gif = `${OUT}/tracked-clip.gif`;
const palette = `${FRAMES}/palette.png`;
// Photographic frames are heavy in a 256-colour format, so the GIF is a window
// on the clip rather than all of it. The MP4 above is the whole thing.
const GIF_FROM = '0.8';
const GIF_SECONDS = '3.0';
const gifFilters = 'fps=10,scale=480:-2:flags=lanczos';
execFileSync('ffmpeg', [
  '-y',
  '-v',
  'error',
  '-ss',
  GIF_FROM,
  '-t',
  GIF_SECONDS,
  '-i',
  mp4,
  '-vf',
  `${gifFilters},palettegen=max_colors=64`,
  palette,
]);
execFileSync('ffmpeg', [
  '-y',
  '-v',
  'error',
  '-ss',
  GIF_FROM,
  '-t',
  GIF_SECONDS,
  '-i',
  mp4,
  '-i',
  palette,
  '-lavfi',
  `${gifFilters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
  gif,
]);

rmSync(FRAMES, { recursive: true, force: true });
const sizes = execFileSync('du', ['-k', mp4, gif], { encoding: 'utf8' }).trim();
console.log(sizes);
console.log(`wrote ${mp4} and ${gif}`);
