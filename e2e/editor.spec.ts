import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { BlobSource, EncodedPacketSink, Input, MP4, QTFF } from 'mediabunny';

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
// A QuickTime file whose sound an MP4 cannot hold. QuickTime carries mu-law and
// MP4 does not, so this is an ordinary file whose soundtrack has nowhere to go,
// which is the branch that would otherwise never be run.
const mulaw = join(fixtures, 'sample-mulaw.mov');

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

  // And out of the results files that have their own commands, which the page
  // reads as well: a bundle size needs a build and no browser, so it is not part
  // of the run the timings come from.
  await page.goto('/research/the-clip.html');
  const packets = await medianAt('tools/video-bench/results-bundle.json', [
    'cases',
    'write MP4, packets only',
    'gzip',
  ]);
  await expect(page.getByRole('cell', { name: `${(packets / 1024).toFixed(1)} KB` }).first()).toBeVisible();
  // Stated in bytes rather than as 0.0 KB, which would read as a rounding error
  // rather than as the finding it is.
  const second = await medianAt('tools/video-bench/results-bundle.json', [
    'deltas',
    'a second container to write',
  ]);
  await expect(page.getByText(`costs ${String(second)} bytes`)).toBeVisible();

  // The measurement with the longest command of all, on its own page: how long
  // a clip export can be is twenty minutes of encoding to find out, so it is
  // neither part of the timings run nor something a page may quietly omit.
  await page.goto('/research/a-long-clip.html');
  const budgeted = await medianAt('tools/video-bench/results-long-clip.json', [
    'long-clip',
    'in memory, past the budget',
    'file_mb',
  ]);
  await expect(page.getByText(`${String(budgeted)} MB`).first()).toBeVisible();

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
  // Stop appears at once and the status says what is happening: the two graphs
  // are nineteen megabytes and arrive before any of it starts.
  const stop = page.getByRole('button', { name: 'Stop' });
  const marks = page.locator('.timeline__mark');
  await expect(stop).toBeVisible({ timeout: 120_000 });

  // At least one frame nobody selected on now carries a mask, which is the
  // whole of what tracking is. Counted with a floor rather than exactly: a
  // tracked frame is about 135 ms and an exact count races a moving number.
  await expect.poll(() => marks.count(), { timeout: 120_000 }).toBeGreaterThan(1);
  const before = await marks.count();

  await stop.click();
  await expect(track).toBeVisible();
  // Stopping keeps what it found. There is already a button for taking it back,
  // and it did not reach the end of the clip.
  const kept = await marks.count();
  expect(kept).toBeGreaterThanOrEqual(before);
  expect(kept).toBeLessThan(60);

  // And it is one gesture: one press of undo takes the whole run, and lands the
  // playhead on the frame after the one the selection was made on.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(marks).toHaveCount(1);
  await expect(page.getByText('2 / 60')).toBeVisible();
});

test('leaves the playhead free while it tracks', async ({ page }) => {
  // TWO CURSORS OVER ONE DOCUMENT, which is the reason a run opens a second
  // decoder over the same file rather than sharing the playhead's. One provider
  // serving both would have each request supersede the other's, and neither of
  // them would be wrong: every scrub would cancel the run and the run would
  // cancel every scrub.
  //
  // Guarded the same way as the run above, and for the same reason.
  test.setTimeout(180_000);
  await page.locator('input[type=file]').setInputFiles(clip);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const track = page.getByRole('button', { name: 'Track' });
  test.skip((await track.count()) === 0, 'no VITE_TRACKING_HOST: nothing to fetch a tracker from');

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.keyboard.press('a');
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 10 });
  await page.mouse.up();

  const marks = page.locator('.timeline__mark');
  const park = async (): Promise<void> => {
    await page.mouse.move(box.x + box.width / 2, box.y - 30);
  };
  await park();
  const before = await canvas.screenshot();

  await track.click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => marks.count(), { timeout: 120_000 }).toBeGreaterThan(1);

  // The picture moves, while the run carries on behind it. Slowly, because the
  // arithmetic between the graphs is eighteen milliseconds of main-thread
  // JavaScript per tracked frame.
  const started = await marks.count();
  await page.getByRole('slider', { name: 'Frame' }).fill('40');
  await expect(page.getByText('41 / 60')).toBeVisible({ timeout: 60_000 });
  await park();
  await expect(async () => {
    expect(Buffer.compare(await canvas.screenshot(), before)).not.toBe(0);
  }).toPass();

  // And it ran to the end of the clip regardless of where the playhead went,
  // which is what makes the set of frames it tracked a property of the request
  // rather than of how somebody happened to scrub.
  expect(started).toBeGreaterThan(1);
  await expect(marks).toHaveCount(60, { timeout: 120_000 });
  await expect(track).toBeEnabled();
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
 *
 * WITH NO SAVE DIALOG, which is what Safari and Firefox are. The picker is
 * removed rather than left alone, because in the browser this suite runs in it
 * is there, and a native dialog is the one thing Playwright cannot drive. So
 * this is the path those two browsers take, tested where it can be tested, and
 * the path the others take is the test below it.
 */
