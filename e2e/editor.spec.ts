import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { BlobSource, EncodedPacketSink, Input, MP4 } from 'mediabunny';

/**
 * One end-to-end pass through the product's actual claim: open an image, select
 * part of it, see only that part change, and save a full-resolution file.
 *
 * The unit suite covers correctness pixel by pixel; this covers the things only
 * a real browser can answer. That WebGPU comes up, that a file picker and a
 * pointer drive the engine, and that the download produces bytes.
 */

/** The product's own frame provider, as much of it as reading a file back needs. */
interface ProviderModule {
  readonly FrameProvider: {
    open(
      file: Blob,
      maxDimension: number,
    ): Promise<{
      readonly ok: boolean;
      readonly value: {
        readFrame(index: number, use: (frame: VideoFrame) => void): Promise<boolean>;
        dispose(): void;
      };
    }>;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

/**
 * A figure out of a harness's own results, by path.
 *
 * Walked rather than asserted, for the reason the research pages walk theirs:
 * a wrong shape should say which step of the path was missing, and a literal
 * copied into this file would make the test fail every time a benchmark is
 * re-taken. That teaches whoever re-took it to edit the assertion, and an
 * assertion nobody believes is worse than no assertion.
 */
async function medianAt(results: string, path: readonly string[]): Promise<number> {
  let node: unknown = JSON.parse(await readFile(join(here, '..', results), 'utf8'));
  const walked: string[] = [];
  for (const key of path) {
    if (node === null || typeof node !== 'object')
      throw new Error(`results: ${walked.join('/')} is not an object`);
    node = Object.getOwnPropertyDescriptor(node, key)?.value;
    walked.push(key);
    if (node === undefined) throw new Error(`results: no ${walked.join('/')}`);
  }
  if (typeof node !== 'number') throw new Error(`results: ${walked.join('/')} is not a number`);
  return node;
}

const fixture = join(fixtures, 'sample.png');
const clip = join(fixtures, 'sample.mp4');
const webm = join(fixtures, 'sample.webm');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // A real adapter, not a CPU fallback pretending to be one.
  const architecture = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    return adapter?.info?.architecture ?? 'none';
  });
  expect(architecture, 'expected a hardware GPU adapter').not.toBe('swiftshader');
});

test('opens an image, selects part of it, and exports', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Rotyl' })).toBeVisible();
  await expect(page.getByText('Drop a file, or click to browse')).toBeVisible();

  await page.locator('input[type=file]').setInputFiles(fixture);

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Brush' })).toBeVisible();
  await expect(page.getByText('sample.png')).toBeVisible();

  // Undo is unavailable until something has been selected.
  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeDisabled();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 12 });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.62, { steps: 12 });
  await page.mouse.up();

  await expect(undo).toBeEnabled();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('sample-rotyl.png');

  const path = await saved.path();
  expect(path).toBeTruthy();
});

test('switches between asking about an object and painting one', async ({ page }) => {
  // The model itself is not exercised here. Twenty megabytes over the network
  // is the wrong thing to put in a loop that has to be reliable, and what only
  // a browser can answer about this tool is the part before the model: that a
  // press is read as a question rather than as a stroke.
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  await page.getByRole('button', { name: 'Object' }).click();
  await expect(page.getByRole('button', { name: 'Object' })).toHaveAttribute('aria-pressed', 'true');
  // The brush ring shows a footprint, and the object tool has none.
  await expect(canvas).not.toHaveClass(/viewport__canvas--brushing/);

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  // A drag is a pan, not a stroke, so it leaves nothing on the undo stack.
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();

  // The brush is still a brush.
  await page.getByRole('button', { name: 'Brush' }).click();
  await expect(canvas).toHaveClass(/viewport__canvas--brushing/);
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
});

