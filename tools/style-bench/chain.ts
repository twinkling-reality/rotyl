// MEASUREMENT 1: what each style costs, in a browser, fenced.
//
// The root README timed the comic chain and said plainly that the print chain
// had never been timed the same way - three passes against nineteen, only one
// at output resolution, so it *should* be cheaper, but that is an argument
// rather than a measurement. This is the measurement.
//
// The style chain alone: the composite is a separate pass that runs on every
// brush movement and is timed elsewhere. What is timed here is what changes
// when a control moves and what has to happen for every frame of video.

import { COMIC_STYLE } from '../../src/core/style/comic/comic-style-pipeline.ts';
import { POSTER_STYLE } from '../../src/core/style/poster/poster-style-pipeline.ts';
import { PRINT_STYLE } from '../../src/core/style/print/print-style-pipeline.ts';
import { defaultControls, type StyleControls, type StyleDefinition } from '../../src/core/style/style.ts';
import { loadScene, StyleStage } from './harness.ts';
import { sample, type Stat } from '../video-bench/util.ts';

interface Case {
  readonly style: StyleDefinition;
  readonly name: string;
  readonly controls: StyleControls;
}

function withControls(style: StyleDefinition, overrides: Record<string, number>): StyleControls {
  return { ...defaultControls(style), ...overrides };
}

export const CASES: readonly Case[] = [
  { style: COMIC_STYLE, name: 'comic, default', controls: defaultControls(COMIC_STYLE) },
  { style: COMIC_STYLE, name: 'comic, detail 0', controls: withControls(COMIC_STYLE, { detail: 0 }) },
  { style: COMIC_STYLE, name: 'comic, detail 1', controls: withControls(COMIC_STYLE, { detail: 1 }) },
  {
    style: COMIC_STYLE,
    name: 'comic, palette Mural',
    controls: withControls(COMIC_STYLE, { palette: 1 }),
  },
  { style: POSTER_STYLE, name: 'poster, default', controls: defaultControls(POSTER_STYLE) },
  { style: POSTER_STYLE, name: 'poster, detail 0', controls: withControls(POSTER_STYLE, { detail: 0 }) },
  { style: POSTER_STYLE, name: 'poster, detail 1', controls: withControls(POSTER_STYLE, { detail: 1 }) },
  {
    style: POSTER_STYLE,
    name: 'poster, palette Mural',
    controls: withControls(POSTER_STYLE, { palette: 1 }),
  },
  {
    style: POSTER_STYLE,
    name: 'poster, palette Riso',
    controls: withControls(POSTER_STYLE, { palette: 2 }),
  },
  { style: PRINT_STYLE, name: 'print, default', controls: defaultControls(PRINT_STYLE) },
  { style: PRINT_STYLE, name: 'print, fine', controls: withControls(PRINT_STYLE, { coarseness: 0 }) },
  { style: PRINT_STYLE, name: 'print, coarse', controls: withControls(PRINT_STYLE, { coarseness: 1 }) },
];

/**
 * Sizes, at a photograph's 3:2 rather than the scene's 16:9.
 *
 * Matching the aspect the existing table was taken at matters more than
 * matching the picture: cost is set by pixel count and by the stage
 * resolutions derived from the short edge, and both of those follow the shape.
 */
const SIZES = [
  { name: '720p', width: 1280, height: 720 },
  { name: '2 MP', width: 1728, height: 1152 },
  { name: '12 MP', width: 4242, height: 2828 },
  { name: '24 MP', width: 6000, height: 4000 },
] as const;

export async function chain(device: GPUDevice): Promise<unknown> {
  const out: Record<string, Record<string, Record<string, Stat>>> = {};
  const rowsFor = (size: string): Record<string, Record<string, Stat>> => (out[size] ??= {});

  for (const size of SIZES) {
    const stage = new StyleStage(device, size);
    const bitmap = await loadScene(size.width, size.height);
    stage.uploadImage(bitmap);
    bitmap.close();

    for (const item of CASES) {
      const row: Record<string, Stat> = {};
      for (const quality of ['draft', 'full', 'export'] as const) {
        // Warm-up covers pipeline creation on first use and the stage
        // reallocation that follows a control change; both are once per
        // session in the product and would otherwise land in the median.
        row[quality] = await sample(11, 3, async () => {
          await stage.render(item.style, item.controls, quality);
        });
      }
      rowsFor(size.name)[item.name] = row;
    }

    stage.dispose();
  }

  return out;
}
