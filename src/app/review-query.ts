import type { StyleDefinition } from '../core/style/style.ts';
import { styleById } from '../core/style/styles.ts';

/**
 * Review and evaluation query, used by the local harness and by anyone
 * repeating a measured case.
 *
 *   ?sample=/tools/style-bench/real/evaluation/tos-occlusion.mp4
 *   &pick=450,200
 *   &rank=2
 *   &style=anime
 *
 * This is not a product demo route. It opens a file the same way a drop does,
 * clicks the same perception path a person clicks, and selects the same style
 * the shelf selects. Nothing about the render is special-cased.
 */

export interface ReviewQuery {
  readonly sample: string;
  readonly style: StyleDefinition;
  readonly pick?: { readonly x: number; readonly y: number };
  readonly rank?: number;
}

function integer(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseReviewQuery(search: string): ReviewQuery | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const sample = params.get('sample')?.trim();
  if (!sample) return undefined;

  const pickRaw = params.get('pick');
  let pick: ReviewQuery['pick'];
  if (pickRaw) {
    const [xRaw, yRaw] = pickRaw.split(',');
    const x = Number.parseFloat(xRaw ?? '');
    const y = Number.parseFloat(yRaw ?? '');
    if (Number.isFinite(x) && Number.isFinite(y)) pick = { x, y };
  }

  const rank = integer(params.get('rank'));
  const styleId = params.get('style')?.trim();

  return {
    sample,
    style: styleId ? styleById(styleId) : styleById('anime'),
    ...(pick ? { pick } : {}),
    ...(rank !== undefined ? { rank } : {}),
  };
}

export function reviewFileName(sample: string): string {
  const clean = sample.split('?')[0] ?? sample;
  const slash = clean.lastIndexOf('/');
  return slash >= 0 ? clean.slice(slash + 1) || 'sample' : clean || 'sample';
}