test('exports the whole clip as a video, with nowhere to write it', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { showSaveFilePicker: undefined });
  });
  await page.goto('/');
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

  // And the sound, on the path that has no file to write into either. The
  // soundtrack is not a property of having a handle, and a product that carried
  // it only where it could stream would be two products.
  expect((await audioPackets(new Uint8Array(bytes))).length).toBeGreaterThan(50);

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

/**
 * A save dialog Playwright can drive, which is the one thing it cannot.
 *
 * The origin private file system hands back a real `FileSystemFileHandle` with
 * a real `createWritable` that seeks, which is everything the streaming export
 * asks of the one a picker returns. So the only thing replaced is the dialog
 * itself, and every line below it, the stream target, the reserved index, the
 * seek back at the end, is the code that runs for a user who picked a file.
 *
 * Installed rather than merely present, because a test that relied on the real
 * picker would open a native window and stop.
 */
async function stubSavePicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, {
      showSaveFilePicker: async (options: { suggestedName?: string }): Promise<FileSystemFileHandle> => {
        const root = await navigator.storage.getDirectory();
        const name = options.suggestedName ?? 'picked.mp4';
        // A picker hands back an empty file, and so does this: an export that
        // stopped early has to overwrite rather than append to what was there.
        await root.removeEntry(name).catch(() => undefined);
        return root.getFileHandle(name, { create: true });
      },
    });
  });
  await page.goto('/');
}

/** Whatever the stubbed picker wrote, brought back out of the page. */
async function readPickedFile(page: Page, name: string): Promise<Uint8Array<ArrayBuffer>> {
  const encoded = await page.evaluate(async (wanted) => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(wanted)).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    // In blocks, because a character at a time is minutes on a megabyte and
    // spreading the array into apply() overflows the argument list.
    const parts: string[] = [];
    for (let at = 0; at < bytes.length; at += 8192) {
      parts.push(String.fromCharCode(...bytes.subarray(at, at + 8192)));
    }
    return btoa(parts.join(''));
  }, name);
  const decoded = Buffer.from(encoded, 'base64');
  // Copied into a buffer of its own rather than handed over as the Buffer: a
  // Buffer's backing store is typed as possibly shared, which a Blob will not
  // take. Byte by byte in a loop, never spread, for the reason the unit suite
  // gives: a spread of a megabyte is an argument list of a million.
  const out = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let at = 0; at < decoded.length; at++) out[at] = decoded[at] ?? 0;
  return out;
}

/** The top-level box types, in order, which is where the index is. */
function boxOrder(bytes: Uint8Array<ArrayBuffer>): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  let pos = 0;
  while (pos + 16 <= bytes.length && out.length < 8) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4),
      view.getUint8(pos + 5),
      view.getUint8(pos + 6),
      view.getUint8(pos + 7),
    );
    if (size === 1) size = Number(view.getBigUint64(pos + 8));
    if (size < 8) break;
    out.push(type);
    pos += size;
  }
  return out;
}

/**
 * The clip written straight into a file, which is the whole point of this
 * chapter: nothing is held, so there is no length at which it stops working.
 *
 * What is asserted beyond "a file exists" is the property that decides whether
 * streaming was worth doing at all. The index has to stay at the FRONT of the
 * file, before the media, which a stream target does not do by default and
 * which needs the room reserved before the first frame and seeked back to at
 * the end. A file with its index at the end is a different file: nothing plays
 * it until the last byte has arrived.
 */
test('writes the clip into a file the user chose, index first', async ({ page }) => {
  await stubSavePicker(page);
  await page.locator('input[type=file]').setInputFiles(clip);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByText('1 / 60')).toBeVisible();

  // Nothing should be downloaded: the bytes went to the file, and a browser
  // that did both would be writing the clip twice.
  let downloaded = 0;
  page.on('download', () => {
    downloaded++;
  });

  await page.getByRole('button', { name: 'Clip' }).click();
  // Waited for by the sentence rather than by the buttons coming back, which
  // they have not yet left. A file written to a path the user chose leaves no
  // trace in the browser at all, so the product says it did, and that sentence
  // is both the signal this test needs and a thing worth asserting.
  await expect(page.getByText('Wrote sample-rotyl.mp4.')).toBeVisible({ timeout: 60_000 });

  const bytes = await readPickedFile(page, 'sample-rotyl.mp4');
  expect(bytes.length).toBeGreaterThan(1024);
  // ftyp, then the index, then the room left over, then the media. The order is
  // the assertion; the free box is what reserving costs when the count is known
  // exactly rather than guessed.
  expect(boxOrder(bytes).slice(0, 2)).toEqual(['ftyp', 'moov']);
  expect(boxOrder(bytes)).toContain('mdat');

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
  expect(frames).toBe(60);
  // More than one, for the reason the other export test gives: seek cost is set
  // by keyframe spacing and by nothing else.
  expect(keyframes).toBeGreaterThan(1);

  expect(downloaded).toBe(0);
  // And the editor is usable afterwards rather than left on the last frame of
  // its own export.
  await expect(page.getByText('1 / 60')).toBeVisible();
});

