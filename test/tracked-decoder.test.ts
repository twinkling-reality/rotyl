import { describe, expect, it } from 'vitest';
import { decoderIsMissing } from '../src/platform/perception/edgetam-tracker.ts';

/**
 * Which decoder a tracking host served, which is a question with a silent
 * wrong answer.
 *
 * A tracked frame runs a mask decoder this project re-exports rather than the
 * one every EdgeTAM release contains, for two outputs. Pointing
 * `VITE_TRACKING_HOST` at the published file is an ordinary mistake: it is the
 * obvious thing to serve, and it is the exact file `tools/edgetam-export`
 * exists to replace.
 *
 * ONE OF THE TWO USED TO FAIL LOUDLY AND THE OTHER DID NOT. A missing
 * `object_pointer` throws on the first frame, because it is read the way every
 * other output is. A missing `object_score_logits` fell back to the best head's
 * predicted IoU, which is a different quantity compared against the same zero
 * and is essentially always positive, so the tracker ran and reported the
 * object present on every frame of every clip, including the ones it is behind
 * something on. Everything the occlusion is carried through was inert and
 * nothing said so.
 *
 * The check itself needs a nineteen megabyte graph and a host most machines do
 * not have, which is why the part that can be tested is separated from the part
 * that cannot: this is the whole of the decision, and `loadEdgeTamTracker` only
 * asks the session for its output names and hands them over.
 */
describe('which mask decoder a tracking host served', () => {
  it('takes the re-export', () => {
    // The names `tools/edgetam-export/export.py` writes, in its own order.
    expect(decoderIsMissing(['iou_scores', 'pred_masks', 'object_score_logits', 'object_pointer'])).toEqual(
      [],
    );
  });

  it('names what the published decoder is missing, both of them', () => {
    expect(decoderIsMissing(['iou_scores', 'pred_masks'])).toEqual(['object_pointer', 'object_score_logits']);
  });

  it('names the one that used to be silent, on its own', () => {
    // The case worth having a test for. A graph carrying the pointer and not
    // the score tracks perfectly and never sees an occlusion.
    expect(decoderIsMissing(['iou_scores', 'pred_masks', 'object_pointer'])).toEqual(['object_score_logits']);
    expect(decoderIsMissing(['iou_scores', 'pred_masks', 'object_score_logits'])).toEqual(['object_pointer']);
  });
});
