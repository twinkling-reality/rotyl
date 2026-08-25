import { ANIME_STYLE } from '../../src/core/style/anime/anime-style-pipeline.ts';
import { COMIC_STYLE } from '../../src/core/style/comic/comic-style-pipeline.ts';
import { defaultControls } from '../../src/core/style/style.ts';
import { REAL, StyleStage } from './harness.ts';
import { toBase64 } from './stills.ts';

const STILLS = [
  { name: 'portrait-close', url: `${REAL}/evaluation/portrait-close.jpg` },
  { name: 'portrait-glasses', url: `${REAL}/evaluation/portrait-glasses.jpg` },
  { name: 'portrait-somali', url: `${REAL}/evaluation/portrait-somali.jpg` },
  { name: 'portrait-lehna', url: `${REAL}/evaluation/portrait-lehna.jpg` },
  { name: 'portrait-doorway', url: `${REAL}/evaluation/portrait-doorway.jpg` },
  { name: 'portrait-hands', url: `${REAL}/evaluation/portrait-hands.jpg` },
] as const;

/** Long-edge cap so a 20 megapixel still does not allocate a 300 MB working set. */
const LONG_EDGE = 1200;

const VIDEO_FRAMES = [
  {
    name: 'tos-crossing-early',
    url: '/tools/style-bench/out/evaluation/video-frames/tos-crossing-early.png',
  },
  { name: 'tos-crossing-mid', url: '/tools/style-bench/out/evaluation/video-frames/tos-crossing-mid.png' },
  { name: 'tos-crossing-late', url: '/tools/style-bench/out/evaluation/video-frames/tos-crossing-late.png' },
  {
    name: 'tos-crossing-adj-01',
    url: '/tools/style-bench/out/evaluation/video-frames/tos-crossing-adj-01.png',
  },
  {
    name: 'tos-crossing-adj-02',
    url: '/tools/style-bench/out/evaluation/video-frames/tos-crossing-adj-02.png',
  },
  {
    name: 'tos-occlusion-early',
    url: '/tools/style-bench/out/evaluation/video-frames/tos-occlusion-early.png',
  },
  { name: 'tos-occlusion-mid', url: '/tools/style-bench/out/evaluation/video-frames/tos-occlusion-mid.png' },
  {
    name: 'tos-occlusion-late',
    url: '/tools/style-bench/out/evaluation/video-frames/tos-occlusion-late.png',
  },
  {
    name: 'tos-occlusion-adj-01',
    url: '/tools/style-bench/out/evaluation/video-frames/tos-occlusion-adj-01.png',
  },
  {
    name: 'tos-occlusion-adj-02',
    url: '/tools/style-bench/out/evaluation/video-frames/tos-occlusion-adj-02.png',
  },
] as const;

export interface AnimeEvalStill {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly source: string;
  readonly comic: string;
  readonly anime: string;
  readonly animeMs?: number;
}

async function loadStill(url: string): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
  const blob = await (await fetch(url)).blob();
  const full = await createImageBitmap(blob);
  const longest = Math.max(full.width, full.height);
  if (longest <= LONG_EDGE) return { bitmap: full, width: full.width, height: full.height };

  const scale = LONG_EDGE / longest;
  const width = Math.max(1, Math.round(full.width * scale));
  const height = Math.max(1, Math.round(full.height * scale));
  try {
    const bitmap = await createImageBitmap(full, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
    return { bitmap, width, height };
  } finally {
    full.close();
  }
}

/**
 * Source, Comic, and Anime of each evaluation still, through the real
 * compositor, so the look can be compared rather than described.
 */
export async function animeEval(device: GPUDevice): Promise<readonly AnimeEvalStill[]> {
  const out: AnimeEvalStill[] = [];
  for (const still of [...STILLS, ...VIDEO_FRAMES]) {
    const picture = await loadStill(still.url);
    const size = { width: picture.width, height: picture.height };
    const stage = new StyleStage(device, size);
    stage.uploadImage(picture.bitmap);
    picture.bitmap.close();

    const source = toBase64(await stage.readSource());
    await stage.render(COMIC_STYLE, defaultControls(COMIC_STYLE), 'full', true);
    const comic = toBase64(await stage.readOutput());
    const t0 = performance.now();
    await stage.render(ANIME_STYLE, defaultControls(ANIME_STYLE), 'full', true);
    const animeMs = Math.round((performance.now() - t0) * 10) / 10;
    const anime = toBase64(await stage.readOutput());
    stage.dispose();

    out.push({
      name: still.name,
      width: size.width,
      height: size.height,
      source,
      comic,
      anime,
      animeMs,
    });
  }
  return out;
}