/**
 * Dismissing the dialog does nothing at all, which is the reason it is asked
 * before the work rather than after.
 *
 * Somebody who changes their mind about where a clip goes has changed their
 * mind about exporting it, and the cost of finding that out first is one dialog
 * against minutes of encoding.
 */
test('does no work when the save dialog is dismissed', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      rotylDismissed: 0,
      showSaveFilePicker: () => {
        Object.assign(window, { rotylDismissed: Number(Reflect.get(window, 'rotylDismissed')) + 1 });
        return Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
      },
    });
  });
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(clip);
  await expect(page.locator('canvas')).toBeVisible();

  let downloaded = 0;
  page.on('download', () => {
    downloaded++;
  });

  await page.getByRole('button', { name: 'Clip' }).click();
  // Waited for, so "nothing happened" is asserted after the dialog was answered
  // rather than before it was asked. An assertion that passes because it ran
  // too early is worse than no assertion.
  await page.waitForFunction(() => Reflect.get(window, 'rotylDismissed') === 1);
  // No Stop, because nothing started.
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  // And no complaint: they were asked a question and declined to answer it.
  await expect(page.locator('.notice')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clip' })).toBeEnabled();
  expect(downloaded).toBe(0);
});

/** The audio packets of a clip, as bytes and times, in order. */
async function audioPackets(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ data: Uint8Array; seconds: number }[]> {
  const input = new Input({ formats: [MP4, QTFF], source: new BlobSource(new Blob([bytes])) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return [];
    const out: { data: Uint8Array; seconds: number }[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) {
      out.push({ data: packet.data, seconds: packet.timestamp });
    }
    return out;
  } finally {
    input.dispose();
  }
}

/**
 * Stopping keeps what was written, which is the rule this whole path turns on.
 *
 * It used to abandon, and that was right while the file existed only in memory:
 * nothing had been promised and nothing was lost. Once the bytes are going into
 * a file the user named it is not, because abandoning leaves an empty file
 * where they asked for a video. So a stopped export finishes the file at the
 * frame it reached, and what comes out has to be a file anything can open,
 * which is what is asserted here rather than merely that it exists.
 *
 * The stop lands wherever it lands. What makes that a test rather than a race
 * is that the progress hairline only appears once an export has been running
 * for 220 ms, so waiting for it is waiting for a run that is genuinely under
 * way, and if the clip is ever short enough to finish inside that this fails
 * rather than passing without having tested anything.
 */
test('stops where it is told, and keeps what it wrote', async ({ page }) => {
  await stubSavePicker(page);
  await page.locator('input[type=file]').setInputFiles(clip);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('1 / 60')).toBeVisible();

  await page.getByRole('button', { name: 'Clip' }).click();
  await expect(page.locator('.activity__fill')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Clip' })).toBeVisible({ timeout: 30_000 });

  // Said in the interface rather than left for the user to discover by opening
  // the file: a shorter clip than the one they asked for needs a sentence.
  await expect(page.getByText(/^Stopped at /)).toBeVisible();

  const bytes = await readPickedFile(page, 'sample-rotyl.mp4');
  expect(boxOrder(bytes).slice(0, 2)).toEqual(['ftyp', 'moov']);

  const input = new Input({ formats: [MP4], source: new BlobSource(new Blob([bytes])) });
  const track = await input.getPrimaryVideoTrack();
  expect(track).not.toBeNull();
  if (!track) return;
  let frames = 0;
  const sink = new EncodedPacketSink(track);
  for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
    if (packet.byteLength >= 0) frames++;
  }
  input.dispose();

  // Shorter than the clip, and a real clip: the point is that the work up to
  // where it stopped is worth what it would have been had the clip ended there.
  expect(frames).toBeGreaterThan(0);
  expect(frames).toBeLessThan(60);

  // AND THE SOUND STOPPED WITH IT. Draining the rest of the soundtrack at the
  // end would give an export stopped four minutes into a fourteen minute clip a
  // fourteen minute soundtrack over a four minute picture, which is the one way
  // a stop could leave a file worse than the part that was rendered.
  const sound = await audioPackets(bytes);
  expect(sound.length).toBeGreaterThan(0);
  const endOfPicture = frames / 30;
  expect(sound.at(-1)?.seconds ?? 0).toBeLessThan(endOfPicture + 0.05);
});

/**
 * The sound goes out as the sound that came in, and it goes out INTERLEAVED.
 *
 * Two claims, and the second one is the reason the first one was not just a
 * call after the loop. Measured (`node tools/video-bench/run.mjs interleave`), a
 * file whose audio is one run after the video puts the sound of a given second
 * a median of half the file away from its picture and grows with the clip, and
 * with the index reserved at the front it usually cannot be written at all. So
 * what is asserted here is that the packets are bit-identical AND that they are
 * spread through the file rather than gathered at one end of it.
 */
