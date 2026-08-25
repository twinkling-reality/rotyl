import { ANIME_STYLE } from './anime/anime-style-pipeline.ts';
import { COMIC_STYLE } from './comic/comic-style-pipeline.ts';
import { POSTER_STYLE } from './poster/poster-style-pipeline.ts';
import { PRINT_STYLE } from './print/print-style-pipeline.ts';
import type { StyleDefinition } from './style.ts';

/**
 * Every style Rotyl offers, in the order the picker shows them.
 *
 * The only file that names them all. Adding one is a directory, a params
 * module, a WGSL chain and a line here. The engine, the export path, the
 * compositor and the UI are untouched, which is the claim `style.ts` makes and
 * this list is the proof of.
 *
 * Not code-split. The pipelines are a few kilobytes of WGSL and a pipeline set
 * that is only built when a style is first rendered; deferring the source would
 * trade a network round trip for nothing measurable. The segmentation model is
 * the thing worth code-splitting, and is. Anime is a shader chain, not a second
 * network fetch.
 */
export const STYLES: readonly StyleDefinition[] = [COMIC_STYLE, POSTER_STYLE, PRINT_STYLE, ANIME_STYLE];

export const DEFAULT_STYLE: StyleDefinition = COMIC_STYLE;

export function styleById(id: string): StyleDefinition {
  return STYLES.find((style) => style.id === id) ?? DEFAULT_STYLE;
}
