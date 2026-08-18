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
}

const SIZE = { width: 1280, height: 720 };

function toBase64(rgba: Uint8Array): string {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    rgb[o] = rgba[i] ?? 0;
    rgb[o + 1] = rgba[i + 1] ?? 0;
    rgb[o + 2] = rgba[i + 2] ?? 0;
  }
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
