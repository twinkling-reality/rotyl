// WHERE a style flickers, rather than how much.
//
// The stability measurements report a 99th percentile and a percentage of
// pixels moving more than eight codes, and both are the right numbers to decide
// with. Neither says WHICH pixels, and that turned out to be the whole of one
// diagnosis: the poster chain's flicker on a photograph is 2% of pixels, which
// reads as a diffuse shimmer until you see it and it is not diffuse at all. It
// is the ink, appearing and disappearing along boundaries the flatten found
// marginal. That is a different bug from the one the number describes, and it
// pointed straight at the one stage whose decision is taken against a
// neighbour.
//
// So this exists for the same reason `stills` does. A bench that reports only
// scalars can tell you a chain got steadier while telling you nothing about
// what moved.
//
// One picture rendered twice with grain of a known size added the second time,
// which is `perturbation`'s experiment: no codec, no camera, no subject, so
// everything that moves is the style's own doing. What comes back is the styled
// frame at half brightness with every pixel that moved more than eight codes
// painted red over it.

import { CONTENT_CASES } from './chain.ts';
import { difference, pictureBytes, REAL_PICTURES, SCENE_PICTURE, StyleStage } from './harness.ts';
import { toBase64, type Still } from './stills.ts';

const SIZE = { width: 1280, height: 720 };

/** Plainly visible, and the same threshold the stability tables call flicker. */
const VISIBLE = 8;

/** The same perturbation `perturbation` uses, at the sigma that shows something. */
const SIGMA = 2;
const SEED = 0x51de + 20;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function perturb(source: Uint8Array, sigma: number, seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const out = new Uint8Array(source);
  for (let i = 0; i < out.length; i += 4) {
    const luma = Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng()) * sigma;
    for (let c = 0; c < 3; c++) {
      const jitter = (rng() - 0.5) * sigma;
      out[i + c] = Math.max(0, Math.min(255, Math.round((source[i + c] ?? 0) + luma + jitter)));
    }
  }
  return out;
}

/**
 * The styled frame, dimmed, with what moved painted over it.
 *
 * Over the frame rather than beside it, because the question this answers is
 * "which part of the picture" and a difference image on its own has no picture
 * in it to point at.
 */
function map(styled: Uint8Array, shaken: Uint8Array): { rgb: Uint8Array; moved: number } {
  const pixels = styled.length / 4;
  const rgb = new Uint8Array(pixels * 3);
  let moved = 0;
  for (let i = 0, o = 0; i < pixels; i++, o += 3) {
    const at = i * 4;
    const delta = Math.max(
      Math.abs((styled[at] ?? 0) - (shaken[at] ?? 0)),
      Math.abs((styled[at + 1] ?? 0) - (shaken[at + 1] ?? 0)),
      Math.abs((styled[at + 2] ?? 0) - (shaken[at + 2] ?? 0)),
    );
    if (delta > VISIBLE) {
      moved++;
      rgb[o] = 255;
      rgb[o + 1] = 40;
      rgb[o + 2] = 40;
    } else {
      rgb[o] = (styled[at] ?? 0) >> 1;
      rgb[o + 1] = (styled[at + 1] ?? 0) >> 1;
      rgb[o + 2] = (styled[at + 2] ?? 0) >> 1;
    }
  }
  return { rgb, moved: Math.round((moved / pixels) * 10000) / 100 };
}

export async function flicker(device: GPUDevice): Promise<readonly Still[]> {
  const out: Still[] = [];
  const stage = new StyleStage(device, SIZE);

  for (const picture of [SCENE_PICTURE, ...REAL_PICTURES]) {
    const base = await pictureBytes(picture, SIZE.width, SIZE.height);
    const shaken = perturb(base, SIGMA, SEED);

    for (const item of CONTENT_CASES) {
      stage.uploadBytes(base);
      await stage.render(item.style, item.controls, 'full', true);
      const styled = await stage.readOutput();

      stage.uploadBytes(shaken);
      await stage.render(item.style, item.controls, 'full', true);
      const second = await stage.readOutput();

      const { rgb, moved } = map(styled, second);
      const spread = difference(styled, second);
      out.push({
        name: `flicker ${picture.name} ${item.name}`,
        width: SIZE.width,
        height: SIZE.height,
        rgb: toBase64(rgb, 3),
        labels: [`${String(moved)}% moved more than ${String(VISIBLE)} codes`, `p99 ${String(spread.p99)}`],
      });
    }
  }

  stage.dispose();
  return out;
}
