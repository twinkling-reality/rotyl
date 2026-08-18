import type { CoverageMask } from '../document/selection-command.ts';
import type { MaskProposal } from './segmentation-engine.ts';

/**
 * Turning what the engine offered into what a person can choose between.
 *
 * A prompt-based segmenter answers a click with several masks at once because
 * the click is ambiguous: a point on a sleeve is a cuff, a shirt, and a person,
 * and the model has no way to know which was meant. It ranks them by its own
 * predicted IoU, which is the right order for picking a default and the wrong
 * order for offering a choice. Confidence is not a quantity anyone can see.
 *
 * SIZE IS. So the candidates are ordered by how much they cover, smallest
 * first, which is the axis the user is actually deciding along, and the
 * engine's own preference is carried alongside as an index rather than as the
 * order.
 *
 * Coverage is compared at half, not summed. The engine's masks are soft ramps
 * around a decision boundary, and integrating them would let a large uncertain
 * haze outrank a small confident object.
 */

export interface MaskCandidate {
  readonly proposal: MaskProposal;
  /** Fraction of the frame this covers, 0 to 1. */
  readonly area: number;
}

export interface Candidates {
  /** Smallest first. Empty if the engine had nothing to offer. */
  readonly ordered: readonly MaskCandidate[];
  /** Index into `ordered` of the answer the engine rated highest. */
  readonly best: number;
}

export const NO_CANDIDATES: Candidates = { ordered: [], best: 0 };

/** Coverage at or above this counts as inside. */
const SOLID = 128;

/**
 * Below this an answer is not a small object, it is a head that produced
 * nothing, and offering it as a choice would be offering an empty selection.
 */
const EMPTY_AREA = 0.0005;

/**
 * Above this overlap two answers are the same answer.
 *
 * The three heads frequently agree, an isolated object on a plain ground has
 * no smaller reading and no larger one, and presenting three buttons that do
 * the same thing is worse than presenting one, because it implies a choice that
 * is not there.
 */
const SAME_ANSWER_IOU = 0.9;

function solidArea(mask: CoverageMask): number {
  let inside = 0;
  for (const value of mask.coverage) {
    if (value >= SOLID) inside++;
  }
  return inside / Math.max(1, mask.coverage.length);
}

function overlap(a: CoverageMask, b: CoverageMask): number {
  // Masks from one engine are always the same size; two that are not cannot be
  // compared this way and are certainly not duplicates of each other.
  if (a.width !== b.width || a.height !== b.height) return 0;

  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.coverage.length; i++) {
    const inA = (a.coverage[i] ?? 0) >= SOLID;
    const inB = (b.coverage[i] ?? 0) >= SOLID;
    if (inA && inB) intersection++;
    if (inA || inB) union++;
  }
  return union === 0 ? 1 : intersection / union;
}

export function orderCandidates(proposals: readonly MaskProposal[]): Candidates {
  // Sorted here rather than trusted, so that "the duplicate we keep is the one
  // the engine rated higher" holds whatever order the engine handed over.
  const byConfidence = proposals.toSorted((a, b) => b.confidence - a.confidence);

  const kept: MaskCandidate[] = [];
  for (const proposal of byConfidence) {
    const area = solidArea(proposal.mask);
    if (area < EMPTY_AREA) continue;
    if (kept.some((candidate) => overlap(candidate.proposal.mask, proposal.mask) >= SAME_ANSWER_IOU)) {
      continue;
    }
    kept.push({ proposal, area });
  }

  const preferred = kept[0];
  const ordered = kept.toSorted((a, b) => a.area - b.area);
  return {
    ordered,
    best: preferred ? ordered.indexOf(preferred) : 0,
  };
}