test('writes the clip with its sound, unchanged and spread through the file', async ({ page }) => {
  await stubSavePicker(page);
  await page.locator('input[type=file]').setInputFiles(clip);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('1 / 60')).toBeVisible();

  // Said before the work, and this clip's sound is one an MP4 holds, so what
  // the button promises is the sound rather than the absence of it.
  await expect(page.getByRole('button', { name: 'Clip' })).toHaveAttribute(
    'title',
    'Write the whole clip as an MP4, with its sound.',
  );

  await page.getByRole('button', { name: 'Clip' }).click();
  await expect(page.getByText('Wrote sample-rotyl.mp4.')).toBeVisible({ timeout: 60_000 });

  const written = await readPickedFile(page, 'sample-rotyl.mp4');
  const source = await audioPackets(new Uint8Array(await readFile(clip)));
  const out = await audioPackets(written);

  // The fixture has sound in it, which is the thing that makes this test able
  // to fail: without this line a product that dropped every packet would pass.
  expect(source.length).toBeGreaterThan(50);
  // Every packet that STARTS inside the clip, and no others. Two edges, and
  // both of them are decisions rather than accidents. An audio packet grid does
  // not land on frame boundaries, so a clip of sixty frames at thirty a second
  // ends at two seconds and a packet beginning after that plays under nothing.
  // And an AAC track begins with a PRIMING packet at a negative timestamp,
  // whose samples a decoder throws away: MP4 has no way to say "before zero"
  // except an edit list this muxer only writes for positive offsets, so keeping
  // it would put the whole soundtrack a packet late against the picture.
  const kept = source.filter((packet) => packet.seconds >= 0 && packet.seconds < 60 / 30);
  expect(kept.length).toBeLessThan(source.length);
  expect(out.length).toBe(kept.length);
  // BIT-IDENTICAL. The video is re-encoded because it was re-drawn; the audio
  // was not touched, so nothing about it may change but the moment it plays.
  for (const [index, packet] of out.entries()) {
    const was = kept[index];
    expect(
      Buffer.from(packet.data).equals(Buffer.from(was?.data ?? new Uint8Array())),
      `packet ${String(index)}`,
    ).toBe(true);
    expect(packet.seconds, `packet ${String(index)} time`).toBeCloseTo(was?.seconds ?? -1, 6);
  }

  // And where the bytes ended up. For every whole second of the clip, how far
  // away in the file the sound that plays with it is: gathered at one end that
  // distance is most of the file, interleaved it is a fraction of it.
  const reach = await page.evaluate(
    async ([encoded, indexModule]) => {
      // The benchmark's own sample-table reader, reached through the dev server
      // the way the provider is above. Reading the file the way a player reads it
      // is the point: byte offsets are the only thing this claim is about.
      const parse: {
        mp4Index: (bytes: Uint8Array) => {
          tracks: { kind: string; samples: { seconds: number; offset: number }[] }[];
        };
      } = await import(indexModule);
      const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const index = parse.mp4Index(decoded);
      const at = (kind: string, when: number): number | undefined => {
        const track = index.tracks.find((candidate) => candidate.kind === kind);
        let found: number | undefined;
        for (const sample of track?.samples ?? []) {
          if (sample.seconds > when) break;
          found = sample.offset;
        }
        return found;
      };
      let worst = 0;
      for (let second = 0; second < 2; second++) {
        const picture = at('video', second);
        const sound = at('audio', second);
        if (picture === undefined || sound === undefined) continue;
        worst = Math.max(worst, Math.abs(picture - sound));
      }
      return { worst, size: decoded.length };
    },
    [Buffer.from(written).toString('base64'), '/tools/video-bench/mp4-index.ts'] as const,
  );

  // Within one second's worth of bytes of its own picture, where gathering the
  // sound at one end of the file would put it at the length of the whole thing.
  // Stated in seconds of media rather than as a fraction, because the muxer
  // closes a chunk every half second and a two second clip therefore has only
  // four of them: a fraction that looked tight here would be a fraction that
  // failed on a longer clip for no reason. The number itself lives in the
  // results file the research page reads rather than in a bound copied here.
  const bytesPerSecond = reach.size / (60 / 30);
  expect(reach.worst).toBeLessThan(bytesPerSecond);
});

/**
 * A range writes part of the clip, and a selection made before it still applies.
 *
 * THE SECOND HALF IS THE DECISION. A range is a range on the export and not a
 * trim of the document: every command in the log carries an absolute frame
 * number and folds forward, so a rectangle dragged on frame 0 is still in
 * effect on frame 40. A trim that renumbered frames would have quietly dropped
 * it, and the difference is invisible until somebody exports the second half of
 * a clip and gets none of their work.
 */
