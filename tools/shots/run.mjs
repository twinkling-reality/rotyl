// The pictures in the README, taken by driving the real application.
//
//   pnpm dev --port 5180                # in another shell
//   node tools/shots/run.mjs
//
// They exist because a README that describes a visual tool and shows none of it
// is asking to be taken on trust. They are GENERATED rather than captured by
// hand for the reason the research figures are: a binary artefact nobody can
// regenerate is a liability, and one that no longer matches the interface is
// worse than none.
//
// Real Chrome and headed, for the reason playwright.config.ts gives: bundled
// Chromium falls back to SwiftShader, which reports success while producing
// different pixels.
//
// The clip is the style bench's synthesised street scene rather than a
// photograph. Nothing here can ship a photograph, licensing aside, and the
// scene was built to have the statistics the style chain is sensitive to.

import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'docs/media';
const FRAMES = '.shots-frames';
const URL_BASE = process.env.ROTYL_URL ?? 'http://localhost:5180';
const CLIP = '/tools/style-bench/clips/pan-720p.mp4';
const SCENE = '/tools/style-bench/clips/scene.png';
const HERO_SOURCE = {
  file: 'tools/style-bench/real/portrait.jpg',
  path: '/tools/style-bench/real/portrait.jpg',
  name: 'photographer.jpg',
  sha256: '643d6477faf515340c758e140e0851247a4b02bffd7e899a8e1ab02c6638fb7b',
  url: 'https://upload.wikimedia.org/wikipedia/commons/4/4a/Photographer_in_close-up_%28Unsplash%29.jpg',
};

/** Big enough that the toolbar reads, small enough that a GIF stays sane. */
const VIEWPORT = { width: 1100, height: 660 };

/**
 * What the animated hero is allowed to cost.
 *
 * A repository whose entire argument is 50.7 KB gzipped cannot carry a
 * multi-megabyte screenshot, and a GIF is the only moving format GitHub renders
 * from a repository path. The real portrait needs 256 colours to remain a
 * photograph before the edit; its repeated frames still compress tightly.
 */
const GIF = { width: 680, frames: 32, colors: 256, fps: 11 };

mkdirSync(OUT, { recursive: true });
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

/**
 * The hero's source is fetched rather than committed. Its hash is the identity:
 * a changed file fails before the screenshot can quietly become another demo.
 */
async function prepareHeroSource() {
  mkdirSync('tools/style-bench/real', { recursive: true });
  if (!existsSync(HERO_SOURCE.file)) {
    console.log('source: photographer portrait, CC0');
    const response = await fetch(HERO_SOURCE.url, {
      headers: { 'User-Agent': 'rotyl-readme-shots' },
    });
    if (!response.ok) throw new Error(`source: ${String(response.status)} ${response.statusText}`);
    writeFileSync(HERO_SOURCE.file, new Uint8Array(await response.arrayBuffer()));
  }
  const digest = createHash('sha256').update(readFileSync(HERO_SOURCE.file)).digest('hex');
  if (digest !== HERO_SOURCE.sha256) {
    throw new Error(`source: expected ${HERO_SOURCE.sha256}, got ${digest}`);
  }
}

await prepareHeroSource();

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
page.on('pageerror', (error) => console.error(`  [page] ${error.message}`));

