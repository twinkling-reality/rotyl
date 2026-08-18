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
import { halve, tile, toBase64 } from './sheet.ts';

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

  const tiles: Uint8Array[] = [];
  const labels: string[] = [];

  for (const rowValue of rows.values) {
    for (const columnValue of columns.values) {
      const controls: StyleControls = {
        ...defaultControls(style),
        ...fixed,
        [rows.key]: rowValue,
        [columns.key]: columnValue,
      };
      await stage.render(style, controls, 'full', true);
      tiles.push(halve(await stage.readOutput(), TILE.width, TILE.height));
      labels.push(`${rows.key} ${String(rowValue)}, ${columns.key} ${String(columnValue)}`);
    }
  }

  stage.dispose();
  const laid = tile(tiles, TILE.width >> 1, TILE.height >> 1, columns.values.length);
  return {
    name,
    width: laid.width,
    height: laid.height,
    columns: columns.values.length,
    labels,
    rgb: toBase64(laid.rgb),
  };
}

export async function sweep(device: GPUDevice): Promise<readonly Sheet[]> {
  const detail: Axis = { key: 'detail', values: [0.25, 0.5, 0.75] };
  const strength: Axis = { key: 'strength', values: [0.4, 0.7, 1] };

  return [
    await sheet(device, POSTER_STYLE, 'poster-detail-strength', detail, strength, { palette: 0 }),
    await sheet(device, POSTER_STYLE, 'poster-riso-detail-strength', detail, strength, { palette: 2 }),
  ];
}
