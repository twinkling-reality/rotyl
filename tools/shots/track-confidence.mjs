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

await page.getByRole('button', { name: 'Object', exact: true }).click();
const box = await page.locator('canvas').boundingBox();
await page.mouse.click(box.x + box.width * SUBJECT[0], box.y + box.height * SUBJECT[1]);
await page.waitForTimeout(1200);
for (let i = 0; i < GROW; i++) {
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(600);
}

await page.evaluate(() => {
  globalThis.rotylTrackLog = [];
});
await page.getByRole('button', { name: 'Track', exact: true }).click();
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
await browser.close();
writeFileSync(process.env.OUT ?? 'drift.json', JSON.stringify(log));
console.log(`frames logged: ${log.length}`);