test('exports a range, and a selection made before it still applies', async ({ page }) => {
  await stubSavePicker(page);
  await page.locator('input[type=file]').setInputFiles(clip);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByText('1 / 60')).toBeVisible();

  // Selected on frame zero, and the range starts a long way after it.
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.getByRole('button', { name: 'Area' }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  const timeline = page.getByRole('slider', { name: 'Frame' });
  await timeline.fill('40');
  await page.getByRole('button', { name: 'In', exact: true }).click();
  await timeline.fill('49');
  await page.getByRole('button', { name: 'Out', exact: true }).click();

  // Nothing on the track until a range is set, and something the moment one is.
  await expect(page.locator('.timeline__range-bar')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clip' })).toHaveAttribute(
    'title',
    /^Write 00:01\.10 to 00:01\.19 as an MP4/,
  );

  await page.getByRole('button', { name: 'Clip' }).click();
  await expect(page.getByText('Wrote sample-rotyl.mp4.')).toBeVisible({ timeout: 60_000 });

  const bytes = await readPickedFile(page, 'sample-rotyl.mp4');
  // The index is still at the front on a ranged, two-track file.
  expect(boxOrder(bytes).slice(0, 2)).toEqual(['ftyp', 'moov']);

  const input = new Input({ formats: [MP4], source: new BlobSource(new Blob([bytes])) });
  const track = await input.getPrimaryVideoTrack();
  expect(track).not.toBeNull();
  if (!track) return;
  let frames = 0;
  for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, {
    metadataOnly: true,
  })) {
    if (packet.byteLength >= 0) frames++;
  }
  input.dispose();
  // Ten frames, inclusive of both ends, out of sixty.
  expect(frames).toBe(10);

  // Sound as well, and less of it: the packets that play under those ten frames.
  const sound = await audioPackets(bytes);
  expect(sound.length).toBeGreaterThan(5);
  expect(sound.length).toBeLessThan(30);

  // AND THE SELECTION REACHED IT. The rectangle was dragged on frame zero and
  // the range begins at frame forty, so a written frame that matches the source
  // everywhere would mean the log had been renumbered out from under it.
  const difference = await page.evaluate(
    async ([encoded, providerModule]) => {
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
      // The fifth frame of the written file, which is frame 44 of the source.
      const written = await pixels(new Blob([decoded]), 4);
      const source = await pixels(await (await fetch('/e2e/fixtures/sample.mp4')).blob(), 44);
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
    [Buffer.from(bytes).toString('base64'), '/src/platform/video/frame-provider.ts'] as const,
  );
  expect(difference.selected).toBeGreaterThan(6);
  expect(difference.corner).toBeLessThan(4);
  expect(difference.selected).toBeGreaterThan(difference.corner * 2);
});

/**
 * A soundtrack an MP4 cannot carry is said BEFORE the work, not after it.
 *
 * Which is the rule the destination already follows, and for the same reason: a
 * clip export is minutes of encoding, and finding out at the end that the file
 * is silent is finding out too late to do anything about it. QuickTime carries
 * mu-law and MP4 does not, so this is an ordinary file whose sound has nowhere
 * to go, and the answer costs a list lookup on a track that is already open.
 */
test('says a soundtrack cannot be carried while the file is merely open', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(mulaw);
  await expect(page.locator('canvas')).toBeVisible();

  await expect(page.getByText('its ulaw sound cannot go in an MP4')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clip' })).toHaveAttribute(
    'title',
    'Write the whole clip as an MP4. Its ulaw soundtrack is one an MP4 cannot carry, so the clip will be silent.',
  );
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

/**
 * The mask that was saved, as bytes, out of the product's own readback.
 *
 * `readSelection` is what a tracking run is seeded from, so it is the mask the
 * renderer actually holds at the engine's own 256 px square rather than
 * anything reconstructed for this test. Comparing two of these across a reload
 * is the whole claim of a saved document: not that a file was written, but that
 * replaying it rebuilds the same selection.
 */
async function selectionBytes(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const mask = await globalThis.rotyl?.engine.readSelection();
    if (!mask) return '';
    const parts: string[] = [];
    for (let at = 0; at < mask.packed.length; at += 8192) {
      parts.push(String.fromCharCode(...mask.packed.subarray(at, at + 8192)));
    }
    return btoa(parts.join(''));
  });
}

/** A saved document handed back to the page as a file, the way a picker would. */
function asFile(
  bytes: Uint8Array<ArrayBuffer>,
  name: string,
): {
  name: string;
  mimeType: string;
  buffer: Buffer;
} {
  return { name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) };
}

/**
 * A selection made, saved, the tab closed, and the same selection back.
 *
 * The one thing this chapter exists to make true, asserted on the mask rather
 * than looked at: the log is the source of truth, so a document that reproduces
 * the log reproduces the mask, and a document that quietly lost a stroke would
 * still open, still draw something, and still look right in a screenshot.
 */
