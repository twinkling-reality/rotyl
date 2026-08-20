import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  atMemoryResolution,
  FEATURE_DIM,
  FEATURE_TOKENS,
  layOutBank,
  MASK_SIZE,
  maskForMemory,
  MEMORY_DIM,
  MEMORY_ENTRIES,
  MEMORY_MASK,
  MEMORY_TOKENS,
  RECENT_ENTRIES,
  TOKENS_PER_MEMORY,
  toChannelMajor,
  toTokenMajor,
  visionPositionEncoding,
  type MemoryEntry,
} from '../src/core/perception/memory-bank.ts';

/**
 * The half of a tracker that can be checked without a tracker.
 *
 * Everything here is arithmetic the reference also does, so it can be wrong in
 * exactly one way: agreeing with its author and not with the model. So none of
 * it is checked against the formula this file could have copied wrong in the
 * same direction twice. It is checked against `tools/edgetam-export`, which
 * runs the reference tracker over a clip and writes down what it hands each
 * graph. Every assertion below sets exactly the inputs the reference had at a
 * few dozen spread indices, runs the real function at the real size, and reads
 * exactly the outputs the reference produced.
 *
 * Spread rather than contiguous, and over both axes, for the reason the
 * fixtures give: a transposed field, a swapped sine and cosine and an off-by-
 * one grid all agree with the right answer somewhere and none of them agrees
 * everywhere.
 *
 * WRITTEN TO ALLOCATE ALMOST NOTHING BOXED, which is not a style preference.
 * The suite keeps a Dawn device alive across files and the garbage a test makes
 * while it is alive aborts the worker outright, with every assertion already
 * passed. Spreading a 3648-element mask into a JS array to count it did exactly
 * that: `mask-refine` went from failing one run in three to failing every run.
 * The typed arrays here are large and few, which is the shape that is fine; the
 * counting is loops.
 */

interface EncodingFixture {
  readonly size: readonly [number, number];
  readonly channels: number;
  readonly tokens: readonly number[];
  readonly at: readonly number[];
  readonly values: readonly (readonly number[])[];
}

interface HostFixture {
  readonly constants: { readonly sigmoidScale: number; readonly sigmoidBias: number };
  readonly memoryTokens: readonly number[];
  readonly memoryChannels: readonly number[];
  readonly patch: number;
  readonly noMemoryEmbedding: readonly number[];
  readonly temporal: readonly number[];
  readonly frames: readonly {
    readonly frame: number;
    readonly rawTokens: readonly {
      readonly channel: number;
      readonly token: number;
      readonly encoded: number;
      readonly raw: number;
    }[];
    readonly channelMajor: readonly {
      readonly token: number;
      readonly channel: number;
      readonly conditioned: number;
      readonly decoded: number;
    }[];
    readonly bank: {
      readonly slots: readonly number[];
      readonly entries: readonly {
        readonly features: readonly number[];
        readonly positions: readonly number[];
      }[];
      readonly memory: readonly number[];
      readonly positions: readonly number[];
    };
    readonly maskForMemory: readonly {
      readonly origin: readonly [number, number];
      readonly source: readonly number[];
      readonly probes: readonly { readonly y: number; readonly x: number; readonly value: number }[];
    }[];
  }[];
}

const host: HostFixture = JSON.parse(readFileSync('tools/edgetam-export/host-fixture.json', 'utf8'));
const temporal = Float32Array.from(host.temporal);

/** An entry of one value throughout, so a misplaced one shows up as a number. */
function flat(fill: number): MemoryEntry {
  return {
    features: new Float32Array(TOKENS_PER_MEMORY * MEMORY_DIM).fill(fill),
    positions: new Float32Array(TOKENS_PER_MEMORY * MEMORY_DIM),
  };
}

/** Counted rather than filtered: see the note above about garbage. */
function openTokens(keyMask: Float32Array): number {
  let open = 0;
  for (const value of keyMask) if (value === 0) open++;
  return open;
}

