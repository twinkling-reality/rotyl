import { describe, expect, it } from 'vitest';
import { DEFAULT_ANIME_CONTROLS, resolveAnimeParams } from '../src/core/style/anime/anime-params.ts';
import { QUALITY_SCALE, type StyleQuality } from '../src/core/style/style.ts';

const QUALITIES: StyleQuality[] = ['draft', 'full', 'export'];

describe('anime resolution independence', () => {
  it('keeps the flatten radius a fixed fraction of its buffer at every output size', () => {
    const fractions = [512, 1024, 2048, 4096].map((outputShortEdge) => {
      const params = resolveAnimeParams(DEFAULT_ANIME_CONTROLS, outputShortEdge, 'full');
      return params.radius / params.flattenShortEdge;
    });
    const [first] = fractions;
    for (const fraction of fractions) expect(fraction).toBeCloseTo(first ?? 0, 9);
  });

  it('keeps the ink sigma a fixed fraction of its buffer at every output size', () => {
    const fractions = [512, 1024, 2048, 4096].map((outputShortEdge) => {
      const params = resolveAnimeParams(DEFAULT_ANIME_CONTROLS, outputShortEdge, 'full');
      return params.sigmaEdge / params.inkShortEdge;
    });
    const [first] = fractions;
    for (const fraction of fractions) expect(fraction).toBeCloseTo(first ?? 0, 9);
  });

  it('keeps the same fractions across quality tiers', () => {
    const byQuality = QUALITIES.map((quality) => resolveAnimeParams(DEFAULT_ANIME_CONTROLS, 4096, quality));
    const flattenFractions = byQuality.map((params) => params.radius / params.flattenShortEdge);
    const inkFractions = byQuality.map((params) => params.sigmaEdge / params.inkShortEdge);
    for (const fraction of flattenFractions) expect(fraction).toBeCloseTo(flattenFractions[0] ?? 0, 9);
    for (const fraction of inkFractions) expect(fraction).toBeCloseTo(inkFractions[0] ?? 0, 9);
  });

  it('spends a higher quality tier on resolution rather than on kernel width', () => {
    const draft = resolveAnimeParams(DEFAULT_ANIME_CONTROLS, 4096, 'draft');
    const full = resolveAnimeParams(DEFAULT_ANIME_CONTROLS, 4096, 'full');
    expect(full.flattenShortEdge).toBeGreaterThan(draft.flattenShortEdge);
    const expected = QUALITY_SCALE.full / QUALITY_SCALE.draft;
    const actual = full.radius / draft.radius;
    expect(actual).toBeGreaterThan(expected * 0.7);
    expect(actual).toBeLessThan(expected * 1.3);
  });

  it('never exceeds the output resolution it was given', () => {
    for (const ceiling of [200, 300, 480, 700, 1000, 1184]) {
      for (const detail of [0, 0.25, 0.5, 0.75, 1]) {
        for (const quality of QUALITIES) {
          const params = resolveAnimeParams({ ...DEFAULT_ANIME_CONTROLS, detail }, ceiling, quality);
          expect(params.flattenShortEdge).toBeLessThanOrEqual(ceiling);
          expect(params.inkShortEdge).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });

  it('always downsamples onto the flatten buffer', () => {
    for (const ceiling of [256, 512, 720, 1080, 2160]) {
      for (const detail of [0, 0.5, 1]) {
        for (const quality of QUALITIES) {
          const params = resolveAnimeParams({ ...DEFAULT_ANIME_CONTROLS, detail }, ceiling, quality);
          expect(params.flattenShortEdge).toBeLessThanOrEqual(Math.round(ceiling / Math.SQRT2));
        }
      }
    }
  });

  it('uses Strength as a true fade to the photograph', () => {
    expect(resolveAnimeParams({ ...DEFAULT_ANIME_CONTROLS, strength: 0 }, 720, 'full').styleMix).toBe(0);
    expect(resolveAnimeParams({ ...DEFAULT_ANIME_CONTROLS, strength: 1 }, 720, 'full').styleMix).toBe(1);
  });

  it('uses Line only for ink weight, not for the mix', () => {
    const faint = resolveAnimeParams({ ...DEFAULT_ANIME_CONTROLS, line: 0 }, 720, 'full');
    const heavy = resolveAnimeParams({ ...DEFAULT_ANIME_CONTROLS, line: 1 }, 720, 'full');
    expect(faint.inkOpacity).toBeLessThan(heavy.inkOpacity);
    expect(faint.styleMix).toBeCloseTo(heavy.styleMix, 9);
  });
});
