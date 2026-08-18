// MEASUREMENT 0c: where a picture's lightness actually lives.
//
// The levels stage exists because of one claim: a photograph occupies about
// half the lightness range every palette assumes, so a palette applied
// literally is read through two and a half of its five stops and the whole
// frame comes out in one colour. That claim was measured on make-scene.mjs,
// which was DRAWN to be hazy. Measuring the property you built the input to
// have is not a measurement, and the fix it justified is the largest single
// change to how a stylised frame looks.
//
// So it is re-taken here against four photographs, one of which is a real hazy
// street and three of which are not.
//
// In Oklab L, on the sRGB bytes the chain is handed, through the same transfer
// function the hardware applies on the way in. `spread` is the standard
// deviation, which is what the affine map in wgsl/levels.wgsl scales.

import { linearToOklab } from '../../src/core/color/oklab.ts';
import { srgbToLinear } from '../../src/core/color/srgb.ts';
import { PALETTES, paletteLightness } from '../../src/core/style/palette.ts';
import { pictureBytes, REAL_PICTURES, SCENE_PICTURE, type Picture } from './harness.ts';

const SIZE = { width: 1280, height: 720 };

/** Enough bins that a percentile is exact to a thousandth, which is past what is claimed. */
const BINS = 1024;

interface Lightness {
  readonly p1: number;
  readonly p50: number;
  readonly p99: number;
  readonly mean: number;
  readonly spread: number;
  /** Mean Oklab chroma, which decides whether a picture has hue worth keeping. */
  readonly chroma: number;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

function lightness(rgba: Uint8Array): Lightness {
  // A histogram rather than an array of samples: a million floats to sort is
  // 8 MB and a percentile does not need them in order, only counted.
  const histogram = new Float64Array(BINS);
  let sum = 0;
  let sumSquares = 0;
  let chroma = 0;
  let n = 0;

  // One table for the transfer function, so the inner loop is three lookups
  // rather than three pow() calls a million times over.
  const linear = new Float64Array(256);
  for (let i = 0; i < 256; i++) linear[i] = srgbToLinear(i / 255);

  for (let i = 0; i < rgba.length; i += 4) {
    const lab = linearToOklab({
      r: linear[rgba[i] ?? 0] ?? 0,
      g: linear[rgba[i + 1] ?? 0] ?? 0,
      b: linear[rgba[i + 2] ?? 0] ?? 0,
    });
    const value = Math.min(1, Math.max(0, lab.L));
    const bin = Math.min(BINS - 1, Math.floor(value * BINS));
    histogram[bin] = (histogram[bin] ?? 0) + 1;
    sum += value;
    sumSquares += value * value;
    chroma += Math.hypot(lab.a, lab.b);
    n++;
  }

  const at = (fraction: number): number => {
    let seen = 0;
    for (let bin = 0; bin < BINS; bin++) {
      seen += histogram[bin] ?? 0;
      if (seen >= n * fraction) return (bin + 0.5) / BINS;
    }
    return 1;
  };

  const mean = sum / n;
  return {
    p1: round(at(0.01)),
    p50: round(at(0.5)),
    p99: round(at(0.99)),
    mean: round(mean),
    spread: round(Math.sqrt(Math.max(0, sumSquares / n - mean * mean))),
    chroma: round(chroma / n),
  };
}

export async function lightnessStats(): Promise<unknown> {
  const pictures: Record<string, Lightness> = {};
  for (const picture of [SCENE_PICTURE, ...REAL_PICTURES] as readonly Picture[]) {
    pictures[picture.name] = lightness(await pictureBytes(picture, SIZE.width, SIZE.height));
  }

  // The palettes' own statistics, from the product's own function rather than
  // from a copy of the numbers. What the levels pass maps a picture ONTO.
  const palettes: Record<string, unknown> = {};
  for (const [index, palette] of PALETTES.entries()) {
    if (index === 0) continue; // "None" is not a palette, it is the absence of one.
    palettes[palette.name] = paletteLightness(index);
  }

  return { pictures, palettes };
}
