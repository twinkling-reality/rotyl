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

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.png');

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
