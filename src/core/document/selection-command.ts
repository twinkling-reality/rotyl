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
    if (command.kind === 'paint' || command.kind === 'invert' || command.kind === 'applyMask') return true;
  }
  return false;
}

/**
 * The commands that decide what is selected on one frame.
 *
 * EXACT MATCH, NOT "AT OR BEFORE", and that is the whole of the video model.
 * The alternative reading is the obvious one and it is wrong: a stroke's
 * coordinates say where something was when it was drawn, so replaying frame 3's
 * stroke onto frame 200 puts it wherever the object has since moved away from,
 * and the error grows with the distance. A command describes a moment, and
 * asking for a different moment is asking a question it cannot answer.
 *
 * So the log is SPARSE: a frame nobody has edited has nothing selected, and
 * says so. The hole that leaves is exactly the hole tracking fills — a keyframe
 * prompt at frame 3 and a tracker that can say where that object is at frame
 * 200 will produce frame 200's command, rather than the log pretending it
 * already had one. That is why this returns a list to fold rather than reaching
 * into the log directly: a tracker's output joins the fold on the same terms as
 * anything a person did, and the log never has to hold a mask per frame.
 */
export function commandsForFrame(
  commands: readonly SelectionCommand[],
  frame: number,
): readonly SelectionCommand[] {
  return commands.filter((command) => command.frame === frame);
}

/** Which frames carry an edit, ascending. What a timeline marks. */
export function editedFrames(commands: readonly SelectionCommand[]): readonly number[] {
  return [...new Set(commands.map((command) => command.frame))].toSorted((a, b) => a - b);
}

export type SelectionCommand = { readonly frame: number } & (
  | { readonly kind: 'paint'; readonly stroke: BrushStroke }
  | { readonly kind: 'erase'; readonly stroke: BrushStroke }
  | { readonly kind: 'clear' }
  | { readonly kind: 'invert' }
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
