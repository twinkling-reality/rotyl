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
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'docs/media';
const FRAMES = '.shots-frames';
const URL_BASE = process.env.ROTYL_URL ?? 'http://localhost:5180';
const CLIP = '/tools/style-bench/clips/pan-720p.mp4';
const SCENE = '/tools/style-bench/clips/scene.png';

/** Big enough that the toolbar reads, small enough that a GIF stays sane. */
const VIEWPORT = { width: 1100, height: 660 };

/**
 * What the animated hero is allowed to cost.
 *
 * A repository whose entire argument is 45.8 KB gzipped cannot carry a
 * multi-megabyte screenshot, and a GIF is the only moving format GitHub renders
 * from a repository path. 680 pixels across 32 frames of 48 colours is the point
 * where the split down the middle still reads and the file stops being rude.
 */
const GIF = { width: 680, frames: 32, colors: 48, fps: 11 };

mkdirSync(OUT, { recursive: true });
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

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
      transfer.items.add(new File([bytes], as, { type: as.endsWith('.mp4') ? 'video/mp4' : 'image/png' }));
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

// --- the hero: a rectangle of stylisation over moving footage ----------------
//
// The Area tool is what this shows, and it is the one gesture whose point is
// only visible in motion: drag a rectangle once and the traffic runs through it.

await open(CLIP, 'street.mp4');
// The right half, full height. As the camera pans, everything in the scene
// crosses the boundary, which is the clearest statement the product can make:
// the same content, plain on one side and stylised on the other, at once.
await selectArea([0.5, 0.02], [0.99, 0.98]);

// Poster rather than the default: 1.3 ms a frame at 720p, so playback holds full
// quality and this shows the real look rather than a draft tier. With a palette,
// because a stylised hazy street with no palette comes out grey, which is the
// failure the palette exists to fix rather than a fair picture of the chain.
await page.getByRole('button', { name: 'Style' }).click();
await page.getByRole('button', { name: 'Poster' }).click();
await page.getByRole('button', { name: 'Riso' }).click();
await page.getByRole('button', { name: 'Style' }).click();
await page.waitForTimeout(600);

console.log('hero: capturing frames');
const timeline = page.getByRole('slider', { name: 'Frame' });
// Asked rather than assumed: the demo clip is whatever make-clips.sh produced,
// and a hard-coded frame number is how this breaks the next time it changes.
const last = Number(await timeline.getAttribute('max'));
const count = Math.min(GIF.frames, last + 1);
for (let i = 0; i < count; i++) {
  // Scrubbed rather than played, so the frames are evenly spaced whatever the
  // machine is doing. Playback drops frames by design and would show it.
  await timeline.fill(String(Math.round((i * last) / (count - 1))));
  await page.waitForTimeout(90);
  await page.screenshot({ path: `${FRAMES}/${String(i).padStart(3, '0')}.png` });
}
console.log(`hero: ${String(count)} of ${String(last + 1)} frames`);

// --- the stills --------------------------------------------------------------

console.log('stills: style panel, and the object picker');
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
// project's whole argument is 45.8 KB gzipped: it cannot carry megabytes of PNG.
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
