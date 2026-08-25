import { ANIME_STYLE } from '../../src/core/style/anime/anime-style-pipeline.ts';
import { defaultControls } from '../../src/core/style/style.ts';
import { StyleStage } from './harness.ts';
import { toBase64 } from './stills.ts';

const LONG_EDGE = 1200;

const CASES = [
  {
    name: 'portrait-somali',
    image: '/tools/style-bench/out/evaluation/portrait-somali-source.png',
    mask: '/tools/style-bench/out/evaluation/masks/portrait-somali.png',
  },
  {
    name: 'portrait-lehna',
    image: '/tools/style-bench/out/evaluation/portrait-lehna-source.png',
    mask: '/tools/style-bench/out/evaluation/masks/portrait-lehna.png',
  },
  {
    name: 'portrait-hands',
    image: '/tools/style-bench/out/evaluation/portrait-hands-source.png',
    mask: '/tools/style-bench/out/evaluation/masks/portrait-hands.png',
  },
  {
    name: 'tos-occlusion-mid',
    image: '/tools/style-bench/out/evaluation/tos-occlusion-mid-source.png',
    mask: '/tools/style-bench/out/evaluation/masks/tos-occlusion-mid.png',
  },
] as const;

export interface SelectiveEvalStill {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly source: string;
  readonly mask: string;
  readonly full: string;
  readonly composite: string;
  readonly outsideMax: number;
  readonly method: 'grabcut-substitute';
}

async function loadRgb(
  url: string,
  width?: number,
  height?: number,
): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
  const blob = await (await fetch(url)).blob();
  if (width && height) {
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
    return { bitmap, width, height };
  }
  const full = await createImageBitmap(blob);
  const longest = Math.max(full.width, full.height);
  if (longest <= LONG_EDGE) return { bitmap: full, width: full.width, height: full.height };
  const scale = LONG_EDGE / longest;
  const nextWidth = Math.max(1, Math.round(full.width * scale));
  const nextHeight = Math.max(1, Math.round(full.height * scale));
  try {
    const bitmap = await createImageBitmap(full, {
      resizeWidth: nextWidth,
      resizeHeight: nextHeight,
      resizeQuality: 'high',
    });
    return { bitmap, width: nextWidth, height: nextHeight };
  } finally {
    full.close();
  }
}

function coverageFromRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const coverage = new Uint8Array(width * height);
  for (let i = 0; i < coverage.length; i++) coverage[i] = rgba[i * 4] ?? 0;
  return coverage;
}

function maskRgb(coverage: Uint8Array): Uint8Array {
  const rgb = new Uint8Array(coverage.length * 3);
  for (let i = 0; i < coverage.length; i++) {
    const value = coverage[i] ?? 0;
    rgb[i * 3] = value;
    rgb[i * 3 + 1] = value;
    rgb[i * 3 + 2] = value;
  }
  return rgb;
}

function outsideMax(source: Uint8Array, composite: Uint8Array, coverage: Uint8Array): number {
  let max = 0;
  for (let i = 0; i < coverage.length; i++) {
    if ((coverage[i] ?? 0) > 8) continue;
    const o = i * 4;
    max = Math.max(
      max,
      Math.abs((source[o] ?? 0) - (composite[o] ?? 0)),
      Math.abs((source[o + 1] ?? 0) - (composite[o + 1] ?? 0)),
      Math.abs((source[o + 2] ?? 0) - (composite[o + 2] ?? 0)),
    );
  }
  return max;
}

/**
 * Source, GrabCut mask, full-frame Anime, and the real compositor's selective
 * mix. The mask is a labelled substitute for EdgeTAM.
 */
export async function selectiveEval(device: GPUDevice): Promise<readonly SelectiveEvalStill[]> {
  const out: SelectiveEvalStill[] = [];
  for (const still of CASES) {
    const picture = await loadRgb(still.image);
    const maskImage = await loadRgb(still.mask, picture.width, picture.height);
    const canvas = new OffscreenCanvas(picture.width, picture.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(maskImage.bitmap, 0, 0);
    maskImage.bitmap.close();
    const coverage = coverageFromRgba(
      new Uint8Array(context.getImageData(0, 0, picture.width, picture.height).data.buffer),
      picture.width,
      picture.height,
    );

    const stage = new StyleStage(device, { width: picture.width, height: picture.height });
    stage.uploadImage(picture.bitmap);
    picture.bitmap.close();

    const sourceBytes = await stage.readSource();
    await stage.render(ANIME_STYLE, defaultControls(ANIME_STYLE), 'full', true);
    const fullBytes = await stage.readOutput();
    stage.uploadMask(coverage);
    await stage.render(ANIME_STYLE, defaultControls(ANIME_STYLE), 'full', true);
    const compositeBytes = await stage.readOutput();
    stage.dispose();

    out.push({
      name: still.name,
      width: picture.width,
      height: picture.height,
      source: toBase64(sourceBytes),
      mask: toBase64(maskRgb(coverage), 3),
      full: toBase64(fullBytes),
      composite: toBase64(compositeBytes),
      outsideMax: outsideMax(sourceBytes, compositeBytes, coverage),
      method: 'grabcut-substitute',
    });
  }
  return out;
}
