// A contact sheet: one style, one axis of its controls per dimension, in one
// picture.
//
// Tuning a look by rendering one variant at a time and remembering the last
// one is how a style ends up with parameters nobody can defend. A grid can be
// judged in a glance, and the comparison is against the thing next to it
// rather than against a memory.
//
// Rendered at full size and box-downsampled by two on the way out, so each tile
// is the picture the style actually makes at 1280x720 rather than the different
// picture it would make at 640x360 - the flatten buffer clamps to the output's
// short edge, so a small render is not a small version of a large one.

import { defaultControls, type StyleControls, type StyleDefinition } from '../../src/core/style/style.ts';
import { POSTER_STYLE } from '../../src/core/style/poster/poster-style-pipeline.ts';
import { loadScene, StyleStage } from './harness.ts';

const TILE = { width: 1280, height: 720 };

export interface Sheet {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly labels: readonly string[];
  /** Base64 of tightly packed 8-bit RGB, the whole sheet. */
  readonly rgb: string;
}

interface Axis {
  readonly key: string;
  readonly values: readonly number[];
}

/** Box-downsample by two, in the encoded values, which is what a contact sheet is. */
function halve(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const w = width >> 1;
  const h = height >> 1;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const at = (dx: number, dy: number): number => rgba[((y * 2 + dy) * width + x * 2 + dx) * 4 + c] ?? 0;
        out[(y * w + x) * 3 + c] = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) >> 2;
      }
    }
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function sheet(
  device: GPUDevice,
  style: StyleDefinition,
  name: string,
  rows: Axis,
  columns: Axis,
  fixed: Record<string, number>,
): Promise<Sheet> {
  const stage = new StyleStage(device, TILE);
  const bitmap = await loadScene(TILE.width, TILE.height);
  stage.uploadImage(bitmap);
  bitmap.close();

  const tileWidth = TILE.width >> 1;
  const tileHeight = TILE.height >> 1;
  const width = tileWidth * columns.values.length;
  const height = tileHeight * rows.values.length;
  const canvas = new Uint8Array(width * height * 3);
  const labels: string[] = [];

  for (const [row, rowValue] of rows.values.entries()) {
    for (const [column, columnValue] of columns.values.entries()) {
      const controls: StyleControls = {
        ...defaultControls(style),
        ...fixed,
        [rows.key]: rowValue,
        [columns.key]: columnValue,
      };
      await stage.render(style, controls, 'full', true);
      const tile = halve(await stage.readOutput(), TILE.width, TILE.height);

      for (let y = 0; y < tileHeight; y++) {
        const from = y * tileWidth * 3;
        const to = ((row * tileHeight + y) * width + column * tileWidth) * 3;
        canvas.set(tile.subarray(from, from + tileWidth * 3), to);
      }
      labels.push(`${rows.key} ${String(rowValue)}, ${columns.key} ${String(columnValue)}`);
    }
  }

  stage.dispose();
  return { name, width, height, columns: columns.values.length, labels, rgb: toBase64(canvas) };
}

export async function sweep(device: GPUDevice): Promise<readonly Sheet[]> {
  const detail: Axis = { key: 'detail', values: [0.25, 0.5, 0.75] };
  const strength: Axis = { key: 'strength', values: [0.4, 0.7, 1] };

  return [
    await sheet(device, POSTER_STYLE, 'poster-detail-strength', detail, strength, { palette: 0 }),
    await sheet(device, POSTER_STYLE, 'poster-riso-detail-strength', detail, strength, { palette: 2 }),
  ];
}
