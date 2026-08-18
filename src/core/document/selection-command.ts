/**
 * Selection edits, modelled as a serialisable command log.
 *
 * The commands — not the mask texture — are the source of truth. That single
 * decision buys three things at once:
 *
 *   undo/redo         replay the prefix, instead of snapshotting a
 *                     full-resolution mask per edit (48 MB each at 48 MP)
 *   device-loss       a lost GPUDevice is recovered by rebuilding resources
 *   recovery          and replaying the log; nothing user-visible is lost
 *   video             every command carries the frame it was made on, and the
 *                     mask for a frame is folded from that frame's commands
 *
 * Every coordinate here is in IMAGE space, never screen space.
 *
 * A STILL IMAGE IS A ONE-FRAME DOCUMENT. `frame` is required rather than
 * optional so there is no second shape to reason about and no branch anywhere
 * asking whether this is a video: a photograph's edits are all at frame 0, and
 * every rule below is then the same rule.
 */

import type { RefineSettings } from '../mask/refine-params.ts';

export interface StrokePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A rectangle in image pixels, as dragged.
 *
 * Not normalised: a rectangle dragged upward or leftward is the same rectangle,
 * and the one place that has to know it is the shader that rasterises it.
 */
export interface SelectionRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface BrushStroke {
  /** Sample positions in image pixels, in the order the pointer produced them. */
  readonly points: readonly StrokePoint[];
  /** Brush radius in image pixels, so the footprint stays glued to the photo under zoom. */
  readonly radius: number;
  /** 0 = fully soft falloff across the radius, 1 = hard edge with a one-pixel antialias ramp. */
  readonly hardness: number;
}

/**
 * A mask produced outside the brush: by a segmentation engine, or by a test.
 *
 * Stored at whatever resolution produced it, which for an engine is a few
 * hundred pixels square regardless of the photograph. Keeping it small is the
 * point — it is a resolution-independent statement about the image in exactly
 * the way a stroke's coordinates are, so replaying it into a larger mask
 * reconstructs the boundary rather than magnifying an old one, and no edit ever
 * costs a full-resolution snapshot.
 */
export interface CoverageMask {
  readonly width: number;
  readonly height: number;
  /** Row-major coverage, 0..255. */
  readonly coverage: Uint8Array;
}

/**
 * Whether these commands leave any coverage behind.
 *
 * Takes ONE FRAME'S commands, from `commandsForFrame`. Handed the whole log it
 * would report coverage for a frame that has none, which is the one direction
 * this is allowed to be wrong in but not for a reason anyone would want.
 *
 * Used to decide whether the selection overlay should be drawn at all: lifting
 * "everything unselected" toward paper when nothing is selected would wash out
 * the whole image the moment it loads, which is the opposite of what the
 * overlay is for.
 *
 * Scanning backwards is enough because `clear` is absolute and `erase` can only
 * ever remove coverage — neither needs the mask itself to be inspected.
 *
 * Deliberately approximate in one direction: erasing away every painted pixel
 * without pressing Clear still reports coverage, so the overlay keeps lifting
 * an image that has nothing selected. Answering exactly would mean reading the
 * mask back from the GPU on the render path, which is a real per-frame cost to
 * pay for an edge case; over-reporting merely leaves the overlay on, while
 * under-reporting would hide a selection the user actually made.
 */
export function hasAnyCoverage(commands: readonly SelectionCommand[]): boolean {
  for (let i = commands.length - 1; i >= 0; i--) {
    const command = commands[i];
    if (!command) continue;
    if (command.kind === 'clear') return false;
    if (
      command.kind === 'paint' ||
      command.kind === 'invert' ||
      command.kind === 'applyMask' ||
      (command.kind === 'rect' && command.mode === 'paint')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The commands that decide what is selected on one frame.
 *
 * AN EDIT HOLDS FROM ITS FRAME ONWARD until something later changes it, which
 * is what every keyframe system does and what a selection is for: a region of
 * the picture that a style applies to, stated once and true from then on.
 *
 * The alternative was to make a command apply to its own frame alone, and it is
 * right about something real — a stroke's coordinates say where something was
 * when it was drawn, so a selection held across a moving subject drifts off it.
 * But nothing can currently produce the missing frames, so exact match does not
 * trade drift for accuracy; it trades a selection that drifts for no selection
 * at all. Holding forward is wrong slowly and only when the subject moves.
 * Exact match is wrong immediately and always.
 *
 * That is a statement about today rather than about the design. When tracking
 * lands it contributes commands on the frames it has followed the object to,
 * and those fold on top of the held value at each of them — the same mechanism,
 * with the gap filled in properly rather than held.
 *
 * SORTED BY FRAME, stably, not left in the order they were applied. Someone who
 * edits frame 100 and then scrubs back to clear frame 20 means the clear to
 * happen first; in log order it would happen last and wipe frame 100's work
 * while frame 100 was on screen.
 */
export function commandsForFrame(
  commands: readonly SelectionCommand[],
  frame: number,
): readonly SelectionCommand[] {
  return commands.filter((command) => command.frame <= frame).toSorted((a, b) => a.frame - b.frame);
}

/** Which frames an edit was made on, ascending. What a timeline marks. */
export function editedFrames(commands: readonly SelectionCommand[]): readonly number[] {
  return [...new Set(commands.map((command) => command.frame))].toSorted((a, b) => a - b);
}

export type SelectionCommand = { readonly frame: number } & (
  | { readonly kind: 'paint'; readonly stroke: BrushStroke }
  | { readonly kind: 'erase'; readonly stroke: BrushStroke }
  | { readonly kind: 'clear' }
  | { readonly kind: 'invert' }
  /**
   * A rectangle, meant literally.
   *
   * Stated in image pixels like a stroke, and for the same reason: a rectangle
   * exported at 6000 px is the rectangle that was dragged, with an edge
   * rasterised at that resolution rather than a magnified approximation of a
   * preview's.
   *
   * Distinct from the box the Object tools drag, which is a question for a
   * model and answers with an object rather than with the region.
   */
  | { readonly kind: 'rect'; readonly rect: SelectionRect; readonly mode: 'paint' | 'erase' }
  /**
   * The single, explicit bridge from perception to render.
   *
   * Segmentation and tracking engines analyse the whole scene and may know
   * about objects the user has not selected; none of that reaches the renderer
   * except through a command like this one, applied deliberately and undoably.
   * An engine that could write the render mask directly would collapse the
   * distinction between what Rotyl understands and what Rotyl draws.
   *
   * `refine` carries the settings the boundary was reconstructed with rather
   * than reading a module-level default, so that replaying an old log
   * reproduces the mask it produced at the time. Omitting it magnifies the
   * coverage as given, which is what a test wants and what a hand-authored
   * full-resolution mask needs.
   */
  | {
      readonly kind: 'applyMask';
      readonly mask: CoverageMask;
      readonly op: 'replace' | 'add' | 'subtract';
      readonly refine?: RefineSettings;
    }
);