test('drags a region with the box tool, and still pans with shift held', async ({ page }) => {
  // The model is not exercised here either. What only a browser can answer is
  // the part before it: that a drag is read as a region rather than as a pan,
  // and that the pan it displaced is still reachable.
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  await page.getByRole('button', { name: 'Box' }).click();
  await expect(page.getByRole('button', { name: 'Box' })).toHaveAttribute('aria-pressed', 'true');

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const at = (u: number, v: number): [number, number] => [
    bounds.x + bounds.width * u,
    bounds.y + bounds.height * v,
  ];

  const marquee = page.locator('.marquee');
  await expect(marquee).toHaveCSS('opacity', '0');

  await page.mouse.move(...at(0.35, 0.3));
  await page.mouse.down();
  await page.mouse.move(...at(0.65, 0.7), { steps: 8 });
  await expect(marquee).toHaveCSS('opacity', '1');
  const drawn = await marquee.boundingBox();
  expect(drawn?.width).toBeGreaterThan(bounds.width * 0.2);
  await page.mouse.up();
  await expect(marquee).toHaveCSS('opacity', '0');

  // Shift is the way back to panning wherever a drag already means something.
  await page.keyboard.down('Shift');
  await page.mouse.move(...at(0.4, 0.4));
  await page.mouse.down();
  await page.mouse.move(...at(0.6, 0.5), { steps: 6 });
  await expect(marquee).toHaveCSS('opacity', '0');
  await page.mouse.up();
  await page.keyboard.up('Shift');
});

test('offers the research page from the empty state, and generates it from the results', async ({ page }) => {
  // The page is emitted by a Vite plugin rather than checked in, so "it still
  // builds" is a claim only an end-to-end request can make. The figures are
  // read out of the benchmark harnesses' results at generation time: a missing
  // path throws rather than rendering a blank cell, which makes this a test
  // that every number on it still has a measurement behind it.
  await page.goto('/');
  const link = page.getByRole('link', { name: 'Research' });
  await expect(link).toBeVisible();

  await link.click();
  await expect(page).toHaveURL(/research\.html$/);

  // One entry per finding rather than one page of everything, so the index is
  // a list and the figures are a page deeper.
  await page.getByRole('link', { name: /whether it holds still/i }).click();
  await expect(page).toHaveURL(/research\/the-look\.html$/);
  // Read out of the results rather than written here. A literal would make this
  // test fail every time a benchmark is re-taken, which teaches whoever re-took
  // it to edit the assertion, and an assertion nobody believes is worse than
  // none. What is being checked is that the cell holds the figure the harness
  // last wrote, whatever that figure is.
  const comic = await medianAt('tools/style-bench/results.json', [
    'chain',
    '720p',
    'comic, default',
    'full',
    'median',
  ]);
  await expect(page.getByRole('cell', { name: `${comic.toFixed(0)} ms` }).first()).toBeVisible();

  // The same three measurements against a photograph, which is a page of its
  // own because it is a finding of its own and it reversed one of the above.
  await page.goto('/research/real-footage.html');
  await expect(page.getByRole('cell', { name: 'the synthetic scene' }).first()).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'It was the outline, and the quantiser inside it' }),
  ).toBeVisible();

  // A figure out of the other harness's results, so both are known to be read.
  await page.goto('/research/video.html');
  const upload = await medianAt('tools/video-bench/results.json', [
    'decode',
    '1080p30-gop30',
    'upload',
    'copyExternalImageToTexture_videoframe',
    'median',
  ]);
  await expect(page.getByRole('cell', { name: `${upload.toFixed(1)} ms` }).first()).toBeVisible();

  // And out of the results file that has its own command, which the page reads
  // as well: a bundle size needs a build and no browser, so it is not part of
  // the run the timings come from.
  await page.goto('/research/the-clip.html');
  await expect(page.getByRole('cell', { name: '30.5 KB' }).first()).toBeVisible();
  // Stated in bytes rather than as 0.0 KB, which would read as a rounding error
  // rather than as the finding it is.
  await expect(page.getByText('costs 12 bytes')).toBeVisible();

  await page.goto('/research/trials.html');
  await expect(page.getByRole('cell', { name: /59.5 KB gzipped/ })).toBeVisible();
  await expect(page.getByText('undefined')).toHaveCount(0);
});

test('closes a file, and opens another without a reload', async ({ page }) => {
  // For most of this project's life a session held one file, and opening a
  // second meant reloading. The load path was re-entrant the whole time; what
  // was missing was any way out of the one that was open.
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.locator('canvas')).toBeVisible();

  const close = page.getByRole('button', { name: 'Close' });
  await close.click();
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.getByText('Drop a file, or click to browse')).toBeVisible();

  await page.locator('input[type=file]').setInputFiles(clip);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Frame' })).toBeVisible();
});

