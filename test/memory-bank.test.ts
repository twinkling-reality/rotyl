import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  layOutBank,
  maskForMemory,
  MEMORY_DIM,
  MEMORY_ENTRIES,
  MEMORY_TOKENS,
  TOKENS_PER_MEMORY,
  visionPositionEncoding,
  type MemoryEntry,
} from '../src/core/perception/memory-bank.ts';

/**
 * The half of a tracker that can be checked without a tracker.
 *
 * WRITTEN TO ALLOCATE ALMOST NOTHING, which is not a style preference here. The
 * suite keeps a Dawn device alive across files and the garbage a test makes
 * while it is alive aborts the worker outright, with every assertion already
 * passed. Spreading a 3648-element mask into a JS array to count it did exactly
 * that: `mask-refine` went from failing one run in three to failing every run.
 * So the counting below is loops over typed arrays.
 *
 * Everything here is arithmetic the reference also does, so it can be wrong in
 * exactly one way: agreeing with its author and not with the model. The
 * position encoding is therefore checked against values `parameters.py` read
 * out of the checkpoint's own module rather than against the formula this file
 * could have copied wrong in the same direction twice.
 */

interface Fixture {
  readonly size: readonly [number, number];
  readonly channels: number;
  readonly tokens: readonly number[];
  readonly at: readonly number[];
  readonly values: readonly (readonly number[])[];
}

/** Counted rather than filtered: see the note above about garbage. */
function openTokens(keyMask: Float32Array): number {
  let open = 0;
  for (const value of keyMask) if (value === 0) open++;
  return open;
}

const entry = (fill: number): MemoryEntry => ({
  features: new Float32Array(TOKENS_PER_MEMORY * MEMORY_DIM).fill(fill),
  positions: new Float32Array(TOKENS_PER_MEMORY * MEMORY_DIM).fill(fill * 10),
});

/** One distinguishable row per age, so a misindexed entry shows up as a value. */
const temporal = Float32Array.from({ length: MEMORY_ENTRIES * MEMORY_DIM }, (_, i) =>
  Math.floor(i / MEMORY_DIM),
);

describe('the vision position encoding', () => {
  it('agrees with the checkpoint that produced it', () => {
    // The one cross-language check here. A transposed axis, a swapped sine and
    // cosine and a grid that starts at zero instead of one all produce a
    // plausible field, and none of them produces an error.
    const fixture: Fixture = JSON.parse(readFileSync('tools/edgetam-export/position-encoding.json', 'utf8'));
    const [height, width] = fixture.size;
    const encoding = visionPositionEncoding(width, height, fixture.channels);

    expect(encoding.length).toBe(width * height * fixture.channels);
    fixture.tokens.forEach((token, row) => {
      fixture.at.forEach((channel, column) => {
        expect(
          encoding[token * fixture.channels + channel],
          `token ${String(token)} channel ${String(channel)}`,
        ).toBeCloseTo(fixture.values[row]?.[column] ?? Number.NaN, 5);
      });
    });
  });
});

describe('laying out a memory bank', () => {
  it('always produces the one shape the graph accepts', () => {
    // A variable-length bank would be a graph shape per frame and a pipeline
    // recompile with each one, which is the whole reason for the padding.
    for (const count of [1, 3, MEMORY_ENTRIES]) {
      const bank = layOutBank(
        Array.from({ length: count }, (_, i) => entry(i + 1)),
        temporal,
      );
      expect(bank.memory.length).toBe(MEMORY_TOKENS * MEMORY_DIM);
      expect(bank.positions.length).toBe(MEMORY_TOKENS * MEMORY_DIM);
      expect(bank.keyMask.length).toBe(MEMORY_TOKENS);
    }
  });

  it('masks every token it did not fill, including the pointer block', () => {
    const bank = layOutBank([entry(1), entry(2)], temporal);
    expect(openTokens(bank.keyMask)).toBe(2 * TOKENS_PER_MEMORY);
    // The pointers are the last block and there are none: the published mask
    // decoder does not expose `object_pointer`.
    expect(bank.keyMask.at(-1)).toBeLessThan(0);
    expect(bank.memory.at(-1)).toBe(0);
  });

  it('puts real entries in the low slots, oldest first', () => {
    // Where an entry sits decides the rotary frequency it is given, so this is
    // not bookkeeping: an entry in the wrong slot is an entry from a different
    // moment as far as the graph is concerned.
    const bank = layOutBank([entry(1), entry(2), entry(3)], temporal);
    expect(bank.memory[0]).toBe(1);
    expect(bank.memory[TOKENS_PER_MEMORY * MEMORY_DIM]).toBe(2);
    expect(bank.memory[2 * TOKENS_PER_MEMORY * MEMORY_DIM]).toBe(3);
  });

  it('says how long ago each entry is, on top of where its tokens are', () => {
    // The newest entry is one frame back and takes row 0; the one before it
    // takes row 1. Getting this backwards leaves the bank ordered in reverse
    // and produces a mask rather than an error.
    const bank = layOutBank([entry(1), entry(2), entry(3)], temporal);
    const oldest = bank.positions[0] ?? 0;
    const newest = bank.positions[2 * TOKENS_PER_MEMORY * MEMORY_DIM] ?? 0;
    expect(oldest).toBe(10 + 2);
    expect(newest).toBe(30 + 0);
  });

  it('keeps the most recent entries when it is given too many', () => {
    const bank = layOutBank(
      Array.from({ length: MEMORY_ENTRIES + 3 }, (_, i) => entry(i + 1)),
      temporal,
    );
    // Ten entries offered, seven slots: the first three are gone and the
    // remainder still run oldest first.
    expect(bank.memory[0]).toBe(4);
    expect(bank.memory[6 * TOKENS_PER_MEMORY * MEMORY_DIM]).toBe(10);
    expect(openTokens(bank.keyMask)).toBe(MEMORY_ENTRIES * TOKENS_PER_MEMORY);
  });
});

describe('the mask a memory entry is encoded from', () => {
  it('thresholds a mask the user decided and softens one the model guessed', () => {
    // A click has already been decided, so it goes in hard. A prediction has
    // not, and flattening its uncertainty would tell the bank the model was
    // sure about something it was not.
    const logits = Float32Array.from([-4, -0.2, 0, 0.2, 4]);
    expect([...maskForMemory(logits, true, 20, -10)]).toEqual([-10, -10, -10, 10, 10]);

    const soft = maskForMemory(logits, false, 20, -10);
    expect(soft[2]).toBeCloseTo(0, 6);
    expect(soft[0]).toBeLessThan(-9);
    expect(soft[4]).toBeGreaterThan(9);
    // Monotonic, which is the property the encoder is entitled to assume.
    let rising = true;
    for (let i = 1; i < soft.length; i++) rising &&= (soft[i] ?? 0) > (soft[i - 1] ?? 0);
    expect(rising).toBe(true);
  });
});
