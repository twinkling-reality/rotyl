import { describe, expect, it } from 'vitest';
import { expandCoverage, packCoverage, packedArea } from '../src/core/document/coverage-mask.ts';

/**
 * The one structure the document cannot rebuild, so the one that has to be
 * exactly reversible.
 *
 * A mask in the log is the model's answer, and replaying the log is how undo,
 * device-loss recovery and export at another resolution all work. An encoding
 * that lost a code somewhere would not fail; it would quietly move a boundary,
 * on a picture nobody had a copy of.
 *
 * So this is mostly round trips, and deliberately over inputs the product does
 * not produce as well as inputs it does. The packing is chosen for what a
 * model's mask looks like, and it has to be CORRECT for anything.
 */

/** Deterministic, so a failure is the same failure on the next run. */
function noise(seed: number, length: number, values: number): Uint8Array {
  let a = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) % values;
  }
  return out;
}

/** A silhouette with a soft edge, which is the shape an engine actually returns. */
function silhouette(size: number, ramp: number): Uint8Array {
  const out = new Uint8Array(size * size);
  const centre = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre);
      const t = Math.min(1, Math.max(0, (size * 0.34 - distance) / ramp));
      out[y * size + x] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  return out;
}

describe('packing a coverage mask', () => {
  const cases: readonly (readonly [string, number, number, Uint8Array])[] = [
    ['nothing at all', 16, 16, new Uint8Array(256)],
    ['everything', 16, 16, new Uint8Array(256).fill(255)],
    ['one pixel', 1, 1, new Uint8Array([255])],
    ['a single row', 64, 1, silhouette(8, 2).subarray(0, 64)],
    ['not square', 32, 8, noise(1, 256, 4)],
    ['a soft silhouette', 64, 64, silhouette(64, 2)],
    ['a very soft silhouette', 64, 64, silhouette(64, 16)],
    ['two values, alternating', 16, 16, Uint8Array.from({ length: 256 }, (_, i) => (i % 2) * 255)],
    ['every value there is', 16, 16, noise(7, 256, 256)],
    // A run longer than one control byte can describe, which is the case that
    // catches an encoder written for the middle of the range.
    ['one flat run of 4096', 64, 64, new Uint8Array(4096).fill(9)],
  ];

  for (const [name, width, height, coverage] of cases) {
    it(`round trips ${name}`, () => {
      const packed = packCoverage(width, height, coverage);
      expect(packed.width).toBe(width);
      expect(packed.height).toBe(height);
      expect([...expandCoverage(packed)]).toEqual([...coverage]);
    });
  }

  it('cannot grow a mask by more than one byte in 128', () => {
    // The property that decided this encoding over pairs of a value and a
    // length, which double the size of the first of these two.
    for (const coverage of [noise(3, 4096, 256), noise(4, 4096, 2)]) {
      const packed = packCoverage(64, 64, coverage);
      expect(packed.packed.length).toBeLessThanOrEqual(coverage.length + Math.ceil(coverage.length / 128));
    }
  });

  it('takes an order of magnitude off a mask shaped like an answer', () => {
    // What the log is for. A crisp boundary is where the engine is confident
    // and a wide one is where it is not, so both have to pay.
    const crisp = packCoverage(256, 256, silhouette(256, 2));
    const soft = packCoverage(256, 256, silhouette(256, 16));
    expect(65536 / crisp.packed.length).toBeGreaterThan(10);
    expect(65536 / soft.packed.length).toBeGreaterThan(5);
  });

  it('unpacks into a buffer the caller keeps', () => {
    // How a replay avoids leaving one of these per command behind on every
    // rebuild of the mask.
    const packed = packCoverage(16, 16, silhouette(16, 2));
    const into = new Uint8Array(1024);
    const out = expandCoverage(packed, into);
    expect(out).toBe(into);
    expect([...out.subarray(0, 256)]).toEqual([...expandCoverage(packed)]);
  });

  it('counts covered pixels without unpacking', () => {
    const coverage = silhouette(64, 2);
    const inside = coverage.reduce((count, value) => count + (value >= 128 ? 1 : 0), 0);
    expect(packedArea(packCoverage(64, 64, coverage), 128)).toBeCloseTo(inside / 4096, 10);
  });

  it('refuses a size that does not match the bytes', () => {
    // Silently packing the wrong number of pixels would produce a mask that
    // expands to a different picture, which is the one failure this cannot
    // afford to be quiet about.
    expect(() => packCoverage(8, 8, new Uint8Array(63))).toThrow();
    expect(() => expandCoverage(packCoverage(8, 8, new Uint8Array(64)), new Uint8Array(63))).toThrow();
  });
});