test('saves a selection and rebuilds the same mask after the tab is reloaded', async ({ page }) => {
  await stubSavePicker(page);
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  // Two kinds of command, so the file is carrying a log rather than one shape.
  await page.getByRole('button', { name: 'Area' }).click();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.62, { steps: 10 });
  await page.mouse.up();

  await page.getByRole('button', { name: 'Erase' }).click();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  const before = await selectionBytes(page);
  // A guard on the guard: two empty strings compare equal.
  expect(before.length).toBeGreaterThan(100);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Wrote sample.rotyl.')).toBeVisible();

  const saved = await readPickedFile(page, 'sample.rotyl');
  // "ROTYL" and a zero, which is what a sniff reads and what refuses everything
  // else by signature.
  expect([...saved.subarray(0, 6)]).toEqual([0x52, 0x4f, 0x54, 0x59, 0x4c, 0x00]);

  // Closed on purpose, which gives the file back and takes the crash journal
  // with it. Not tidiness: without it the next load would offer the same work
  // back out of the journal, and this test would pass on a document that had
  // never been read.
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Discard edits?' }).click();

  // The tab, closed.
  await page.goto('/');
  await expect(page.getByText('Drop a file, or click to browse')).toBeVisible();

  // The document first, which is the order somebody who reloaded is in: it has
  // no media to attach to, so it waits and says which file it wants.
  await page.locator('input[type=file]').setInputFiles(asFile(saved, 'sample.rotyl'));
  await expect(page.getByText('Drop sample.png, or click to browse')).toBeVisible();
  await expect(page.getByText('A saved selection is waiting for it')).toBeVisible();

  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  expect(await selectionBytes(page)).toBe(before);
  // And no complaint: the bytes matched, so there is nothing to say about them.
  await expect(page.locator('.file-status__note')).toHaveCount(0);
});

/**
 * The other order, which is the one somebody still working is in.
 *
 * Dropped onto the editor rather than onto the drop zone, because by then there
 * is no drop zone. A document is additive to the open media and a photograph is
 * not, which is why this path takes one and refuses the other.
 */
test('takes a document dropped onto the editor, and restores where the playhead and range were', async ({
  page,
}) => {
  await stubSavePicker(page);
  await page.locator('input[type=file]').setInputFiles(clip);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByText('1 / 60')).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const timeline = page.getByRole('slider', { name: 'Frame' });
  await timeline.fill('24');
  await expect(page.getByText('25 / 60')).toBeVisible();

  await page.getByRole('button', { name: 'Area' }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.68, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  await timeline.fill('10');
  await page.getByRole('button', { name: 'In', exact: true }).click();
  await timeline.fill('44');
  await page.getByRole('button', { name: 'Out', exact: true }).click();
  await timeline.fill('24');
  await expect(page.getByText('25 / 60')).toBeVisible();

  const before = await selectionBytes(page);
  expect(before.length).toBeGreaterThan(100);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Wrote sample.rotyl.')).toBeVisible();
  const saved = await readPickedFile(page, 'sample.rotyl');

  // Given back on purpose, so the crash journal goes with it and what is tested
  // below is the document rather than the journal underneath it.
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Discard edits?' }).click();

  // A fresh tab, the clip open again, and nothing selected on it.
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(clip);
  await expect(canvas).toBeVisible();
  await expect(page.getByText('1 / 60')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(page.locator('.timeline__range-bar')).toHaveCount(0);

  const dropped = await page.evaluateHandle((encoded: string) => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'sample.rotyl', { type: 'application/octet-stream' }));
    return transfer;
  }, Buffer.from(saved).toString('base64'));
  await canvas.dispatchEvent('drop', { dataTransfer: dropped });

  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  // The playhead came back where it was, so a ten-minute clip does not reopen
  // at frame zero, and the range came back with it.
  await expect(page.getByText('25 / 60')).toBeVisible();
  await expect(page.locator('.timeline__range-bar')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Clip' })).toHaveAttribute(
    'title',
    /^Write 00:00\.10 to 00:01\.14 as an MP4/,
  );

  expect(await selectionBytes(page)).toBe(before);
});

/**
 * A document whose media is not the media, refused rather than replayed.
 *
 * The shape is what decides it: a log made on a photograph cannot describe a
 * sixty-frame clip, so there is nothing to replay and no judgement call to
 * make. What the sentence has to carry is which file it wanted, because "wrong
 * file" without that leaves somebody guessing between two on a desk.
 */
