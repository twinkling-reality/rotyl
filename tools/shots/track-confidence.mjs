// Per-frame tracker confidence on the clip that drifts, so a threshold can be
// chosen from the data rather than guessed.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const URL_BASE = process.env.ROTYL_URL ?? 'http://localhost:5181';
const CLIP = process.env.ROTYL_CLIP ?? '/tools/style-bench/real/evaluation/tos-crossing.mp4';
// A fraction of the clip, not of the canvas. The vertical was 0.455 while it was
// read against the canvas, which on a 534-tall clip letterboxed inside a
// 664-tall canvas is the same point as 0.444 of the clip.
const SUBJECT = (process.env.ROTYL_SUBJECT ?? '0.356,0.444').split(',').map(Number);
const GROW = Number(process.env.ROTYL_GROW ?? 1);

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
await page.addInitScript(() => {
  Reflect.deleteProperty(globalThis, 'showSaveFilePicker');
});
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(async (from) => {
  const bytes = await (await fetch(from)).arrayBuffer();
  const input = document.querySelector('input[type=file]');
  const t = new DataTransfer();
  t.items.add(new File([bytes], from.split('/').pop(), { type: 'video/mp4' }));
  input.files = t.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, CLIP);
await page.locator('canvas').waitFor();
await page.waitForTimeout(1500);

// Seeding somewhere other than the first frame separates two explanations for
// a lost track: a model that cannot hold a subject through a large change of
// scale, and one that cannot represent the subject at the size it ends up.
const startFrame = Number(process.env.ROTYL_START_FRAME ?? 0);
if (startFrame > 0) {
  await page.getByRole('slider', { name: 'Frame' }).fill(String(startFrame));
  await page.waitForTimeout(2500);
}

// Seeding is a click on a frame that has to have decoded first, and a click on
// a frame that has not is a click on nothing. Track staying disabled is how
// that shows, so it is retried rather than left to fail minutes later.
const box = await page.locator('canvas').boundingBox();

// SUBJECT is a fraction of the clip, and the canvas is the whole viewport with
// the clip fitted inside it. Landscape footage all but fills the canvas so the
// two agree; a portrait clip here is letterboxed by 450 pixels a side, and a
// seed meant for the middle of the subject lands on the floor beside it.
const shape = await page.evaluate(() => {
  const found = /(\d+)\s*×\s*(\d+)/.exec(document.body.textContent ?? '');
  return found ? { width: Number(found[1]), height: Number(found[2]) } : undefined;
});
if (!shape) throw new Error('the app did not say what shape the clip is');
const drawnWidth = Math.min(box.width, (box.height * shape.width) / shape.height);
const drawnHeight = Math.min(box.height, (box.width * shape.height) / shape.width);
const seedX = box.x + (box.width - drawnWidth) / 2 + drawnWidth * SUBJECT[0];
const seedY = box.y + (box.height - drawnHeight) / 2 + drawnHeight * SUBJECT[1];

const track = page.getByRole('button', { name: 'Track', exact: true });
for (let attempt = 0; attempt < 4; attempt++) {
  await page.getByRole('button', { name: 'Object', exact: true }).click();
  await page.mouse.click(seedX, seedY);
  await page.waitForTimeout(1400);
  for (let i = 0; i < GROW; i++) {
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(700);
  }
  if (await track.isEnabled()) break;
  if (attempt === 3) throw new Error('nothing was selected: Track never became available');
  await page.waitForTimeout(800);
}

const maskAt = (process.env.ROTYL_MASK_AT ?? '').split(',').filter(Boolean).map(Number);
await page.evaluate((frames) => {
  globalThis.rotylTrackLog = [];
  globalThis.rotylTrackMasks = [];
  globalThis.rotylTrackMaskAt = frames;
}, maskAt);
await track.click();
// Wait for it to START before waiting for it to stop, or the second wait is
// satisfied by tracking never having begun.
await page.waitForFunction(() => document.body.textContent?.includes('Tracking, frame'), null, {
  timeout: 60_000,
  polling: 200,
});
await page.waitForFunction(() => !document.body.textContent?.includes('Tracking, frame'), null, {
  timeout: 15 * 60 * 1000,
  polling: 1000,
});
// Exporting from the SAME run as the masks, because a mask from one run and a
// file from another cannot be compared: two runs of the tracker do not have to
// agree, and comparing across them is how this went wrong once already.
if (process.env.ROTYL_EXPORT) {
  const pending = page.waitForEvent('download', { timeout: 20 * 60 * 1000 });
  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  await (await pending).saveAs(process.env.ROTYL_EXPORT);
  console.log(`exported ${process.env.ROTYL_EXPORT}`);
}

const log = await page.evaluate(() => globalThis.rotylTrackLog ?? []);
const masks = await page.evaluate(() => globalThis.rotylTrackMasks ?? []);
if (masks.length > 0) {
  const side = Math.round(Math.sqrt(masks[0].bitmap.length));
  for (const { frame, bitmap } of masks) {
    // A plain PGM, so nothing has to be installed to look at it.
    const header = Buffer.from(`P5\n${side} ${side}\n255\n`, 'ascii');
    const body = Buffer.from(bitmap.map((on) => (on === 1 ? 255 : 0)));
    writeFileSync(
      `${process.env.MASK_DIR ?? '.'}/mask-${String(frame).padStart(4, '0')}.pgm`,
      Buffer.concat([header, body]),
    );
  }
  console.log(`masks written: ${masks.length} at ${side}x${side}`);
}
await browser.close();
writeFileSync(process.env.OUT ?? 'drift.json', JSON.stringify(log));
console.log(`frames logged: ${log.length}`);
