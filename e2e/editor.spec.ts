import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * One end-to-end pass through the product's actual claim: open an image, select
 * part of it, see only that part change, and save a full-resolution file.
 *
 * The unit suite covers correctness pixel by pixel; this covers the things only
 * a real browser can answer — that WebGPU comes up, that a file picker and a
 * pointer drive the engine, and that the download produces bytes.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
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
  const print = page.getByRole('button', { name: 'Print' });
  await expect(comic).toHaveAttribute('aria-pressed', 'true');
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

test('refuses a video it cannot decode, by name', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(webm);
  await expect(page.getByText('WebM and Matroska are not supported yet. MP4 and MOV work.')).toBeVisible();
  // Refused, not half-loaded: the drop zone is still the thing on screen.
  await expect(page.getByText('Drop a file, or click to browse')).toBeVisible();
});