describe('the vision position encoding', () => {
  it('agrees with the checkpoint that produced it', () => {
    // A transposed axis, a swapped sine and cosine and a grid that starts at
    // zero instead of one all produce a plausible field, and none of them
    // produces an error. `host.py` puts the whole 4096 by 256 tensor against
    // the reference's own at 6.9e-7; these nine by nine are what a test can
    // carry without committing four megabytes.
    const fixture: EncodingFixture = JSON.parse(
      readFileSync('tools/edgetam-export/position-encoding.json', 'utf8'),
    );
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

describe('the frame the encoder read, in the layout attention takes', () => {
  it('is the reference’s own features once the no-memory embedding is off', () => {
    // Two claims at once, and both fail silently. The published encoder ADDS
    // `no_memory_embedding` to its last feature map, which is right for a
    // single image and wrong for a tracked frame; and its buffer is
    // channel-major where attention wants token-major. Getting either backwards
    // gives a mask of roughly the right object and no error anywhere.
    //
    // One buffer for every frame: they probe the same indices, so each pass
    // overwrites all of the previous one, and a fresh four-megabyte array per
    // frame is exactly the kind of garbage that aborts the GPU files.
    const encoded = new Float32Array(FEATURE_TOKENS * FEATURE_DIM);
    for (const frame of host.frames) {
      for (const probe of frame.rawTokens) {
        encoded[probe.channel * FEATURE_TOKENS + probe.token] = probe.encoded;
      }
      const raw = toTokenMajor(encoded, host.noMemoryEmbedding);
      expect(raw.length).toBe(FEATURE_TOKENS * FEATURE_DIM);
      for (const probe of frame.rawTokens) {
        // The published encoder and the reference agree to about 2e-5, which is
        // the graph's own error and not this transpose's.
        expect(
          raw[probe.token * FEATURE_DIM + probe.channel],
          `frame ${String(frame.frame)} token ${String(probe.token)} channel ${String(probe.channel)}`,
        ).toBeCloseTo(probe.raw, 4);
      }
    }
  });
});

describe('the conditioned frame, in the layout the mask decoder takes', () => {
  it('is the reference’s own transpose of what attention answered', () => {
    // Memory attention answers at (1, 1, 4096, 256) and the decoder wants
    // (1, 256, 64, 64). Both sides of this come from the reference's own two
    // tensors rather than from one of them read twice.
    const tokens = new Float32Array(FEATURE_TOKENS * FEATURE_DIM);
    for (const frame of host.frames) {
      for (const probe of frame.channelMajor) {
        tokens[probe.token * FEATURE_DIM + probe.channel] = probe.conditioned;
      }
      const channels = toChannelMajor(tokens);
      for (const probe of frame.channelMajor) {
        expect(
          channels[probe.channel * FEATURE_TOKENS + probe.token],
          `frame ${String(frame.frame)} token ${String(probe.token)}`,
        ).toBeCloseTo(probe.decoded, 5);
      }
    }
  });
});

describe('laying out a memory bank', () => {
  /** An entry whose probed values are the reference's and whose rest is zero. */
  function entryFrom(source: { features: readonly number[]; positions: readonly number[] }): MemoryEntry {
    const features = new Float32Array(TOKENS_PER_MEMORY * MEMORY_DIM);
    const positions = new Float32Array(TOKENS_PER_MEMORY * MEMORY_DIM);
    let index = 0;
    for (const token of host.memoryTokens) {
      for (const channel of host.memoryChannels) {
        features[token * MEMORY_DIM + channel] = source.features[index] ?? 0;
        positions[token * MEMORY_DIM + channel] = source.positions[index] ?? 0;
        index++;
      }
    }
    return { features, positions };
  }

  it('holds the frame the object was pointed at, however long ago that was', () => {
    // THE CLAIM THE WHOLE LAYOUT RESTS ON, taken off the reference rather than
    // out of its source: the fixture names which frame each 512-token block of
    // the reference's own bank came from, matched by value against the entries
    // its memory encoder produced. On the last frame of a thirty-frame clip
    // that is frame zero plus the six before this one, twenty-two frames after
    // a window keeping the last seven would have dropped the first.
    const last = host.frames.at(-1);
    expect(last).toBeDefined();
    const slots = last?.bank.slots ?? [];
    expect(slots.length).toBe(MEMORY_ENTRIES);
    expect(slots[0]).toBe(0);
    // And the rest are consecutive and end on the frame before this one, which
    // is what makes their temporal rows count back from zero.
    slots.slice(1).forEach((slot, index) => {
      expect(slot).toBe((last?.frame ?? 0) - RECENT_ENTRIES + index);
    });
  });

  it('is the bank the reference built, entry for entry and row for row', () => {
    // THE ONE THAT WAS WRONG. The reference holds the frame the object was
    // pointed at plus the six before this one, gives the first the OLDEST
    // temporal row whatever else is in the bank, and never drops it. A sliding
    // window of the last seven agrees with that for exactly seven frames.
    //
    // The fixture's slots are matched against the entries the memory encoder
    // actually produced rather than read off the reference's source, so what is
    // asserted here is what the reference did and not what it says it does.
    for (const frame of host.frames) {
      const built = frame.bank.entries.map(entryFrom);
      const [anchor, ...recent] = built;
      expect(anchor).toBeDefined();
      if (!anchor) continue;

      const bank = layOutBank(anchor, recent, temporal);
      expect(bank.memory.length).toBe(MEMORY_TOKENS * MEMORY_DIM);
      expect(bank.positions.length).toBe(MEMORY_TOKENS * MEMORY_DIM);
      expect(openTokens(bank.keyMask)).toBe(built.length * TOKENS_PER_MEMORY);

      let index = 0;
      for (let slot = 0; slot < built.length; slot++) {
        for (const token of host.memoryTokens) {
          for (const channel of host.memoryChannels) {
            const at = (slot * TOKENS_PER_MEMORY + token) * MEMORY_DIM + channel;
            const where = `frame ${String(frame.frame)} slot ${String(slot)} token ${String(token)}`;
            expect(bank.memory[at], where).toBeCloseTo(frame.bank.memory[index] ?? Number.NaN, 5);
            // The temporal row is inside this one: the reference's position is
            // the encoder's spatial answer plus the row for how long ago the
            // entry is, and a bank that numbers the anchor by its slot puts a
            // different row here.
            expect(bank.positions[at], where).toBeCloseTo(frame.bank.positions[index] ?? Number.NaN, 5);
            index++;
          }
        }
      }
    }
  });

  it('gives the anchor the oldest row even when the bank is nearly empty', () => {
    // The first tracked frame of every run has a bank of one entry, and that
    // entry is a conditioning frame: the reference asks for the row before
    // offset zero and lands on the last one. Numbering it by position gives
    // row zero, which is the bank claiming the seed frame is the most recent
    // thing in it.
    // One recognisable value per row, so a misindexed entry shows up as a value.
    const rows = Float32Array.from({ length: MEMORY_ENTRIES * MEMORY_DIM }, (_, i) =>
      Math.floor(i / MEMORY_DIM),
    );

    const alone = layOutBank(flat(1), [], rows);
    expect(alone.positions[0]).toBe(MEMORY_ENTRIES - 1);
    expect(openTokens(alone.keyMask)).toBe(TOKENS_PER_MEMORY);

    const withTwo = layOutBank(flat(1), [flat(2), flat(3)], rows);
    expect(withTwo.positions[0]).toBe(MEMORY_ENTRIES - 1);
    expect(withTwo.positions[TOKENS_PER_MEMORY * MEMORY_DIM]).toBe(1);
    expect(withTwo.positions[2 * TOKENS_PER_MEMORY * MEMORY_DIM]).toBe(0);
  });

  it('keeps the anchor and the most recent when it is given too many', () => {
    const recent: MemoryEntry[] = [];
    for (let i = 1; i <= RECENT_ENTRIES + 3; i++) recent.push(flat(i + 1));

    const bank = layOutBank(flat(1), recent, temporal);
    // The seed is still slot zero, and the three oldest tracked frames are gone.
    expect(bank.memory[0]).toBe(1);
    expect(bank.memory[TOKENS_PER_MEMORY * MEMORY_DIM]).toBe(5);
    expect(bank.memory[RECENT_ENTRIES * TOKENS_PER_MEMORY * MEMORY_DIM]).toBe(RECENT_ENTRIES + 4);
    expect(openTokens(bank.keyMask)).toBe(MEMORY_ENTRIES * TOKENS_PER_MEMORY);
    // The pointer block is the last one and there is nothing in it: the
    // published mask decoder does not expose `object_pointer`.
    expect(bank.keyMask.at(-1)).toBeLessThan(0);
    expect(bank.memory.at(-1)).toBe(0);
  });
});

describe('the mask a memory entry is encoded from', () => {
  it('is what the reference hands the memory encoder', () => {
    // NEAREST WAS WRONG HERE AND SAID NOTHING. The reference has no
    // higher-resolution mask of its own: it bilinearly upsamples exactly these
    // 256 px logits to the 1024 px the graph declares, then sigmoids them.
    // Resampling nearest instead is out by the whole range of the field along
    // every edge, and produces a mask.
    const { sigmoidScale, sigmoidBias } = host.constants;
    // ONE FRAME, THREE PATCHES: an edge, somewhere inside and somewhere
    // outside. What is being checked is index arithmetic and a sigmoid, neither
    // of which knows what frame it is on, and each call allocates the four
    // megabytes the graph declares. `host.py` compares the whole 1024 px field
    // on every frame of every clip, where the memory is not shared with a Dawn
    // device that aborts when this file makes it collect.
    const frame = host.frames[0];
    expect(frame).toBeDefined();
    const field = new Float32Array(MASK_SIZE * MASK_SIZE);
    for (const patch of frame?.maskForMemory ?? []) {
      field.fill(0);
      const [originY, originX] = patch.origin;
      for (let y = 0; y < host.patch; y++) {
        for (let x = 0; x < host.patch; x++) {
          field[(originY + y) * MASK_SIZE + originX + x] = patch.source[y * host.patch + x] ?? 0;
        }
      }
      // Every probe below reads only pixels this patch carries, which is what
      // the halo either side of it is for.
      const encoded = maskForMemory(atMemoryResolution(field), false, sigmoidScale, sigmoidBias);
      expect(encoded.length).toBe(MEMORY_MASK * MEMORY_MASK);
      for (const probe of patch.probes) {
        expect(
          encoded[probe.y * MEMORY_MASK + probe.x],
          `at ${String(probe.y)},${String(probe.x)}`,
        ).toBeCloseTo(probe.value, 4);
      }
    }
  });

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
