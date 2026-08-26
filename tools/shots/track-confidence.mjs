// Per-frame tracker confidence on the clip that drifts, so a threshold can be
// chosen from the data rather than guessed.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const URL_BASE = process.env.ROTYL_URL ?? 'http://localhost:5181';
const CLIP = process.env.ROTYL_CLIP ?? '/tools/style-bench/real/evaluation/tos-crossing.mp4';
const SUBJECT = (process.env.ROTYL_SUBJECT ?? '0.356,0.455').split(',').map(Number);
const GROW = Number(process.env.ROTYL_GROW ?? 1);

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
await page.addInitScript(() => {
  Reflect.deleteProperty(globalThis, 'showSaveFilePicker');
});
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
// The editor restores the last document from its journal, and a restored one
// leaves no file input to load through. Close it first when that has happened.
const closer = page.getByRole('button', { name: 'Close file' });
if ((await closer.count()) > 0) {
  await closer.click();
  await page.waitForTimeout(1000);
  // Closing alone is not enough: the journal puts the document back. Reloading
  // after the close is what leaves the picker on screen.
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
}
await page.evaluate(async (from) => {
  const bytes = await (await fetch(from)).arrayBuffer();
  const input = document.querySelector('input[type=file]');
  if (!input) throw new Error('no file input: a document is still open');
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
const track = page.getByRole('button', { name: 'Track', exact: true });
for (let attempt = 0; attempt < 4; attempt++) {
  await page.getByRole('button', { name: 'Object', exact: true }).click();
  await page.mouse.click(box.x + box.width * SUBJECT[0], box.y + box.height * SUBJECT[1]);
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
  for (const { frame, packed } of masks) {
    const bytes = Buffer.from(packed, 'base64');
    const pixels = bytes.length * 8;
    const side = Math.round(Math.sqrt(pixels));
    const body = Buffer.alloc(pixels);
    for (let at = 0; at < pixels; at++) {
      body[at] = (bytes[at >> 3] & (128 >> (at & 7))) === 0 ? 0 : 255;
    }
    // A plain PGM, so nothing has to be installed to look at it.
    const header = Buffer.from(`P5\n${side} ${side}\n255\n`, 'ascii');
    writeFileSync(
      `${process.env.MASK_DIR ?? '.'}/mask-${String(frame).padStart(4, '0')}.pgm`,
      Buffer.concat([header, body]),
    );
  }
  console.log(`masks written: ${masks.length}`);
}
await browser.close();
writeFileSync(process.env.OUT ?? 'drift.json', JSON.stringify(log));
console.log(`frames logged: ${log.length}`);