/** Hand the app a file the way a person does, from a URL it can already reach. */
async function open(path, name) {
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    async ([from, as]) => {
      const bytes = await (await fetch(from)).arrayBuffer();
      const input = document.querySelector('input[type=file]');
      const transfer = new DataTransfer();
      const type = as.endsWith('.mp4') ? 'video/mp4' : as.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
      transfer.items.add(new File([bytes], as, { type }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [path, name],
  );
  await page.locator('canvas').waitFor();
  await page.waitForTimeout(1200);
}

/** Drag the Area tool across the middle of the picture. */
async function selectArea(from, to) {
  await page.getByRole('button', { name: 'Area' }).click();
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

// --- the hero: one drag, two treatments, and an undo --------------------------
//
// A real portrait makes the style boundary legible in skin, cloth, glass,
// metal and a defocused landscape. The centre band cuts through the camera and
// both hands, so no crop can be mistaken for a before-and-after pair.
await open(HERO_SOURCE.path, HERO_SOURCE.name);

let heroFrame = 0;
async function captureHero() {
  await page.screenshot({ path: `${FRAMES}/${String(heroFrame).padStart(3, '0')}.png` });
  heroFrame += 1;
}
async function holdHero(frames) {
  for (let i = 0; i < frames; i++) {
    await captureHero();
    await page.waitForTimeout(90);
  }
}

console.log('hero: original, drag, Comic, Print, undo');
await holdHero(4);
await page.getByRole('button', { name: 'Area' }).click();
const heroCanvas = await page.locator('canvas').boundingBox();
if (!heroCanvas) throw new Error('hero: no canvas');
const from = [0.2, 0.06];
const to = [0.8, 0.96];
await page.mouse.move(heroCanvas.x + heroCanvas.width * from[0], heroCanvas.y + heroCanvas.height * from[1]);
await page.mouse.down();
for (let i = 1; i <= 8; i++) {
  const t = i / 8;
  await page.mouse.move(
    heroCanvas.x + heroCanvas.width * (from[0] + (to[0] - from[0]) * t),
    heroCanvas.y + heroCanvas.height * (from[1] + (to[1] - from[1]) * t),
  );
  await captureHero();
}
await page.mouse.up();
await page.locator('button[title="Undo"]:not([disabled])').waitFor();
await page.waitForTimeout(400);
await holdHero(5);

await page.getByRole('button', { name: 'Style' }).click();
await captureHero();
await page.getByRole('button', { name: 'Print' }).click();
await captureHero();
await page.getByRole('button', { name: 'Style' }).click();
await captureHero();
await holdHero(7);

await page.getByRole('button', { name: 'Undo' }).click();
await page.getByRole('button', { name: 'Object' }).click();
await page.waitForTimeout(300);
await holdHero(5);
if (heroFrame !== GIF.frames) {
  throw new Error(`hero: expected ${String(GIF.frames)} frames, captured ${String(heroFrame)}`);
}

// --- the stills --------------------------------------------------------------

console.log('stills: style panel, and the object picker');
await open(CLIP, 'street.mp4');
await selectArea([0.5, 0.02], [0.99, 0.98]);
await page.getByRole('button', { name: 'Style' }).click();
await page.getByRole('button', { name: 'Poster' }).click();
await page.getByRole('button', { name: 'Riso' }).click();
await page.getByRole('button', { name: 'Style' }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/video.png` });

await open(SCENE, 'street.png');
// Deliberately across the near car, so one object appears both ways at once.
await selectArea([0.18, 0.32], [0.62, 0.96]);
await page.getByRole('button', { name: 'Style' }).click();
await page.getByRole('button', { name: 'Mural' }).click();
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/styles.png` });

await browser.close();

// --- the GIF -----------------------------------------------------------------
//
// Two passes: one to build a palette from the whole sequence, one to apply it.
// A per-frame palette is what makes a stylised GIF crawl, which would be an
// unfair picture of a chain measured for exactly that.

console.log('gif: palette, then encode');
const gif = `${OUT}/hero.gif`;
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-framerate',
  String(GIF.fps),
  '-i',
  `${FRAMES}/%03d.png`,
  '-vf',
  `scale=${String(GIF.width)}:-1:flags=lanczos,palettegen=max_colors=${String(GIF.colors)}:stats_mode=full`,
  `${FRAMES}/palette.png`,
]);
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-framerate',
  String(GIF.fps),
  '-i',
  `${FRAMES}/%03d.png`,
  '-i',
  `${FRAMES}/palette.png`,
  '-lavfi',
  `scale=${String(GIF.width)}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`,
  '-loop',
  '0',
  gif,
]);
rmSync(FRAMES, { recursive: true, force: true });

// WebP for the stills, the same format the research figures use. A screenshot of
// flat interface chrome is exactly what lossy compression is good at, and this
// project's whole argument is 50.7 KB gzipped: it cannot carry megabytes of PNG.
console.log('stills: to webp');
for (const name of ['video', 'styles']) {
  execFileSync('cwebp', [
    '-quiet',
    '-q',
    '82',
    '-resize',
    '1500',
    '0',
    `${OUT}/${name}.png`,
    '-o',
    `${OUT}/${name}.webp`,
  ]);
  rmSync(`${OUT}/${name}.png`);
}

// Written down for the same reason the harnesses write results: a picture whose
// size nobody watches is how a repository quietly gains ten megabytes.
const sizes = execFileSync('du', ['-k', gif, `${OUT}/video.webp`, `${OUT}/styles.webp`], {
  encoding: 'utf8',
});
console.log(`\n${sizes.trim()}`);
writeFileSync(`${OUT}/.taken`, `${new Date().toISOString().slice(0, 10)}\n`);