test('refuses a document whose media has been replaced by a different file', async ({ page }) => {
  await stubSavePicker(page);
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.getByRole('button', { name: 'Area' }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Wrote sample.rotyl.')).toBeVisible();
  const saved = await readPickedFile(page, 'sample.rotyl');

  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(asFile(saved, 'sample.rotyl'));
  await expect(page.getByText('Drop sample.png, or click to browse')).toBeVisible();

  // A clip instead, which is a perfectly good file and not this one.
  await page.locator('input[type=file]').setInputFiles(clip);
  await expect(canvas).toBeVisible();
  await expect(page.getByText(/so the selection does not describe it/)).toBeVisible();
  await expect(page.getByText(/made on sample\.png/)).toBeVisible();
  // The file it named is open and has nothing on it, which is the honest
  // outcome: the clip is fine, the pairing is not.
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(page.getByText('1 / 60')).toBeVisible();
});

/** A file that says it is a document and is not one, refused by signature. */
test('refuses a file that is not a document at all', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.locator('canvas')).toBeVisible();

  // "ROTYL" and a zero, a version this build does not read, and nothing else.
  const fromTheFuture = new Uint8Array(new ArrayBuffer(12));
  fromTheFuture.set([0x52, 0x4f, 0x54, 0x59, 0x4c, 0x00], 0);
  new DataView(fromTheFuture.buffer).setUint16(6, 99, true);

  const dropped = await page.evaluateHandle((encoded: string) => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'later.rotyl', { type: 'application/octet-stream' }));
    return transfer;
  }, Buffer.from(fromTheFuture).toString('base64'));
  await page.locator('canvas').dispatchEvent('drop', { dataTransfer: dropped });

  await expect(page.getByText(/written by a newer version of Rotyl/)).toBeVisible();
});

/**
 * The same picture, different bytes: opened, and said.
 *
 * The shape matched, so every command replays and every frame number means what
 * it meant. The bytes did not, so this may be a re-encode rather than the file
 * the selection was drawn on, which is an ordinary thing to have done and is
 * still worth knowing. A STATE RATHER THAN AN EVENT, so it goes beside the
 * file's name where the soundtrack warning goes, for as long as the file is
 * open, rather than in the line that takes itself down after ten seconds.
 */
test('opens a document against a re-encoded copy of its media, and says so', async ({ page }) => {
  await stubSavePicker(page);
  const original = await readFile(fixture);
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.getByRole('button', { name: 'Area' }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  const before = await selectionBytes(page);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Wrote sample.rotyl.')).toBeVisible();
  const saved = await readPickedFile(page, 'sample.rotyl');

  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(asFile(saved, 'sample.rotyl'));
  await expect(page.getByText('Drop sample.png, or click to browse')).toBeVisible();

  // The same picture with something after the end of it, which every decoder
  // ignores and no digest does. Same dimensions, different bytes, different
  // length: the case a name and a size cannot tell apart from the real one.
  await page.locator('input[type=file]').setInputFiles({
    name: 'sample.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([original, Buffer.from('rotyl-was-here')]),
  });
  await expect(canvas).toBeVisible();

  // It opened, the mask is the mask that was saved, and the row beside the name
  // says what happened.
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  expect(await selectionBytes(page)).toBe(before);
  await expect(
    page.getByText('this selection was saved against a different copy of this file'),
  ).toBeVisible();
  // Not a failure, so not in the colour this product spends on failures.
  await expect(page.locator('.notice')).toHaveCount(0);
});

/**
 * A drop that would replace unsaved work does not, and says so.
 *
 * No drop has ever been able to destroy the open session here: a photograph
 * dropped onto the editor is swallowed rather than opened, precisely so that a
 * stray drag cannot take the log with it. A saved selection is the first thing
 * capable of breaking that, and a chapter about not losing work is the wrong
 * place to introduce a way of losing it.
 */
test('will not drop a document on top of unsaved edits', async ({ page }) => {
  await stubSavePicker(page);
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.getByRole('button', { name: 'Area' }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Wrote sample.rotyl.')).toBeVisible();
  const saved = await readPickedFile(page, 'sample.rotyl');

  // A second, different selection over the top, which is the work that must
  // not vanish.
  await page.getByRole('button', { name: 'Invert' }).click();
  const nowOnScreen = await selectionBytes(page);

  const dropped = await page.evaluateHandle((encoded: string) => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'sample.rotyl', { type: 'application/octet-stream' }));
    return transfer;
  }, Buffer.from(saved).toString('base64'));
  await canvas.dispatchEvent('drop', { dataTransfer: dropped });

  await expect(page.getByText(/would replace the selection that is open/)).toBeVisible();
  // Nothing moved, and nothing failed: the line is the quiet one rather than
  // the colour this product spends on faults.
  expect(await selectionBytes(page)).toBe(nowOnScreen);
  await expect(page.locator('.notice--quiet')).toHaveCount(1);
});

/**
 * Saving where the browser cannot be given a file, which is Safari and Firefox.
 *
 * The picker is removed rather than left alone, because in the browser this
 * suite runs in it is there. One destination path means this is the same
 * `chooseFile` answering "download" and the same handoff a picture export uses,
 * so what is being checked is that a document goes down that branch at all and
 * comes back readable.
 */
test('saves a document into the downloads folder where there is nowhere to write it', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { showSaveFilePicker: undefined });
  });
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.getByRole('button', { name: 'Area' }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  const before = await selectionBytes(page);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('sample.rotyl');
  const path = await saved.path();
  expect(path).toBeTruthy();
  if (!path) return;

  // The browser announced the download, so the product says nothing, which is
  // the rule a whole clip going to the same place already follows.
  await expect(page.locator('.notice--quiet')).toHaveCount(0);

  // And what landed there is a document that reads back to the same mask.
  const bytes = await readFile(path);
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({
    name: 'sample.rotyl',
    mimeType: 'application/octet-stream',
    buffer: bytes,
  });
  await expect(page.getByText('Drop sample.png, or click to browse')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  expect(await selectionBytes(page)).toBe(before);
});

