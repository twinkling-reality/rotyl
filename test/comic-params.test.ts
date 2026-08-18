import { describe, expect, it } from 'vitest';
import { DEFAULT_COMIC_CONTROLS, resolveComicParams } from '../src/core/style/comic/comic-params.ts';
import { QUALITY_SCALE, type StyleQuality } from '../src/core/style/style.ts';
import { bufferSizeForShortEdge } from '../src/core/render/resolution.ts';
import { PALETTE_STOPS, PALETTES } from '../src/core/style/palette.ts';

const QUALITIES: StyleQuality[] = ['draft', 'full', 'export'];

/**
 * These are the invariants that make "export matches preview" true. They are
 * properties of the parameter mapping alone, so they can be checked without a
 * GPU, which is the point of keeping the mapping in its own pure module.
 */
describe('resolution independence', () => {
  it('keeps the flatten radius a fixed fraction of its buffer at every output size', () => {
    const fractions = [512, 1024, 2048, 4096].map((outputShortEdge) => {
      const params = resolveComicParams(DEFAULT_COMIC_CONTROLS, outputShortEdge, 'full');
      return params.radius / params.flattenShortEdge;
    });

    const [first] = fractions;
    for (const fraction of fractions) {
      expect(fraction).toBeCloseTo(first ?? 0, 9);
    }
  });

  it('keeps the ink sigma a fixed fraction of its buffer at every output size', () => {
    const fractions = [512, 1024, 2048, 4096].map((outputShortEdge) => {
      const params = resolveComicParams(DEFAULT_COMIC_CONTROLS, outputShortEdge, 'full');
      return params.sigmaEdge / params.inkShortEdge;
    });

    const [first] = fractions;
    for (const fraction of fractions) {
      expect(fraction).toBeCloseTo(first ?? 0, 9);
    }
  });

  it('keeps the same fractions across quality tiers, so a draft composes like an export', () => {
    const byQuality = QUALITIES.map((quality) => resolveComicParams(DEFAULT_COMIC_CONTROLS, 4096, quality));

    const flattenFractions = byQuality.map((p) => p.radius / p.flattenShortEdge);
    const inkFractions = byQuality.map((p) => p.sigmaEdge / p.inkShortEdge);

    for (const fraction of flattenFractions) expect(fraction).toBeCloseTo(flattenFractions[0] ?? 0, 9);
    for (const fraction of inkFractions) expect(fraction).toBeCloseTo(inkFractions[0] ?? 0, 9);
  });

  it('spends a higher quality tier on resolution rather than on kernel width', () => {
    const draft = resolveComicParams(DEFAULT_COMIC_CONTROLS, 4096, 'draft');
    const full = resolveComicParams(DEFAULT_COMIC_CONTROLS, 4096, 'full');
    expect(full.flattenShortEdge).toBeGreaterThan(draft.flattenShortEdge);
    // The radius grows with the buffer, which is what keeps the fraction fixed
    // and per-pixel cost near constant instead of growing with the square of
    // the resolution. The ratio only approximates the quality ratio because
    // buffer sizes snap to a 64px grid. The fraction, checked above, is exact.
    const expected = QUALITY_SCALE.full / QUALITY_SCALE.draft;
    const actual = full.radius / draft.radius;
    expect(actual).toBeGreaterThan(expected * 0.7);
    expect(actual).toBeLessThan(expected * 1.3);
  });

  it('never exceeds the output resolution it was given', () => {
    // Deliberately not a multiple of the 64px quantisation grid: an earlier
    // version of this test used 320 and passed while the mapping was rounding
    // resolutions back above their own ceiling.
    for (const ceiling of [200, 300, 480, 700, 1000, 1184]) {
      for (const detail of [0, 0.25, 0.5, 0.75, 1]) {
        for (const quality of QUALITIES) {
          const params = resolveComicParams({ detail, strength: 0.7 }, ceiling, quality);
          expect(params.flattenShortEdge, `flatten at ${String(ceiling)}`).toBeLessThanOrEqual(ceiling);
          expect(params.inkShortEdge, `ink at ${String(ceiling)}`).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });

  it('holds the apparent scale identical between the preview and the export tier', () => {
    // The property the product depends on, swept over sizes that are not
    // multiples of the quantisation grid, which is exactly where it broke.
    for (let shortEdge = 200; shortEdge <= 2400; shortEdge += 37) {
      for (const detail of [0, 0.25, 0.5, 0.75, 1]) {
        const controls = { detail, strength: 0.7 };
        const preview = resolveComicParams(controls, shortEdge, 'full');
        const exported = resolveComicParams(controls, shortEdge, 'export');

        expect(
          exported.radius / exported.flattenShortEdge,
          `flatten scale at ${String(shortEdge)}px detail ${String(detail)}`,
        ).toBeCloseTo(preview.radius / preview.flattenShortEdge, 9);
        expect(
          exported.sigmaEdge / exported.inkShortEdge,
          `ink scale at ${String(shortEdge)}px detail ${String(detail)}`,
        ).toBeCloseTo(preview.sigmaEdge / preview.inkShortEdge, 9);
      }
    }
  });
});

describe('control mapping', () => {
  it('is monotonic in detail', () => {
    let previousRadiusFraction = Infinity;
    for (let detail = 0; detail <= 1.0001; detail += 0.1) {
      const params = resolveComicParams({ detail, strength: 0.7 }, 2048, 'full');
      const fraction = params.radius / params.flattenShortEdge;
      expect(fraction).toBeLessThanOrEqual(previousRadiusFraction + 1e-9);
      previousRadiusFraction = fraction;
    }
  });

  it('is monotonic in strength', () => {
    let previousBins = Infinity;
    let previousInk = -Infinity;
    for (let strength = 0; strength <= 1.0001; strength += 0.1) {
      const params = resolveComicParams({ detail: 0.5, strength }, 2048, 'full');
      expect(params.bins).toBeLessThanOrEqual(previousBins);
      expect(params.inkOpacity).toBeGreaterThanOrEqual(previousInk - 1e-9);
      previousBins = params.bins;
      previousInk = params.inkOpacity;
    }
  });

  it('makes strength 0 a true no-op and full strength fully applied', () => {
    expect(resolveComicParams({ detail: 0.5, strength: 0 }, 2048, 'full').styleMix).toBe(0);
    expect(resolveComicParams({ detail: 0.5, strength: 1 }, 2048, 'full').styleMix).toBe(1);
  });

  it('clamps controls that arrive out of range', () => {
    const low = resolveComicParams({ detail: -5, strength: -5 }, 2048, 'full');
    const high = resolveComicParams({ detail: 5, strength: 5 }, 2048, 'full');
    expect(Number.isFinite(low.radius)).toBe(true);
    expect(Number.isFinite(high.radius)).toBe(true);
    expect(low.styleMix).toBe(0);
    expect(high.styleMix).toBe(1);
  });

  it('produces finite parameters across the whole control space', () => {
    for (let detail = 0; detail <= 1.0001; detail += 0.25) {
      for (let strength = 0; strength <= 1.0001; strength += 0.25) {
        const params = resolveComicParams({ detail, strength }, 1024, 'full');
        for (const [key, value] of Object.entries(params)) {
          // The palette arrives as an array of stops, so this looks inside
          // rather than asking whether an array is a finite number.
          const numbers: readonly number[] = Array.isArray(value) ? value : [Number(value)];
          for (const number of numbers) {
            expect(
              Number.isFinite(number),
              `${key} at detail ${String(detail)} strength ${String(strength)}`,
            ).toBe(true);
          }
        }
        expect(params.bins).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('buffer sizing', () => {
  it('preserves aspect ratio', () => {
    const size = bufferSizeForShortEdge({ width: 4000, height: 3000 }, 600);
    expect(size).toEqual({ width: 800, height: 600 });
  });

  it('never upscales past the source', () => {
    expect(bufferSizeForShortEdge({ width: 320, height: 200 }, 2048)).toEqual({ width: 320, height: 200 });
  });

  it('handles a degenerate source', () => {
    expect(bufferSizeForShortEdge({ width: 0, height: 0 }, 512)).toEqual({ width: 1, height: 1 });
  });
});

/**
 * The palette, as a parameter.
 *
 * A gradient map is the one thing in the chain that can change a picture's
 * colour outright rather than nudging it, so what is checked here is that it is
 * genuinely off by default and genuinely off when chosen to be.
 */
describe('the palette', () => {
  it('costs nothing until one is chosen', () => {
    const none = resolveComicParams({ palette: 0, colour: 1 }, 1024, 'full');
    expect(none.paletteAmount).toBe(0);

    const chosen = resolveComicParams({ palette: 1, colour: 1 }, 1024, 'full');
    expect(chosen.paletteAmount).toBe(1);
  });

  it('hands the shader five Oklab stops, ascending in lightness', () => {
    for (let index = 0; index < PALETTES.length; index++) {
      const { paletteStops } = resolveComicParams({ palette: index }, 1024, 'full');
      expect(paletteStops.length).toBe(PALETTE_STOPS * 4);

      // Dark to light, because the map is indexed BY lightness: a ramp that
      // doubled back would send two different tones to the same colour.
      const lightness = [0, 1, 2, 3, 4].map((stop) => paletteStops[stop * 4] ?? 0);
      for (let stop = 1; stop < lightness.length; stop++) {
        expect(lightness[stop], `${PALETTES[index]?.name ?? ''} stop ${String(stop)}`).toBeGreaterThan(
          lightness[stop - 1] ?? 0,
        );
      }
    }
  });

  it('clamps a choice to a palette that exists', () => {
    expect(resolveComicParams({ palette: 99, colour: 1 }, 1024, 'full').paletteStops).toEqual(
      resolveComicParams({ palette: PALETTES.length - 1, colour: 1 }, 1024, 'full').paletteStops,
    );
  });
});
