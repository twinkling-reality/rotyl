import { describe, expect, it } from 'vitest';
import { expandCoverage, packCoverage, type CoverageMask } from '../src/core/document/coverage-mask.ts';
import { objectsInSelection, seedsFrom } from '../src/core/perception/tracking-seeds.ts';
import type { BrushStroke, SelectionCommand } from '../src/core/document/selection-command.ts';

/**
 * Reading one selection as the several objects it is made of.
 *
 * The thing being asserted is that a run follows what somebody pointed at, one
 * track per thing, and that a selection nobody pointed at is still exactly one
 * track. The second half matters more than the first: every run this product
 * has ever made was one seed of the whole coverage, and a change that quietly
 * split those into several would be a change to work already done.
 */

const SIZE = 16;

/** A filled box, as the model's own 256 px answer is: coverage, not a shape. */
function box(x0: number, y0: number, x1: number, y1: number): CoverageMask {
  const bytes = new Uint8Array(SIZE * SIZE);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) bytes[y * SIZE + x] = 255;
  return packCoverage(SIZE, SIZE, bytes);
}

/** The union of several, which is what the renderer's mask holds after them. */
function union(...masks: readonly CoverageMask[]): CoverageMask {
  const bytes = new Uint8Array(SIZE * SIZE);
  for (const mask of masks) {
    const expanded = expandCoverage(mask);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.max(bytes[i] ?? 0, expanded[i] ?? 0);
  }
  return packCoverage(SIZE, SIZE, bytes);
}

/** One model answer, as `PerceptionStore` commits one: added, never replacing. */
function answer(
  mask: CoverageMask,
  extra: { op?: 'replace' | 'add'; absent?: true; group?: number } = {},
): SelectionCommand {
  return {
    kind: 'applyMask',
    mask,
    op: extra.op ?? 'add',
    frame: 0,
    ...(extra.absent === undefined ? {} : { absent: extra.absent }),
    ...(extra.group === undefined ? {} : { group: extra.group }),
  };
}

const stroke: BrushStroke = { points: [{ x: 1, y: 2 }], radius: 4, hardness: 1 };
const painted: SelectionCommand = { kind: 'paint', stroke, frame: 0 };

/** Which pixels a seed holds, as a set of indices at or above solid. */
function inside(mask: CoverageMask): ReadonlySet<number> {
  const bytes = expandCoverage(mask);
  const at = new Set<number>();
  for (let i = 0; i < bytes.length; i++) if ((bytes[i] ?? 0) >= 128) at.add(i);
  return at;
}

describe('how many objects a selection is made of', () => {
  it('counts a hand-drawn selection as one', () => {
    expect(objectsInSelection([painted])).toBe(1);
    const dragged: SelectionCommand = {
      kind: 'rect',
      mode: 'paint',
      rect: { x0: 0, y0: 0, x1: 4, y1: 4 },
      frame: 0,
    };
    expect(objectsInSelection([painted, dragged])).toBe(1);
  });

  it('counts one model answer as one', () => {
    expect(objectsInSelection([answer(box(1, 1, 5, 5))])).toBe(1);
  });

  it('counts two answers as two, which is what two fresh prompts leave', () => {
    expect(objectsInSelection([answer(box(1, 1, 5, 5)), answer(box(9, 9, 13, 13))])).toBe(2);
  });

  it('does not count a frame the model said the object was not in', () => {
    // A run's own command on an occluded frame carries an empty mask and says
    // so. There is nothing there to seed a second run from.
    const hidden = answer(packCoverage(SIZE, SIZE, new Uint8Array(SIZE * SIZE)), {
      op: 'add',
      absent: true,
    });
    expect(objectsInSelection([answer(box(1, 1, 5, 5)), hidden])).toBe(1);
  });

  it('counts a tracked frame the way the frame it started from was counted', () => {
    // Re-tracking from part way along finds the run's own commands in the fold:
    // one `replace` and one `add` per object, so the count survives the run.
    const first = answer(box(1, 1, 5, 5), { op: 'replace', group: 1 });
    const second = answer(box(9, 9, 13, 13), { op: 'add', group: 1 });
    expect(objectsInSelection([first, second])).toBe(2);
  });
});

