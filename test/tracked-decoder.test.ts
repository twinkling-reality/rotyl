import { describe, expect, it } from 'vitest';
import { decoderIsMissing } from '../src/platform/perception/edgetam-tracker.ts';

/**
 * Which decoder the owned release contains, which is a question with two different
 * wrong answers and only one of them loud.
 *
 * A tracked frame runs a mask decoder this project re-exports rather than the
 * one every EdgeTAM release contains, for two outputs. Pointing
 * Putting the published file in the tracked decoder's place is an ordinary mistake: it is the
 * obvious thing to serve, and it is the exact file `tools/edgetam-export`
 * exists to replace.
 *
 * THE PUBLISHED DECODER IS MISSING ONE OF THE TWO, NOT BOTH. This file used to
 * say both and to pin a graph shape as "the published decoder" that no release
 * contains. Asked of the real file at the revision `model-store.ts` pins, in
 * both precisions, it declares `iou_scores`, `pred_masks` and
 * `object_score_logits`, and no `object_pointer`. Serving it has therefore
 * always failed, and failed loudly, on the first tracked frame: the pointer is
 * read the way every other output is.
 *
 * THE SILENT CASE IS REAL AND IS A GRAPH NOBODY SHIPS. One carrying the pointer
 * and no object score fell back to the best head's predicted IoU, a different
 * quantity compared against the same zero and essentially always positive, so
 * it would have tracked and reported the object present on every frame of every
 * clip. That is why the check names whichever is missing rather than testing
 * for one file.
 *
 * The check itself needs a thirty megabyte graph and a host most machines do
 * not have, which is why the part that can be tested is separated from the part
 * that cannot: this is the whole of the decision, and `loadEdgeTamTracker` only
 * asks the session for its output names and hands them over.
 */
describe('which mask decoder the owned release contains', () => {
  it('takes the re-export', () => {
    // The names `tools/edgetam-export/export.py` writes, in its own order, and
    // the names `tracked_mask_decoder_fp16.onnx` still declares after
    // `half_precision.py` has been over it.
    expect(decoderIsMissing(['iou_scores', 'pred_masks', 'object_score_logits', 'object_pointer'])).toEqual(
      [],
    );
  });

  it('names what the published decoder is actually missing, which is the pointer', () => {
    // The real output list of `prompt_encoder_mask_decoder.onnx`, and of its
    // half-precision twin, at the pinned revision.
    expect(decoderIsMissing(['iou_scores', 'pred_masks', 'object_score_logits'])).toEqual(['object_pointer']);
  });

  it('names the one that used to be silent, on its own', () => {
    // The case worth having a check for rather than an exception: a graph
    // carrying the pointer and not the score tracks perfectly and never sees an
    // occlusion. Nothing published has this shape, which is the point of asking
    // for names instead of recognising a file.
    expect(decoderIsMissing(['iou_scores', 'pred_masks', 'object_pointer'])).toEqual(['object_score_logits']);
  });

  it('names both when a graph has neither', () => {
    expect(decoderIsMissing(['iou_scores', 'pred_masks'])).toEqual(['object_pointer', 'object_score_logits']);
  });
});
