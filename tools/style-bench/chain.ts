// MEASUREMENT 1: what each style costs, in a browser, fenced.
//
// An earlier version of this project timed the comic chain and said plainly
// that the print chain had never been timed the same way - three passes against nineteen, only one
// at output resolution, so it *should* be cheaper, but that is an argument
// rather than a measurement. This is the measurement.
//
// The style chain alone: the composite is a separate pass that runs on every
// brush movement and is timed elsewhere. What is timed here is what changes
// when a control moves and what has to happen for every frame of video.

import { COMIC_STYLE } from '../../src/core/style/comic/comic-style-pipeline.ts';
import { POSTER_STYLE } from '../../src/core/style/poster/poster-style-pipeline.ts';
import { PRINT_STYLE } from '../../src/core/style/print/print-style-pipeline.ts';
import {
  defaultControls,
  type StyleControls,
  type StyleDefinition,
  type StyleQuality,
} from '../../src/core/style/style.ts';
import { loadPicture, REAL_PICTURES, SCENE_PICTURE, StyleStage, type Picture } from './harness.ts';
import { sample, type Stat } from '../video-bench/util.ts';

export interface Case {
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

/**
 * The five cases the content question actually turns on.
 *
 * The full list above sweeps controls, which is a different question and costs
 * four times as long to answer. What is being asked here is whether cost
 * depends on the picture, and the only stage anyone expects that of is the
 * anisotropic Kuwahara, whose sample bound grows with local anisotropy. So:
 * the three defaults, and the two comic settings that move its flatten buffer.
 */
export const CONTENT_CASES: readonly Case[] = [
  ...CASES.filter((item) =>
    ['comic, default', 'comic, detail 0', 'comic, detail 1', 'poster, default', 'print, default'].includes(
      item.name,
    ),
  ),
  // A diagnostic rather than a setting anyone would ship: the poster style with
  // its outline turned off. The line is the only stage in that chain whose
  // decision is taken against a NEIGHBOUR's colour, which is the one place a
  // derivative cannot reach, so it is the first thing to rule in or out when
  // the chain moves more than its input did.
  { style: POSTER_STYLE, name: 'poster, no line', controls: withControls(POSTER_STYLE, { line: 0 }) },
];

async function over(
  device: GPUDevice,
  picture: Picture,
  cases: readonly Case[],
  qualities: readonly StyleQuality[],
): Promise<Record<string, Record<string, Record<string, Stat>>>> {
  const out: Record<string, Record<string, Record<string, Stat>>> = {};

  for (const size of SIZES) {
    const stage = new StyleStage(device, size);
    const bitmap = await loadPicture(picture, size.width, size.height);
    stage.uploadImage(bitmap);
    bitmap.close();

    const rows: Record<string, Record<string, Stat>> = {};
    for (const item of cases) {
      const row: Record<string, Stat> = {};
      for (const quality of qualities) {
        // Warm-up covers pipeline creation on first use and the stage
        // reallocation that follows a control change; both are once per
        // session in the product and would otherwise land in the median.
        row[quality] = await sample(11, 3, async () => {
          await stage.render(item.style, item.controls, quality);
        });
      }
      rows[item.name] = row;
    }
    out[size.name] = rows;

    stage.dispose();
  }

  return out;
}

export async function chain(device: GPUDevice): Promise<unknown> {
  return over(device, SCENE_PICTURE, CASES, ['draft', 'full', 'export']);
}

/**
 * The same ladder against four photographs, with the synthetic scene as the
 * control row rather than as a table somewhere else.
 *
 * A control that sits in another results file taken on another day is not a
 * control. Re-taking it here costs one more picture and makes every comparison
 * in the table a comparison between two runs of the same loop on the same
 * machine within the same minute.
 */
export async function realChain(device: GPUDevice): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const picture of [SCENE_PICTURE, ...REAL_PICTURES]) {
    out[picture.name] = await over(device, picture, CONTENT_CASES, ['full']);
  }
  return out;
}
