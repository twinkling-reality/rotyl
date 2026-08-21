import type { CoverageMask } from '../document/coverage-mask.ts';
import type { SceneEmbedding } from './segmentation-engine.ts';

/**
 * Following one object through a clip.
 *
 * A SECOND INTERFACE RATHER THAN TWO MORE METHODS ON THE FIRST, and the reason
 * is that the two are different shapes of thing. `SegmentationEngine` is
 * stateless per prompt: one expensive read of a frame, then any number of cheap
 * independent answers about it, in any order, forever. A tracker is the
 * opposite. It has memory, it can only go forwards, and the answer it gives on
 * frame N is a function of every answer it gave before. Putting that behind
 * `decode` would make a click's cost depend on what had been asked previously,
 * which is the one property that makes object selection feel immediate.
 *
 * What the two share is `SceneEmbedding`, and that is not incidental. Reading a
 * frame costs 44 ms of a 135 ms tracked frame and both of them need exactly
 * that reading, so a tracked frame encodes once and every track advances
 * against the same embedding: two objects is 226 ms rather than 270.
 *
 * TRACKING A SECOND OBJECT IS A SECOND `ObjectTrack`, not a mode. That is the
 * whole reason a track is a value here rather than a state the engine is in:
 * `runTracking` advances a list of them against one embedding per frame, so two
 * objects cost two mask decodes and two memory banks and share the expensive
 * part. Nothing in here counts them: how many there are is a question about a
 * selection, and `tracking-seeds.ts` answers it from the command log.
 *
 * A SECOND TRACKER IS A SECOND `TrackingEngine`. Nothing in `tracking-job.ts`
 * mentions a model, a runtime or a memory bank, so a different one is a
 * different implementation of these four methods.
 */

/** What a tracker says about one frame. */
export interface TrackedMask {
  /**
   * Coverage at the engine's own resolution, exactly as a click's is.
   *
   * Deliberately not upscaled here, for the same reason `MaskProposal`'s is
   * not: where the boundary falls in the photograph is the refinement bridge's
   * question, and it needs the photograph to answer it.
   */
  readonly mask: CoverageMask;
  /**
   * Whether the object is in this frame at all, from the model rather than from
   * counting pixels.
   *
   * An object that has gone behind something is not an object that got smaller,
   * and a tracker with nothing to report has to be able to say so. Measured on
   * a fixture whose occlusion outlasts the memory bank, the reference produces
   * an empty mask for exactly the frames the object is hidden, so this is the
   * model agreeing with itself rather than a threshold anybody chose.
   */
  readonly present: boolean;
}

/**
 * One object, being followed.
 *
 * Holds a memory bank, which is why it is disposed rather than collected: at
 * 3648 tokens it is megabytes, and a clip with four tracked objects has four.
 */
export interface ObjectTrack {
  /**
   * Where the object went, on the frame this embedding describes.
   *
   * Forward only, one frame at a time, and the frames must arrive in order.
   * That is not a limitation of an implementation, it is what a memory bank is:
   * the answer on frame N conditions the bank that answers frame N+1, so there
   * is no meaning to advancing twice on the same frame or to going back.
   */
  advance(embedding: SceneEmbedding): Promise<TrackedMask>;
  dispose(): void;
}

export interface TrackingEngine {
  /**
   * Start following what a mask describes, from the frame that mask was made
   * on.
   *
   * The mask is the seed rather than a prompt, because by the time anything is
   * tracked the user has already chosen: they clicked, they picked between the
   * three readings of that click, and possibly they brushed. What gets followed
   * is the answer, not the question.
   */
  begin(embedding: SceneEmbedding, seed: CoverageMask): Promise<ObjectTrack>;
  dispose(): void;
}