test('asks once before closing over work, and only then', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  // Nothing drawn yet, so nothing to lose: it just closes.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('Drop a file, or click to browse')).toBeVisible();

  await page.locator('input[type=file]').setInputFiles(fixture);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();

  await page.getByRole('button', { name: 'Close' }).click();
  const confirm = page.getByRole('button', { name: 'Discard edits?' });
  await expect(confirm).toBeVisible();
  // Still open until the second click: the question is not the answer.
  await expect(canvas).toBeVisible();

  await confirm.click();
  await expect(page.getByText('Drop a file, or click to browse')).toBeVisible();
});

test('reveals the style controls only when asked', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.locator('canvas')).toBeVisible();

  const panel = page.getByRole('complementary', { name: 'Style controls' });
  await expect(panel).toBeHidden();

  await page.getByRole('button', { name: 'Style' }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByLabel('Strength')).toBeVisible();
  await expect(page.getByLabel('Detail')).toBeVisible();

  await page.getByRole('button', { name: 'Style' }).click();
  await expect(panel).toBeHidden();
});

test('switches styles and brings each one its own controls', async ({ page }) => {
  // The seam, from the outside: the panel has no per-style code, so a style
  // arriving with three controls where the last had two is the observable
  // difference between a real boundary and a hard-coded pair of sliders.
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Style' }).click();

  const comic = page.getByRole('button', { name: 'Comic' });
  const poster = page.getByRole('button', { name: 'Poster' });
  const print = page.getByRole('button', { name: 'Print' });
  await expect(comic).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Detail')).toBeVisible();
  await expect(page.getByLabel('Line')).toBeHidden();

  // A style with five controls where the last had four, and one control name
  // shared with it: the panel has no per-style code, so this is the observable
  // difference between a real seam and a hard-coded set of sliders.
  await poster.click();
  await expect(poster).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Line')).toBeVisible();
  await expect(page.getByLabel('Detail')).toBeVisible();

  await print.click();
  await expect(print).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Coarseness')).toBeVisible();
  await expect(page.getByLabel('Colour')).toBeVisible();
  await expect(page.getByLabel('Detail')).toBeHidden();

  // A style's settings survive a look at the other one.
  const coarseness = page.getByLabel('Coarseness');
  await coarseness.fill('0.8');
  await comic.click();
  await expect(page.getByLabel('Detail')).toBeVisible();
  await print.click();
  await expect(coarseness).toHaveValue('0.8');
});

test('keeps the toolbar over the image when the style panel opens', async ({ page }) => {
  // The toolbar is positioned against the viewport, not the editor. Against the
  // editor it centred on the docked panel too and drifted off the image.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.locator('canvas')).toBeVisible();

  await page.getByRole('button', { name: 'Style' }).click();
  await expect(page.getByRole('complementary', { name: 'Style controls' })).toBeVisible();

  const toolbar = await page.locator('.toolbar').boundingBox();
  const viewport = await page.locator('.viewport').boundingBox();
  const panel = await page.locator('.style-panel').boundingBox();
  expect(toolbar && viewport && panel).toBeTruthy();
  if (!toolbar || !viewport || !panel) return;

  expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(panel.x + 1);
  const toolbarCentre = toolbar.x + toolbar.width / 2;
  const viewportCentre = viewport.x + viewport.width / 2;
  expect(Math.abs(toolbarCentre - viewportCentre)).toBeLessThan(2);
});

test('collapses the toolbar rather than clipping it on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 700 });
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Style' }).click();

  const toolbar = await page.locator('.toolbar').boundingBox();
  const viewport = await page.locator('.viewport').boundingBox();
  expect(toolbar && viewport).toBeTruthy();
  if (!toolbar || !viewport) return;

  expect(toolbar.x).toBeGreaterThanOrEqual(viewport.x - 1);
  expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
  // Still operable, just without visible labels.
  await expect(page.getByRole('button', { name: 'Erase' })).toBeVisible();
});