/**
 * Waits until every record posted to the journal worker has landed.
 *
 * A record is framed on the main thread and appended in a worker, so the write
 * is behind a message. Nothing in the product waits for it and nothing should:
 * an edit costs 0.13 ms in another thread precisely because nobody is watching
 * it. A test that reloaded the moment a stroke ended would be racing that, and
 * reading the file until it stops growing is the honest way to stand still.
 *
 * The file is read from the MAIN thread while the worker holds a sync access
 * handle over it, which is the same thing a recovery does on the next load.
 */
async function journalledBytes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('rotyl');
      return (await (await directory.getFileHandle('session.journal')).getFile()).size;
    } catch {
      return 0;
    }
  });
}

/** An edit is written down; wait for the bytes to stop arriving. */
async function journalSettles(page: Page): Promise<number> {
  let last = -1;
  for (let attempt = 0; attempt < 40; attempt++) {
    const size = await journalledBytes(page);
    if (size > 0 && size === last) return size;
    last = size;
  }
  return last;
}

/**
 * A session that ended without being saved, offered back and rebuilt exactly.
 *
 * The chapter before this one gave the log a file and a button. What a button
 * cannot do is protect the work between presses, so this is the same assertion
 * the save round trip makes with the save taken out of it: a selection, a tab
 * that ends, and the same mask on the other side.
 */
test('offers back the work of a session that ended without saving', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.getByRole('button', { name: 'Area' }).click();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.66, { steps: 10 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Erase' }).click();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.54, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  const before = await selectionBytes(page);
  expect(before.length).toBeGreaterThan(100);
  expect(await journalSettles(page)).toBeGreaterThan(0);

  // Nothing was saved. Nothing was even offered to be saved: no picker, no
  // download, no file anywhere the user chose.
  let downloaded = 0;
  page.on('download', () => {
    downloaded++;
  });

  // The tab, ending.
  await page.goto('/');
  await expect(page.getByText('Drop sample.png, or click to browse')).toBeVisible();
  await expect(page.getByText('Work from a session that ended is waiting for it')).toBeVisible();

  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  expect(await selectionBytes(page)).toBe(before);
  expect(downloaded).toBe(0);

  // AND THE JOURNAL IT CAME OUT OF IS CARRIED ON RATHER THAN REWRITTEN. A
  // recovery that began again would append every record it had just read, and
  // until it finished the file would not hold the work it exists to protect.
  const resumed = await journalSettles(page);
  expect(resumed).toBeLessThan(2000);

  // A second ending, and the work is still there: recovery is not a one-shot.
  await page.goto('/');
  await expect(page.getByText('Work from a session that ended is waiting for it')).toBeVisible();
});

/**
 * Undo cuts the journal back, because the journal is the applied commands.
 *
 * A journal that only ever grew would offer back work its own session had
 * already taken away, which is a worse failure than losing it: the user undid
 * something and it came back.
 */
test('takes an undone edit back out of the journal', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.getByRole('button', { name: 'Area' }).click();

  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await journalSettles(page);
  const afterOne = await selectionBytes(page);

  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9, { steps: 8 });
  await page.mouse.up();
  const grown = await journalSettles(page);
  expect(await selectionBytes(page)).not.toBe(afterOne);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();
  // Cut back, not annotated: the file is smaller than it was with two edits in
  // it, which is the difference between a journal and a transcript.
  await expect.poll(async () => journalledBytes(page)).toBeLessThan(grown);

  await page.goto('/');
  await expect(page.getByText('Work from a session that ended is waiting for it')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  // The one edit that was left, and not the one that was taken back.
  expect(await selectionBytes(page)).toBe(afterOne);
  // And nothing to redo: a document holds work that was done.
  await expect(page.getByRole('button', { name: 'Redo' })).toBeDisabled();
});

/**
 * Closing the file gives it back, so there is nothing to come back to.
 *
 * The close button already asks when there is something to lose, which is the
 * one place the user says "discard this". A journal that survived that would be
 * offering back work they had just been asked about and let go.
 */
test('offers nothing back after the file was closed on purpose', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(fixture);
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.getByRole('button', { name: 'Area' }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  expect(await journalSettles(page)).toBeGreaterThan(0);

  // Closing over work asks once, in place.
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Discard edits?' }).click();
  await expect(page.getByText('Drop a file, or click to browse')).toBeVisible();
  await expect(page.getByText('is waiting for it')).toHaveCount(0);

  await page.goto('/');
  await expect(page.getByText('Drop a file, or click to browse')).toBeVisible();
  await expect(page.getByText('is waiting for it')).toHaveCount(0);
});
