import { describe, expect, it } from 'vitest';
import { packCoverage } from '../src/core/document/coverage-mask.ts';
import { orderCandidates } from '../src/core/perception/mask-candidates.ts';
import type { MaskProposal } from '../src/core/perception/segmentation-engine.ts';

/**
 * What separates three answers a person can choose between from three answers
 * a model happened to emit.
 *
 * None of this is about segmentation quality. It is about the shape of the
 * choice: that it is ordered by something visible, that the model's own
 * preference survives the reordering, and that a choice which is not really a
 * choice is not offered at all.
 */

const SIZE = 16;

/** A proposal covering the leftmost `columns` of a 16x16 frame. */
function stripe(confidence: number, columns: number, soft = false): MaskProposal {
  const coverage = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < columns; x++) {
      coverage[y * SIZE + x] = soft ? 100 : 255;
    }
  }
  return { mask: packCoverage(SIZE, SIZE, coverage), confidence };
}

describe('ordering', () => {
  it('offers the readings smallest first, whatever order they arrived in', () => {
    const { ordered } = orderCandidates([stripe(0.4, 12), stripe(0.9, 2), stripe(0.1, 7)]);
    expect(ordered.map((candidate) => candidate.area)).toEqual([2 / SIZE, 7 / SIZE, 12 / SIZE]);
  });

  it('carries the pick the engine made as an index rather than as the order', () => {
    // Confidence is the right way to choose a default and an invisible way to
    // present a choice, so the two are separated rather than conflated.
    const { ordered, best } = orderCandidates([stripe(0.4, 12), stripe(0.9, 7), stripe(0.1, 2)]);
    expect(ordered[best]?.proposal.confidence).toBe(0.9);
    expect(best).toBe(1);
  });

  it('measures coverage at the decision boundary rather than summing it', () => {
    // The engine's masks are soft ramps. Integrating them would let a wide
    // region the model is unsure about outrank a narrow one it is certain of.
    const { ordered } = orderCandidates([stripe(0.9, 14, true), stripe(0.5, 4)]);
    expect(ordered.length).toBe(1);
    expect(ordered[0]?.area).toBe(4 / SIZE);
  });
});

describe('what is not offered', () => {
  it('drops a head that produced nothing', () => {
    const { ordered } = orderCandidates([stripe(0.9, 6), stripe(0.5, 0)]);
    expect(ordered.length).toBe(1);
  });

  it('collapses two readings that are the same reading', () => {
    // An isolated object on a plain ground has no smaller reading and no larger
    // one, and three buttons that do the same thing imply a choice that is not
    // there.
    const { ordered, best } = orderCandidates([stripe(0.9, 8), stripe(0.5, 8), stripe(0.3, 2)]);
    expect(ordered.length).toBe(2);
    // The survivor of a duplicate pair is the one the engine rated higher.
    expect(ordered[best]?.proposal.confidence).toBe(0.9);
  });

  it('keeps readings that merely overlap', () => {
    // A part is entirely inside its object, so containment cannot be the test;
    // only near-equality is.
    const { ordered } = orderCandidates([stripe(0.9, 16), stripe(0.5, 8)]);
    expect(ordered.length).toBe(2);
  });

  it('answers an engine that offered nothing', () => {
    expect(orderCandidates([])).toEqual({ ordered: [], best: 0 });
  });
});
