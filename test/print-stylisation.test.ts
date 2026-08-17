import { beforeAll, describe, expect, it } from 'vitest';
import { PRINT_STYLE } from '../src/core/style/print/print-style-pipeline.ts';
import {
  expectFiniteEverywhere,
  expectSelectedTransformed,
  expectUnselectedUntouched,
  renderSplit,
  SEAM,
  type SplitRender,
} from './style-harness.ts';

/**
 * The same contract as the comic style, through the same compositor, with
 * nothing shared between the two but the seam. That is the whole point of this
 * file: if adding a style had required a change to the composite, this test
 * would have had to be written differently from its neighbour, and it is not.
 *
 * Rendered larger than the comic case because this style has a characteristic
 * scale. Below about four output pixels per screen cell the screen is past
 * Nyquist and falls back to flat tone deliberately, so a 192 px fixture would
 * exercise the fallback and quietly stop testing the dots.
 */
const SIZE = 512;

/** Mean absolute difference between horizontally adjacent pixels, summed over rgb. */
function adjacentContrast(pixels: Uint8Array, size: number): number {
  let total = 0;
  let counted = 0;
  for (let y = 0; y < size; y++) {
    for (let x = size / 2 + SEAM; x < size - 1; x++) {
      const i = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        total += Math.abs((pixels[i + channel] ?? 0) - (pixels[i + 4 + channel] ?? 0));
      }
      counted++;
    }
  }
  return total / Math.max(counted, 1);
}

describe('print', () => {
  let rendered: SplitRender;

  beforeAll(async () => {
    rendered = await renderSplit(PRINT_STYLE, SIZE);
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

  it('lays down a screen rather than a flat tone', () => {
    // The style's own claim, and the one thing the shared contract cannot make:
    // a halftone swings between paper and full ink over a few pixels, so
    // neighbouring pixels differ far more than in the smooth photograph it came
    // from. Without this, silently taking the undersampled fallback everywhere
    // would still pass every other assertion in this file.
    const before = adjacentContrast(rendered.source, SIZE);
    const after = adjacentContrast(rendered.output, SIZE);
    expect(after).toBeGreaterThan(before * 3);
    expect(after).toBeGreaterThan(20);
  });
});
