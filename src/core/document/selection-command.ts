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
 *   future video      a per-frame keyframe log is the same structure with a
 *                     frame index attached
 *
 * Every coordinate here is in IMAGE space, never screen space.
 */

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
 * A mask produced outside the brush — today only by tests, tomorrow by a
 * segmentation engine. Stored as full-resolution 8-bit coverage so it replays
 * exactly like every other command.
 */
export interface CoverageMask {
  readonly width: number;
  readonly height: number;
  /** Row-major coverage, 0..255. */
  readonly coverage: Uint8Array;
}

/**
 * Whether the log leaves any coverage behind.
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

export type SelectionCommand =
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
   */
  | { readonly kind: 'applyMask'; readonly mask: CoverageMask; readonly op: 'replace' | 'add' | 'subtract' };
