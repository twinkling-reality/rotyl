import { describe, expect, it } from 'vitest';
import { parseReviewQuery, reviewFileName } from '../src/app/review-query.ts';

describe('review query', () => {
  it('ignores an ordinary session with no sample', () => {
    expect(parseReviewQuery('')).toBeUndefined();
    expect(parseReviewQuery('?style=anime')).toBeUndefined();
  });

  it('opens a sample through the real style table', () => {
    const review = parseReviewQuery(
      '?sample=/tools/style-bench/real/evaluation/tos-occlusion.mp4&pick=450,200&rank=2&style=anime',
    );
    expect(review?.sample).toBe('/tools/style-bench/real/evaluation/tos-occlusion.mp4');
    expect(review?.style.id).toBe('anime');
    expect(review?.pick).toEqual({ x: 450, y: 200 });
    expect(review?.rank).toBe(2);
  });

  it('falls back to Comic for an unknown style id', () => {
    const review = parseReviewQuery('?sample=/x.jpg&style=does-not-exist');
    expect(review?.style.id).toBe('comic');
  });

  it('names the file from the path, not from the query', () => {
    expect(reviewFileName('/tools/style-bench/real/evaluation/tos-occlusion.mp4?cache=1')).toBe(
      'tos-occlusion.mp4',
    );
  });
});