test('rebuilds itself when the graphics device is lost', async ({ page }) => {
  // The one thing only a browser can answer about recovery: that a real lost
  // device is survivable. `device.destroy()` from outside the app is the
  // closest thing to a driver reset that can be triggered on demand, and it
  // invalidates every GPU object exactly as one would.
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;

  await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.6, { steps: 10 });
  await page.mouse.up();

  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeEnabled();

  const before = await page.evaluate(() => globalThis.rotyl?.generation ?? -1);
  expect(before).toBe(0);
  await page.evaluate(() => globalThis.rotyl?.device.destroy());

  // A new device, and the image back on it, without anyone being asked to
  // reload.
  await expect.poll(() => page.evaluate(() => globalThis.rotyl?.generation ?? -1)).toBeGreaterThan(before);
  await expect(page.getByText(/graphics device was lost/i)).toBeHidden();
  await expect(page.getByText('Restoring')).toBeHidden();
  await expect(canvas).toBeVisible();

  // The selection is made of commands, and commands do not live on the GPU.
  await expect(undo).toBeEnabled();

  // And it still works, which a canvas showing the right pixels would not
  // prove on its own.
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.35, bounds.y + bounds.height * 0.75, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();
});

test('does not let a stray drop navigate the page away', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.locator('canvas')).toBeVisible();

  // A drop outside the drop zone would otherwise be handled by the browser,
  // which navigates to the file and discards the whole session.
  const defaultPrevented = await page.evaluate(() => {
    const event = new DragEvent('drop', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(defaultPrevented).toBe(true);
  await expect(page.locator('canvas')).toBeVisible();
});

test('explains itself when handed a file it cannot decode', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles({
    name: 'not-an-image.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('this is not an image'),
  });

  await expect(page.getByText(/not an image Rotyl can read/i)).toBeVisible();
  // And the drop zone is still usable rather than stuck in a loading state.
  await expect(page.getByText('Drop a file, or click to browse')).toBeVisible();
});

test('opens a video, scrubs it, and selects on a frame', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(clip);

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByText('sample.mp4')).toBeVisible();

  const timeline = page.getByRole('slider', { name: 'Frame' });
  await expect(timeline).toBeVisible();
  // The frame count comes from walking the container's index, so this asserts
  // the index was built and not that a duration was divided by a frame rate.
  await expect(page.getByText('1 / 60')).toBeVisible();

  // A frame is a picture, and the proof that scrubbing works is that the
  // picture changes. Comparing what was drawn is the only thing that shows it;
  // the slider moving shows only that the slider moves.
  const first = await canvas.screenshot();

  await timeline.fill('40');
  await expect(page.getByText('41 / 60')).toBeVisible();
  await expect(async () => {
    const later = await canvas.screenshot();
    expect(Buffer.compare(first, later)).not.toBe(0);
  }).toPass();

  // Scrubbing backwards costs a seek rather than a decode, and is the case that
  // breaks if the decoder is fed forward regardless.
  await timeline.fill('3');
  await expect(page.getByText('4 / 60')).toBeVisible();
  await expect(async () => {
    const back = await canvas.screenshot();
    expect(Buffer.compare(first, back)).not.toBe(0);
  }).toPass();

  // The selection works on a frame exactly as it works on a photograph.
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeDisabled();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await expect(undo).toBeEnabled();
});

test('offers no tracking when there is nowhere to fetch a tracker from', async ({ page }) => {
  // The graphs a tracker needs are in no published release, so a build says
  // where they are or the feature is not there. This build says nothing, which
  // is the state this suite runs in and the one worth pinning: a Track button
  // that could only 404 after a nineteen-megabyte download is worse than an
  // absent feature, and a default host would be exactly that button.
  await page.locator('input[type=file]').setInputFiles(clip);
  await expect(page.getByRole('slider', { name: 'Frame' })).toBeVisible();

  // The pair to the run below, and the two are mutually exclusive by
  // configuration on purpose: one of them asserts the feature is there and the
  // other that it is honestly absent, and which applies is decided by the same
  // build-time string rather than by a flag either of them invents.
  const track = page.getByRole('button', { name: 'Track' });
  test.skip((await track.count()) > 0, 'VITE_TRACKING_HOST is set: there is a tracker to offer');

  await expect(track).toHaveCount(0);
  // Everything else in the toolbar is still there, so this is a missing button
  // rather than a missing toolbar.
  await expect(page.getByRole('button', { name: 'Invert' })).toBeVisible();
});

test('refuses a video it cannot decode, by name', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(webm);
  await expect(page.getByText('WebM and Matroska are not supported yet. MP4 and MOV work.')).toBeVisible();
  // Refused, not half-loaded: the drop zone is still the thing on screen.
  await expect(page.getByText('Drop a file, or click to browse')).toBeVisible();
});

