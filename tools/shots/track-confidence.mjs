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
