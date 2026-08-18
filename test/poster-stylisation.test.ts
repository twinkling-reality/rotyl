import { beforeAll, describe, expect, it } from 'vitest';
import { POSTER_STYLE } from '../src/core/style/poster/poster-style-pipeline.ts';
import {
  expectFiniteEverywhere,
  expectSelectedTransformed,
  expectUnselectedUntouched,
  renderSplit,
  SEAM,
  type SplitRender,
} from './style-harness.ts';

/**
 * The third style through the same harness, and the reason the harness exists.
 *
 * Nothing in the compositor, the engine, the export path or the panel changed
 * to add this style, so this file is its neighbours' file with one import
 * different — which is the only real test of whether the style seam is a seam.
 *
 * Rendered at 1024 because this style has a characteristic scale, and the
 * fixture's ripples do not: the flatten radius is a few percent of the short
 * edge while the ripples are a fixed 52 pixels apart, so at 512 the flatten is
 * too narrow to merge them and the test measures a filter that never ran.
 */
const SIZE = 1024;

/** Largest of the three channel differences between horizontally adjacent pixels. */
function step(pixels: Uint8Array, at: number): number {
  return Math.max(
    Math.abs((pixels[at] ?? 0) - (pixels[at + 4] ?? 0)),
    Math.abs((pixels[at + 1] ?? 0) - (pixels[at + 5] ?? 0)),
    Math.abs((pixels[at + 2] ?? 0) - (pixels[at + 6] ?? 0)),
  );
}

/**
 * How much of the selected region is flat, and how much of it is a hard step.
 *
 * ONE PASS, NO ALLOCATION. An `Array.every` over three channels per pixel is
 * a million short-lived closures across a fixture this size, and the garbage
 * that produces while a Dawn device is alive aborts the worker outright — the
 * same hazard the suite already documents for calling expect() per pixel,
 * arriving through a different door.
 */
function texture(pixels: Uint8Array, size: number): { flat: number; steps: number } {
  let flat = 0;
  let steps = 0;
  let counted = 0;
  for (let y = 0; y < size; y++) {
    for (let x = size / 2 + SEAM; x < size - 1; x++) {
      const difference = step(pixels, (y * size + x) * 4);
      if (difference <= 1) flat++;
      if (difference > 12) steps++;
      counted++;
    }
  }
  return { flat: flat / Math.max(counted, 1), steps: steps / Math.max(counted, 1) };
}

describe('poster', () => {
  let rendered: SplitRender;

  beforeAll(async () => {
    rendered = await renderSplit(POSTER_STYLE, SIZE);
  });

  it('leaves unselected pixels byte-identical to the source', () => {
    expectUnselectedUntouched(rendered);
  });

  it('visibly transforms the selected region', () => {
    expectSelectedTransformed(rendered);
  });

  it('produces a finite result everywhere', () => {
    expectFiniteEverywhere(rendered);
  });

  it('turns a gradient into areas with edges between them', () => {
    // This style's own claim, and the one the shared contract cannot make. Both
    // halves are load-bearing: a chain that merely blurred the picture would
    // raise the flat fraction just as well, and only a chain that QUANTISES
    // raises the flat fraction and the number of hard steps at the same time.
    const before = texture(rendered.source, SIZE);
    const after = texture(rendered.output, SIZE);

    expect(before.flat).toBeLessThan(0.55);
    expect(after.flat).toBeGreaterThan(0.75);
    expect(after.steps).toBeGreaterThan(before.steps * 4);
  });
});
