import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT_CONTROLS, resolvePrintParams } from '../src/core/style/print/print-params.ts';
import { QUALITY_SCALE, type StyleQuality } from '../src/core/style/style.ts';

const QUALITIES: StyleQuality[] = ['draft', 'full', 'export'];

/**
 * The same invariants the comic style is held to, expressed in this style's own
 * terms, which is what makes them invariants of the style layer rather than of
 * one implementation.
 *
 * The quantity that must not depend on resolution is different here. The comic
 * style holds a kernel radius at a fixed fraction of its own buffer; this one
 * holds a screen pitch at a fixed fraction of the image while its buffer moves
 * underneath. Both come to the same promise: what the user judged in the
 * preview is what lands in the file.
 */
describe('resolution independence', () => {
  it('keeps the screen pitch a fixed fraction of the image at every output size', () => {
    const pitches = [256, 512, 1024, 2048, 4096, 9000].map(
      (outputShortEdge) => resolvePrintParams(DEFAULT_PRINT_CONTROLS, outputShortEdge, 'full').pitchFraction,
    );
    for (const pitch of pitches) expect(pitch).toBeCloseTo(pitches[0] ?? 0, 12);
  });

  it('keeps the screen pitch identical across quality tiers', () => {
    // A style control's draft frame must compose exactly like its export, or
    // the thing being dragged is not the thing being judged.
    for (let coarseness = 0; coarseness <= 1.0001; coarseness += 0.1) {
      const controls = { ...DEFAULT_PRINT_CONTROLS, coarseness };
      const byQuality = QUALITIES.map((quality) => resolvePrintParams(controls, 2048, quality));
      for (const params of byQuality) {
        expect(params.pitchFraction).toBeCloseTo(byQuality[0]?.pitchFraction ?? 0, 12);
      }
    }
  });

  it('spends a higher quality tier on tone resolution alone', () => {
    const draft = resolvePrintParams(DEFAULT_PRINT_CONTROLS, 4096, 'draft');
    const full = resolvePrintParams(DEFAULT_PRINT_CONTROLS, 4096, 'full');
    expect(full.toneShortEdge).toBeGreaterThan(draft.toneShortEdge);
    // Approximate only because resolutions snap to a 64px grid; the pitch,
    // checked above, is exact.
    const expected = QUALITY_SCALE.full / QUALITY_SCALE.draft;
    const actual = full.toneShortEdge / draft.toneShortEdge;
    expect(actual).toBeGreaterThan(expected * 0.7);
    expect(actual).toBeLessThan(expected * 1.3);
  });

  it('never exceeds the output resolution it was given', () => {
    // Deliberately not multiples of the 64px quantisation grid.
    for (const ceiling of [200, 300, 480, 700, 1000, 1184]) {
      for (const coarseness of [0, 0.25, 0.5, 0.75, 1]) {
        for (const quality of QUALITIES) {
          const params = resolvePrintParams({ ...DEFAULT_PRINT_CONTROLS, coarseness }, ceiling, quality);
          expect(params.toneShortEdge, `tone at ${String(ceiling)}`).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });

  it('keeps registration a fixed fraction of the pitch, so it scales with the screen', () => {
    // A misregistration written in pixels would be a hairline in the preview
    // and a smear in the export.
    for (const coarseness of [0, 0.3, 0.6, 1]) {
      const params = resolvePrintParams({ ...DEFAULT_PRINT_CONTROLS, coarseness }, 2048, 'full');
      for (const ink of params.inks) {
        const drift = Math.hypot(ink.offset[0], ink.offset[1]) / params.pitchFraction;
        expect(drift).toBeLessThan(1);
      }
    }
  });
});

describe('control mapping', () => {
  it('is monotonic in coarseness', () => {
    let previous = -Infinity;
    for (let coarseness = 0; coarseness <= 1.0001; coarseness += 0.1) {
      const { pitchFraction } = resolvePrintParams({ ...DEFAULT_PRINT_CONTROLS, coarseness }, 2048, 'full');
      expect(pitchFraction).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = pitchFraction;
    }
  });

  it('spends a coarser screen on less work, not more', () => {
    // A screen carries no detail below its own cell, so the buffer that feeds
    // it shrinks as the dots grow. The naive implementation does the opposite.
    const fine = resolvePrintParams({ ...DEFAULT_PRINT_CONTROLS, coarseness: 0 }, 4096, 'full');
    const coarse = resolvePrintParams({ ...DEFAULT_PRINT_CONTROLS, coarseness: 1 }, 4096, 'full');
    expect(coarse.toneShortEdge).toBeLessThan(fine.toneShortEdge);
  });

  it('is monotonic in strength', () => {
    let previousBlackPoint = -Infinity;
    let previousGain = -Infinity;
    for (let strength = 0; strength <= 1.0001; strength += 0.1) {
      const params = resolvePrintParams({ ...DEFAULT_PRINT_CONTROLS, strength }, 2048, 'full');
      expect(params.blackPoint).toBeGreaterThanOrEqual(previousBlackPoint - 1e-9);
      expect(params.gain).toBeGreaterThanOrEqual(previousGain - 1e-9);
      previousBlackPoint = params.blackPoint;
      previousGain = params.gain;
    }
  });

  it('makes strength 0 a true no-op and full strength fully applied', () => {
    expect(resolvePrintParams({ ...DEFAULT_PRINT_CONTROLS, strength: 0 }, 2048, 'full').styleMix).toBe(0);
    expect(resolvePrintParams({ ...DEFAULT_PRINT_CONTROLS, strength: 1 }, 2048, 'full').styleMix).toBe(1);
  });

  it('falls back to its own defaults for controls it was not given', () => {
    // Control records are keyed by name and carried by a UI that does not know
    // which style it is driving, so a record from another style must degrade to
    // defaults rather than to NaN.
    const empty = resolvePrintParams({}, 2048, 'full');
    const foreign = resolvePrintParams({ detail: 0.2 }, 2048, 'full');
    expect(empty).toEqual(resolvePrintParams(DEFAULT_PRINT_CONTROLS, 2048, 'full'));
    expect(foreign).toEqual(empty);
  });

  it('produces finite parameters across the whole control space', () => {
    for (let strength = 0; strength <= 1.0001; strength += 0.25) {
      for (let coarseness = 0; coarseness <= 1.0001; coarseness += 0.25) {
        for (const colour of [0, 0.5, 1, -3, 4]) {
          const params = resolvePrintParams({ strength, coarseness, colour }, 1024, 'full');
          const numbers: number[] = [
            params.toneShortEdge,
            params.pitchFraction,
            params.blackPoint,
            params.gain,
            params.colour,
            params.styleMix,
            ...params.paper,
          ];
          for (const ink of params.inks) {
            numbers.push(ink.angle, ...ink.offset, ...ink.colour);
          }
          for (const value of numbers) {
            expect(Number.isFinite(value), `at strength ${String(strength)}`).toBe(true);
          }
        }
      }
    }
  });
});