test('carries a selection forward through the clip', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(clip);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const timeline = page.getByRole('slider', { name: 'Frame' });
  const undo = page.getByRole('button', { name: 'Undo' });

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  // The brush draws its own ring at the pointer, so the pointer is parked off
  // the canvas before every capture. Otherwise the comparison is measuring
  // where the mouse happens to be.
  const park = async (): Promise<void> => {
    await page.mouse.move(box.x + box.width / 2, box.y - 30);
  };

  await timeline.fill('40');
  await expect(page.getByText('41 / 60')).toBeVisible();
  await park();
  const clean40 = await canvas.screenshot();

  await timeline.fill('10');
  await expect(page.getByText('11 / 60')).toBeVisible();
  await park();
  const clean10 = await canvas.screenshot();

  await timeline.fill('20');
  await expect(page.getByText('21 / 60')).toBeVisible();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 10 });
  await page.mouse.up();
  await expect(undo).toBeEnabled();

  // The one thing that makes the frame it started on findable again.
  await expect(page.locator('.timeline__mark')).toHaveCount(1);

  // Forward: the selection is in effect on a frame it was not drawn on, which
  // is the whole point of selecting a region of a clip.
  await timeline.fill('40');
  await expect(page.getByText('41 / 60')).toBeVisible();
  await park();
  await expect(async () => {
    expect(Buffer.compare(await canvas.screenshot(), clean40)).not.toBe(0);
  }).toPass();

  // Backward: nothing is in effect before the edit that started it.
  await timeline.fill('10');
  await expect(page.getByText('11 / 60')).toBeVisible();
  await park();
  await expect(async () => {
    expect(Buffer.compare(await canvas.screenshot(), clean10)).toBe(0);
  }).toPass();
});

test('follows a selection forward through the clip, and stops where it is told', async ({ page }) => {
  // THE ONE TEST HERE THAT NEEDS WEIGHTS, and it skips itself rather than
  // asking to be remembered. Tracking fetches nineteen megabytes of graph from
  // wherever a build was told they are, plus the thirty-six the object model
  // costs, which is the wrong thing to put in a loop that has to be reliable.
  // So it runs when VITE_TRACKING_HOST is set and not otherwise, and the way it
  // asks is by looking for the button that only exists when it is.
  //
  //     cp tools/edgetam-export/onnx/{memory_attention_shared_fp16,memory_encoder}.onnx \
  //        tools/edgetam-export/onnx/parameters.json public/edgetam/
  //     echo VITE_TRACKING_HOST=/edgetam > .env.local
  //     pnpm e2e
  test.setTimeout(180_000);
  await page.locator('input[type=file]').setInputFiles(clip);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const track = page.getByRole('button', { name: 'Track' });
  test.skip((await track.count()) === 0, 'no VITE_TRACKING_HOST: nothing to fetch a tracker from');

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const timeline = page.getByRole('slider', { name: 'Frame' });
  await timeline.fill('10');
  await expect(page.getByText('11 / 60')).toBeVisible();

  // Seeded from the Area tool rather than from a click, so what is being tested
  // is the tracker rather than the object model's opinion of this clip. The
  // seed is read back off the mask either way.
  await page.keyboard.press('a');
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.timeline__mark')).toHaveCount(1);
  await expect(track).toBeEnabled();

  await track.click();
  // The download, then the run. Both go through the one status line everything
  // else in the product uses.
  const stop = page.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/Tracking, frame \d+ of 49/)).toBeVisible({ timeout: 120_000 });

  // A tracked frame is about 135 milliseconds, so a handful of them is a
  // second or two. What is being waited for is marks on the timeline: one per
  // frame the run has written a command for, which is the visible proof that a
  // mask came back for a frame nobody selected on.
  await expect(page.locator('.timeline__mark')).toHaveCount(6, { timeout: 120_000 });

  await stop.click();
  await expect(track).toBeVisible();
  // Stopping keeps what it found. There is already a button for taking it back.
  const marks = await page.locator('.timeline__mark').count();
  expect(marks).toBeGreaterThanOrEqual(6);

  // And it is one gesture: one press of undo takes the whole run, and lands the
  // playhead on the frame after the one the selection was made on.
  const undo = page.getByRole('button', { name: 'Undo' });
  await undo.click();
  await expect(page.locator('.timeline__mark')).toHaveCount(1);
  await expect(page.getByText('12 / 60')).toBeVisible();
});

