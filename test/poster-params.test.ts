import { describe, expect, it } from 'vitest';
import { DEFAULT_POSTER_CONTROLS, resolvePosterParams } from '../src/core/style/poster/poster-params.ts';
import { QUALITY_SCALE, type StyleQuality } from '../src/core/style/style.ts';
import { paletteLightness, PALETTES } from '../src/core/style/palette.ts';

const QUALITIES: StyleQuality[] = ['draft', 'full', 'export'];

/**
 * The same invariants the other two styles are held to, in this style's own
 * terms, which is what makes them invariants of the style layer rather than of
 * one implementation.
 *
 * Two lengths have to be a fixed fraction of the image here: the bilateral's
 * spatial sigma, which decides how large the flat areas are, and the outline's
 * width. The second is the one a new style is most likely to get wrong, because
 * a line looks right in a preview at any width and only reveals itself as a
 * hairline in a 6000 px export.
 */
describe('resolution independence', () => {
  it('keeps the flatten sigma a fixed fraction of its buffer at every output size', () => {
    const fractions = [512, 1024, 2048, 4096].map((outputShortEdge) => {
      const params = resolvePosterParams(DEFAULT_POSTER_CONTROLS, outputShortEdge, 'full');
      return params.sigmaSpatial / params.flattenShortEdge;
    });
    for (const fraction of fractions) expect(fraction).toBeCloseTo(fractions[0] ?? 0, 9);
  });

  it('keeps the line a fixed fraction of the image at every output size and tier', () => {
    for (const outputShortEdge of [256, 512, 1024, 4096, 9000]) {
      for (const quality of QUALITIES) {
        const params = resolvePosterParams(DEFAULT_POSTER_CONTROLS, outputShortEdge, quality);
        expect(params.lineFraction).toBeCloseTo(
          resolvePosterParams(DEFAULT_POSTER_CONTROLS, 1024, 'full').lineFraction,
          12,
        );
      }
    }
  });

  it('holds the apparent scale identical between the preview and the export tier', () => {
    // Swept over sizes that are not multiples of the 64px quantisation grid,
    // which is exactly where this breaks when it breaks.
    for (let shortEdge = 200; shortEdge <= 2400; shortEdge += 37) {
      for (const detail of [0, 0.25, 0.5, 0.75, 1]) {
        const controls = { ...DEFAULT_POSTER_CONTROLS, detail };
        const preview = resolvePosterParams(controls, shortEdge, 'full');
        const exported = resolvePosterParams(controls, shortEdge, 'export');
        expect(
          exported.sigmaSpatial / exported.flattenShortEdge,
          `flatten scale at ${String(shortEdge)}px detail ${String(detail)}`,
        ).toBeCloseTo(preview.sigmaSpatial / preview.flattenShortEdge, 9);
      }
    }
  });

  it('spends a higher quality tier on resolution rather than on kernel width', () => {
    const draft = resolvePosterParams(DEFAULT_POSTER_CONTROLS, 4096, 'draft');
    const full = resolvePosterParams(DEFAULT_POSTER_CONTROLS, 4096, 'full');
    expect(full.flattenShortEdge).toBeGreaterThan(draft.flattenShortEdge);
    // Approximate only because buffer sizes snap to a 64px grid; the fraction,
    // checked above, is exact.
    const expected = QUALITY_SCALE.full / QUALITY_SCALE.draft;
    const actual = full.sigmaSpatial / draft.sigmaSpatial;
    expect(actual).toBeGreaterThan(expected * 0.7);
    expect(actual).toBeLessThan(expected * 1.3);
  });

  it('never exceeds the output resolution it was given', () => {
    for (const ceiling of [200, 300, 480, 700, 1000, 1184]) {
      for (const detail of [0, 0.25, 0.5, 0.75, 1]) {
        for (const quality of QUALITIES) {
          const params = resolvePosterParams({ ...DEFAULT_POSTER_CONTROLS, detail }, ceiling, quality);
          expect(params.flattenShortEdge, `flatten at ${String(ceiling)}`).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });
});

describe('control mapping', () => {
  it('is monotonic in detail', () => {
    let previous = Infinity;
    for (let detail = 0; detail <= 1.0001; detail += 0.1) {
      const params = resolvePosterParams({ ...DEFAULT_POSTER_CONTROLS, detail }, 2048, 'full');
      const fraction = params.sigmaSpatial / params.flattenShortEdge;
      expect(fraction).toBeLessThanOrEqual(previous + 1e-9);
      previous = fraction;
    }
  });

  it('is monotonic in strength, and spends it on fewer levels rather than more', () => {
    let previousLevels = Infinity;
    let previousRange = -Infinity;
    for (let strength = 0; strength <= 1.0001; strength += 0.1) {
      const params = resolvePosterParams({ ...DEFAULT_POSTER_CONTROLS, strength }, 2048, 'full');
      expect(params.levels).toBeLessThanOrEqual(previousLevels);
      expect(params.sigmaRange).toBeGreaterThanOrEqual(previousRange - 1e-9);
      previousLevels = params.levels;
      previousRange = params.sigmaRange;
    }
  });

  it('spends the line control on reach as well as on weight', () => {
    // The threshold is the whole point of the outline: turning the control up
    // must draw MORE boundaries, not only darker ones. A style that only
    // darkened would ink the same places a difference of Gaussians does.
    const faint = resolvePosterParams({ ...DEFAULT_POSTER_CONTROLS, line: 0.1 }, 2048, 'full');
    const heavy = resolvePosterParams({ ...DEFAULT_POSTER_CONTROLS, line: 1 }, 2048, 'full');
    expect(heavy.lineWeight).toBeGreaterThan(faint.lineWeight);
    expect(heavy.lineThreshold).toBeLessThan(faint.lineThreshold);
  });

  it('makes strength 0 a true no-op and full strength fully applied', () => {
    expect(resolvePosterParams({ strength: 0 }, 2048, 'full').styleMix).toBe(0);
    expect(resolvePosterParams({ strength: 1 }, 2048, 'full').styleMix).toBe(1);
  });

  it('falls back to its own defaults for controls it was not given', () => {
    // Control records are keyed by name and carried by a UI that does not know
    // which style it is driving, so a record from another style must degrade to
    // defaults rather than to NaN.
    const empty = resolvePosterParams({}, 2048, 'full');
    expect(empty).toEqual(resolvePosterParams(DEFAULT_POSTER_CONTROLS, 2048, 'full'));
    expect(resolvePosterParams({ coarseness: 0.2 }, 2048, 'full')).toEqual(empty);
  });

  it('produces finite parameters across the whole control space', () => {
    for (let strength = 0; strength <= 1.0001; strength += 0.25) {
      for (let detail = 0; detail <= 1.0001; detail += 0.25) {
        for (const line of [0, 0.5, 1]) {
          for (const palette of [0, 1, 4, -2, 9]) {
            const params = resolvePosterParams({ strength, detail, line, palette }, 1024, 'full');
            for (const [key, value] of Object.entries(params)) {
              const numbers: readonly number[] = Array.isArray(value) ? value : [Number(value)];
              for (const number of numbers) {
                expect(Number.isFinite(number), `${key} at strength ${String(strength)}`).toBe(true);
              }
            }
            expect(params.levels).toBeGreaterThanOrEqual(1);
            expect(params.chromaStep).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

/**
 * Fitting a palette to a picture.
 *
 * The statistics a style hands the shader come from the stops themselves, so
 * what is checked here is that they describe a usable range: a palette whose
 * spread was reported as zero would fit every photograph onto one stop, which
 * is the failure this whole mechanism exists to prevent.
 */
describe('palette fitting', () => {
  it('reports a spread wide enough to be worth fitting to, for every palette', () => {
    for (let index = 0; index < PALETTES.length; index++) {
      const { mean, spread, chroma } = paletteLightness(index);
      expect(mean, PALETTES[index]?.name).toBeGreaterThan(0.3);
      expect(mean, PALETTES[index]?.name).toBeLessThan(0.8);
      // Measured on the reference scene, a hazy photograph has a spread of
      // 0.136; every palette here is wider than that, which is why fitting
      // stretches rather than compresses.
      expect(spread, PALETTES[index]?.name).toBeGreaterThan(0.2);
      expect(chroma, PALETTES[index]?.name).toBeGreaterThanOrEqual(0);
    }
  });

  it('gives the neutral palette no chroma at all', () => {
    expect(paletteLightness(0).chroma).toBeLessThan(0.005);
  });

  it('carries the palette statistics into the parameters the shader is given', () => {
    for (let index = 0; index < PALETTES.length; index++) {
      const stats = paletteLightness(index);
      const params = resolvePosterParams({ palette: index }, 1024, 'full');
      expect(params.paletteMeanLightness).toBeCloseTo(stats.mean, 12);
      expect(params.paletteLightnessSpread).toBeCloseTo(stats.spread, 12);
      expect(params.paletteChroma).toBeCloseTo(stats.chroma, 12);
    }
  });
});
