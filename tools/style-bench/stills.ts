// The pictures, not the numbers.
//
// A style bench that only reports milliseconds and difference metrics can tell
// you a chain got faster and steadier while it got worse to look at. So every
// case renders once through the real composite and comes back as bytes, which
// run.mjs writes out as PNGs.

import { loadScene, StyleStage } from './harness.ts';
import { CASES } from './chain.ts';

export interface Still {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Base64 of tightly packed 8-bit RGB. */
  readonly rgb: string;
  /** Printed beside the filename by run.mjs, for a picture that carries a figure. */
  readonly labels?: readonly string[];
}

const SIZE = { width: 1280, height: 720 };

/**
 * Tightly packed 8-bit RGB, base64 encoded, from RGBA or from RGB already.
 *
 * `channels` because two callers want it: a texture read comes back with an
 * alpha nothing here uses, and a diagnostic that composes its own picture has
 * no reason to add one just to have it dropped again.
 */
export function toBase64(source: Uint8Array, channels: 3 | 4 = 4): string {
  if (channels === 3) return encode(source);
  const rgb = new Uint8Array((source.length / 4) * 3);
  for (let i = 0, o = 0; i < source.length; i += 4, o += 3) {
    rgb[o] = source[i] ?? 0;
    rgb[o + 1] = source[i + 1] ?? 0;
    rgb[o + 2] = source[i + 2] ?? 0;
  }
  return encode(rgb);
}

function encode(rgb: Uint8Array): string {
  // In chunks: String.fromCharCode with a few million arguments overflows the
  // call stack, and it is the same string either way.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < rgb.length; i += CHUNK) {
    binary += String.fromCharCode(...rgb.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function stills(device: GPUDevice): Promise<readonly Still[]> {
  const stage = new StyleStage(device, SIZE);
  const bitmap = await loadScene(SIZE.width, SIZE.height);
  stage.uploadImage(bitmap);
  bitmap.close();

  const out: Still[] = [];
  for (const item of CASES) {
    await stage.render(item.style, item.controls, 'full', true);
    out.push({
      name: item.name,
      width: SIZE.width,
      height: SIZE.height,
      rgb: toBase64(await stage.readOutput()),
    });
  }

  stage.dispose();
  return out;
}