test('plays, and stops where it was asked to', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(clip);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('1 / 60')).toBeVisible();

  await page.getByRole('button', { name: 'Play' }).click();
  // Advancing on its own is the whole claim.
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.locator('.timeline__count')).not.toHaveText('1 / 60');

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  const stopped = await page.locator('.timeline__count').textContent();
  // Paused means paused: a loop still running would move past this.
  await page.waitForTimeout(400);
  expect(await page.locator('.timeline__count').textContent()).toBe(stopped);
});

test('exports the frame on screen, named for it', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(clip);
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('slider', { name: 'Frame' }).fill('23');
  await expect(page.getByText('24 / 60')).toBeVisible();

  const download = page.waitForEvent('download');
  // A clip offers two answers, and the quieter one is the frame.
  await page.getByRole('button', { name: 'Frame', exact: true }).click();
  const saved = await download;
  // Named for the frame, because exporting three of them should not write the
  // same file three times.
  expect(saved.suggestedFilename()).toBe('sample-rotyl-f00024.png');
  expect(await saved.path()).toBeTruthy();
});

/**
 * The whole clip, and then read back with the demuxer that opened the original.
 *
 * A download event proves bytes arrived. What it does not prove is that they
 * are a video, that they are the RIGHT number of frames, or that the container
 * is one anything can open, and all three of those are ways this can be broken
 * while still producing a file.
 */
test('exports the whole clip as a video', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(clip);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByText('1 / 60')).toBeVisible();

  // Something selected, so the file being written is the product's claim rather
  // than a re-encode of the source. A dragged rectangle rather than a brush
  // stroke, because this test then knows exactly which pixels it asked to
  // change and can look at the ones it did not.
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.getByRole('button', { name: 'Area' }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Clip' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('sample-rotyl.mp4');

  const path = await saved.path();
  expect(path).toBeTruthy();
  if (!path) return;
  const bytes = await readFile(path);

  const input = new Input({ formats: [MP4], source: new BlobSource(new Blob([bytes])) });
  const track = await input.getPrimaryVideoTrack();
  expect(track).not.toBeNull();
  if (!track) return;
  expect(track.displayWidth).toBe(320);
  expect(track.displayHeight).toBe(240);

  let frames = 0;
  let keyframes = 0;
  const sink = new EncodedPacketSink(track);
  for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
    frames++;
    if (packet.type === 'key') keyframes++;
  }
  input.dispose();

  // Every frame of the source, and no more.
  expect(frames).toBe(60);
  // More than one, because the file this writes is a file this tool can open
  // and seek cost is set by keyframe spacing and by nothing else.
  expect(keyframes).toBeGreaterThan(1);

  // And the editor is usable afterwards rather than left on the last frame of
  // its own export.
  await expect(page.getByText('1 / 60')).toBeVisible();

  // The product's whole claim, in the file rather than on the screen: a frame
  // in the middle of the clip is changed where the selection is and left alone
  // where it is not. Compared against the source clip decoded the same way, in
  // the browser, because Node has no WebCodecs.
  const difference = await page.evaluate(
    async ([encoded, index, providerModule]) => {
      // The product's own frame provider, reached the way the benchmarks reach
      // project code in a page: through the dev server, so its bare imports
      // resolve. Reading the exported file with the same code that reads any
      // other clip is the point rather than a shortcut.
      // Declared rather than asserted: the specifier is a runtime string, so the
      // import has no type of its own, and naming the shape it is expected to
      // have is the honest way to say what this test relies on.
      const loaded: ProviderModule = await import(providerModule);
      const { FrameProvider } = loaded;

      const pixels = async (blob: Blob, want: number): Promise<Uint8ClampedArray> => {
        const opened = await FrameProvider.open(blob, 8192);
        if (!opened.ok) throw new Error('the exported clip could not be opened');
        let data: Uint8ClampedArray | undefined;
        const shown = await opened.value.readFrame(want, (frame) => {
          const surface = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
          const context = surface.getContext('2d');
          if (!context) throw new Error('no 2d context');
          context.drawImage(frame, 0, 0);
          data = context.getImageData(0, 0, surface.width, surface.height).data;
        });
        opened.value.dispose();
        if (!shown || !data) throw new Error('that frame could not be read');
        return data;
      };

      const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const written = await pixels(new Blob([decoded]), index);
      const source = await pixels(await (await fetch('/e2e/fixtures/sample.mp4')).blob(), index);

      // Mean absolute difference over a patch, in codes.
      const patch = (x0: number, y0: number, size: number): number => {
        let total = 0;
        let count = 0;
        for (let y = y0; y < y0 + size; y++) {
          for (let x = x0; x < x0 + size; x++) {
            const o = (y * 320 + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
              total += Math.abs((written[o + channel] ?? 0) - (source[o + channel] ?? 0));
              count++;
            }
          }
        }
        return total / count;
      };

      return { selected: patch(144, 104, 32), corner: patch(4, 4, 32) };
    },
    [bytes.toString('base64'), 30, '/src/platform/video/frame-provider.ts'] as const,
  );

  // Stylised inside the rectangle.
  expect(difference.selected).toBeGreaterThan(6);
  // And left alone outside it. Not zero: a clip is re-encoded, and H.264 is
  // lossy. The composite is still exact outside the selection and the file it
  // is written into is not, which measures about three codes here. Asserted as
  // a ratio as well as a bound, so a style that stopped applying could not pass
  // by the codec's error alone being small.
  expect(difference.corner).toBeLessThan(4);
  expect(difference.selected).toBeGreaterThan(difference.corner * 2);
});