describe('splitting a selection among them', () => {
  it('hands back the whole coverage when there is one object', () => {
    const coverage = box(1, 1, 5, 5);
    const seeds = seedsFrom(coverage, [answer(coverage)]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toBe(coverage);
  });

  it('hands back the whole coverage when nobody pointed at anything', () => {
    const coverage = box(1, 1, 5, 5);
    const seeds = seedsFrom(coverage, [painted]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toBe(coverage);
  });

  it('partitions two answers, and the union is the selection', () => {
    const a = box(1, 1, 5, 5);
    const b = box(9, 9, 13, 13);
    const seeds = seedsFrom(union(a, b), [answer(a), answer(b)]);
    expect(seeds).toHaveLength(2);

    const [first, second] = seeds;
    expect(first && second).toBeTruthy();
    if (!first || !second) return;
    expect(inside(first)).toEqual(inside(a));
    expect(inside(second)).toEqual(inside(b));
    // Nothing is followed twice, which is what makes this a partition rather
    // than two overlapping seeds.
    for (const at of inside(first)) expect(inside(second).has(at)).toBe(false);
  });

  it('gives what no answer claims to the first object', () => {
    // The rule that keeps a single-object run exactly what it was: a brushed
    // region is not a thing anybody pointed at, so it is not a thing of its
    // own. It rides with the first.
    const a = box(1, 1, 5, 5);
    const b = box(9, 9, 13, 13);
    const brushed = box(1, 9, 3, 11);
    const seeds = seedsFrom(union(a, b, brushed), [answer(a), answer(b), painted]);
    expect(seeds).toHaveLength(2);

    const [first, second] = seeds;
    expect(first && second).toBeTruthy();
    if (!first || !second) return;
    expect(inside(first)).toEqual(new Set([...inside(a), ...inside(brushed)]));
    expect(inside(second)).toEqual(inside(b));
  });

  it('gives an overlap to the later answer', () => {
    // The rule the rest of this log follows: a later command is the more recent
    // statement about a pixel.
    const a = box(1, 1, 8, 8);
    const b = box(5, 5, 13, 13);
    const seeds = seedsFrom(union(a, b), [answer(a), answer(b)]);
    const [first, second] = seeds;
    expect(first && second).toBeTruthy();
    if (!first || !second) return;
    expect(inside(second)).toEqual(inside(b));
    expect(inside(first).has(5 * SIZE + 5)).toBe(false);
    expect(inside(first).has(1 * SIZE + 1)).toBe(true);
  });

  it('drops an answer the eraser took away entirely', () => {
    // The coverage is what the renderer actually holds, so everything that has
    // happened since the click is already in it. An answer with nothing left is
    // a seed of nothing, and a tracker handed one would follow nothing.
    const a = box(1, 1, 5, 5);
    const b = box(9, 9, 13, 13);
    const seeds = seedsFrom(a, [answer(a), answer(b)]);
    expect(seeds).toHaveLength(1);
    const [only] = seeds;
    expect(only).toBeTruthy();
    if (!only) return;
    expect(inside(only)).toEqual(inside(a));
  });

  it('falls back to one seed rather than partitioning across two resolutions', () => {
    // A document written by another build could hold a mask of a different
    // shape. A pixel-wise partition has no meaning across two of them, and one
    // seed is a worse run rather than a wrong one.
    const coverage = box(1, 1, 5, 5);
    const odd = packCoverage(8, 8, new Uint8Array(64).fill(255));
    const seeds = seedsFrom(coverage, [answer(coverage), answer(odd)]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toBe(coverage);
  });

  it('keeps the ramp rather than squaring the edge off', () => {
    // A seed is a coverage mask and the memory encoder reads it as one, so a
    // partition that thresholded would hand the model a harder boundary than
    // anybody drew.
    const soft = new Uint8Array(SIZE * SIZE);
    for (let y = 1; y < 5; y++) for (let x = 1; x < 5; x++) soft[y * SIZE + x] = x === 4 ? 200 : 255;
    const a = packCoverage(SIZE, SIZE, soft);
    const b = box(9, 9, 13, 13);
    const seeds = seedsFrom(union(a, b), [answer(a), answer(b)]);
    const [first] = seeds;
    expect(first).toBeTruthy();
    if (!first) return;
    expect(expandCoverage(first)[1 * SIZE + 4]).toBe(200);
  });
});