test('undo goes to the frame it undid', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(clip);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const timeline = page.getByRole('slider', { name: 'Frame' });

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await timeline.fill('15');
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.timeline__mark')).toHaveCount(1);

  await timeline.fill('50');
  await expect(page.getByText('51 / 60')).toBeVisible();

  // Undoing something on another frame would otherwise happen where nobody can
  // see it, and the next stroke would discard it for good.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('16 / 60')).toBeVisible();
  await expect(page.locator('.timeline__mark')).toHaveCount(0);
});

test('selects the area dragged, not the object inside it', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  // Area, not Box. The two are the same gesture: one asks a model what is in
  // the region, this one takes the region.
  await page.getByRole('button', { name: 'Area' }).click();
  await expect(page.getByRole('button', { name: 'Area' })).toHaveAttribute('aria-pressed', 'true');

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeDisabled();

  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 12 });
  await page.mouse.up();

  // No model was downloaded and nothing was asked of one: the shape is the
  // answer, so this lands as an ordinary undoable edit straight away.
  await expect(undo).toBeEnabled();
  await expect(page.getByText('Downloading the object model')).toBeHidden();
});

test('offers a palette as a choice, not as a slider', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  // The whole frame, so what is compared is the style and nothing else.
  await page.getByRole('button', { name: 'Invert' }).click();
  await page.getByRole('button', { name: 'Style' }).click();

  const palette = page.getByRole('group', { name: 'Palette' });
  await expect(palette).toBeVisible();
  // A choice has no meaningful midpoint, so it is buttons.
  await expect(palette.getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true');

  // Parked between captures: clicking a control leaves the pointer on it, and
  // what is being compared is the picture, not where the mouse ended up.
  const park = async (): Promise<Buffer> => {
    await page.mouse.move(0, 0);
    return canvas.screenshot();
  };

  // Docking the panel narrows the viewport, so the canvas resizes and redraws.
  // Capturing before that settles compares two different-sized images, which
  // can never match however long it is retried.
  const settled = async (): Promise<Buffer> => {
    let last = await park();
    for (let attempt = 0; attempt < 20; attempt++) {
      const next = await park();
      if (Buffer.compare(next, last) === 0) return next;
      last = next;
    }
    return last;
  };

  const before = await settled();

  await palette.getByRole('button', { name: 'Riso' }).click();
  await expect(palette.getByRole('button', { name: 'Riso' })).toHaveAttribute('aria-pressed', 'true');
  await expect(async () => {
    expect(Buffer.compare(await park(), before)).not.toBe(0);
  }).toPass();

  // And off again, exactly. A palette of None is a mix factor of zero, which
  // returns the colour it was given rather than approximately returning it.
  await palette.getByRole('button', { name: 'None' }).click();
  await expect(async () => {
    expect(Buffer.compare(await park(), before)).toBe(0);
  }).toPass();
});
