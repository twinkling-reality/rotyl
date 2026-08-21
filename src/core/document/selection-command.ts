/**
 * Selection edits, modelled as a serialisable command log.
 *
 * The commands, not the mask texture, are the source of truth. That single
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

import type { CoverageMask } from './coverage-mask.ts';
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
 * ever remove coverage. Neither needs the mask itself to be inspected.
 *
 * Deliberately approximate in one direction: erasing away every painted pixel
 * without pressing Clear still reports coverage, so the overlay keeps lifting
 * an image that has nothing selected. Answering exactly would mean reading the
 * mask back from the GPU on the render path, which is a real per-frame cost to
 * pay for an edge case; over-reporting merely leaves the overlay on, while
 * under-reporting would hide a selection the user actually made.
 *
 * ONE OF THOSE CASES IS NOT APPROXIMATE ANY MORE, and it is the case a tracked
 * clip meets most often. A mask the model said the object was not in covers
 * nothing and now says so, so it needs no readback to be recognised: applied
 * with `replace` it decides the frame and the frame has nothing on it, which is
 * exactly what `clear` means here. Applied with anything else it contributes
 * nothing and the scan carries on past it, which is also what it means.
 */
export function hasAnyCoverage(commands: readonly SelectionCommand[]): boolean {
  for (let i = commands.length - 1; i >= 0; i--) {
    const command = commands[i];
    if (!command) continue;
    if (command.kind === 'clear') return false;
    if (command.kind === 'applyMask' && command.absent === true) {
      if (command.op === 'replace') return false;
      continue;
    }
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
 * right about something real. A stroke's coordinates say where something was
 * when it was drawn, so a selection held across a moving subject drifts off it.
 * But nothing can currently produce the missing frames, so exact match does not
 * trade drift for accuracy; it trades a selection that drifts for no selection
 * at all. Holding forward is wrong slowly and only when the subject moves.
 * Exact match is wrong immediately and always.
 *
 * That is a statement about today rather than about the design. When tracking
 * lands it contributes commands on the frames it has followed the object to,
 * and those fold on top of the held value at each of them, the same mechanism,
 * with the gap filled in properly rather than held.
 *
 * SORTED BY FRAME, stably, not left in the order they were applied. Someone who
 * edits frame 100 and then scrubs back to clear frame 20 means the clear to
 * happen first; in log order it would happen last and wipe frame 100's work
 * while frame 100 was on screen.
 *
 * AND CUT AT THE LAST COMMAND THAT DECIDES THE FRAME BY ITSELF, which is a
 * clear or a mask applied with `replace`. Everything before one of those is
 * discarded by it, so replaying it costs a texture upload, a refinement and a
 * composite for a result nobody sees. That is arithmetic on a photograph, where
 * a log is a handful of strokes, and it is the difference between usable and
 * not on a tracked clip: a run writes one `replace` per frame it followed the
 * object to, so three hundred frames folded to three hundred commands, of which
 * two hundred and ninety-nine were overwritten by the next. Measured, unpacking
 * that many masks alone is 10.5 ms against a 33 ms frame, before any of them
 * reaches the GPU.
 *
 * WHICH LEAVES ONE COMMAND PER OBJECT AND NOT ONE, and that is the one thing
 * here that following more than one object changed. A run replaces for its
 * FIRST seed and adds for the rest, because two objects have to be two regions
 * rather than a race, so the cut lands on the first one's command and the ones
 * after it survive. Ten minutes following three things folds fifty-four
 * thousand commands to three rather than to one, at 0.7 ms against 0.3, and a
 * replay then unpacks three masks. See `/research/per-object.html`, which is
 * where the four figures this sentence used to be one of were taken again.
 */
export function commandsForFrame(
  commands: readonly SelectionCommand[],
  frame: number,
): readonly SelectionCommand[] {
  const held = commands.filter((command) => command.frame <= frame).toSorted((a, b) => a.frame - b.frame);
  for (let i = held.length - 1; i >= 0; i--) {
    const command = held[i];
    if (!command) continue;
    if (command.kind === 'clear' || (command.kind === 'applyMask' && command.op === 'replace')) {
      return held.slice(i);
    }
  }
  return held;
}

/**
 * One stretch of the clip the log has something to say about.
 *
 * A single edit is a span of one frame. A tracking run is a span of however
 * many frames it reached, because a run IS one stretch: `group` has said so
 * since tracking landed, and the projection that fed the timeline threw it away
 * and handed over three hundred frame numbers that looked exactly like three
 * hundred separate strokes.
 *
 * `absent` is the third, and it is the one this exists for. A frame the model
 * said the object was not in carries an `applyMask` with an empty mask, which
 * is indistinguishable by shape from a selection that legitimately covers
 * nothing. The command says which it is now, so a run can be drawn with the
 * occlusion in it rather than as an unbroken bar over frames that show nothing.
 */
export interface EditSpan {
  /** First frame, inclusive. */
  readonly from: number;
  /** Last frame, inclusive. The same as `from` for a single edit. */
  readonly to: number;
  /** A hand edit, a stretch a run followed, or a stretch it found nothing in. */
  readonly kind: 'edit' | 'tracked' | 'absent';
}

/** What one frame's commands amount to, before consecutive frames are joined. */
interface FrameKind {
  group: number | undefined;
  /** What this frame is left showing, by the same rule the fold answers with. */
  absent: boolean;
}

/**
 * What one more command on a frame does to whether that frame shows nothing.
 *
 * THE SAME RULE `hasAnyCoverage` ANSWERS WITH, in log order, because the two
 * have to agree: one decides what the picture shows and this decides what the
 * timeline draws over it, and a track that says a frame is empty while the
 * frame has a selection on it is worse than a track that says nothing.
 *
 * Order matters here and it is the whole of the correction. A frame painted at
 * 12 and then tracked over, with the tracker finding nothing, shows nothing:
 * the tracker's `replace` decides the frame and everything before it is
 * discarded, which is exactly what the fold does. Answered by asking whether
 * ANY command on the frame put something there, the same frame comes out solid,
 * which is this chapter's own claim drawn upside down.
 */
function afterOne(was: boolean, command: SelectionCommand): boolean {
  switch (command.kind) {
    // An erase can only ever remove coverage, so it never turns a frame the
    // model gave up on into one it did not.
    case 'erase':
      return was;
    // Absolute, and a hand edit: the frame is empty because somebody emptied
    // it, which is not the model saying the object is behind something.
    case 'clear':
      return false;
    case 'applyMask':
      // An absent mask decides the frame only when it REPLACES it. Applied any
      // other way it contributes nothing and leaves the answer where it was,
      // which is how a second tracked object going behind something leaves the
      // first one's region standing.
      if (command.absent === true) return command.op === 'replace' ? true : was;
      return false;
    case 'paint':
    case 'invert':
      return false;
    // A rectangle, which is the only kind left. Written as the default so that
    // a seventh command kind fails to compile here rather than falling quietly
    // into the answer for a sixth: `mode` belongs to this one alone.
    default:
      return command.mode === 'paint' ? false : was;
  }
}

/**
 * The log as spans, ascending. What a timeline marks.
 *
 * This used to be `editedFrames`, which returned the frame numbers and nothing
 * else, and it is a projection rather than a formatting decision: the timeline
 * takes numbers, so anything the timeline is not given cannot be drawn however
 * the marks layer is styled.
 *
 * IT ALSO DRAWS FEWER THINGS THAN IT USED TO. One mark per edited frame is one
 * absolutely positioned element per edited frame, and a ten-minute tracked run
 * is eighteen thousand of them on a track six hundred pixels wide. Joined, that
 * run is one element, or a handful where the object went behind something. The
 * measurement is on `/research/the-occlusion.html`.
 *
 * AND IT IS ONE ELEMENT HOWEVER MANY OBJECTS THE RUN FOLLOWED, because a run is
 * one gesture whatever it followed and every command in it carries that
 * gesture's group. What does grow with them is the log this walks, which is why
 * it was taken again at several: it runs on every render of the editor, and
 * three times the commands is 1.27 times the time rather than three, since what
 * it sorts is the frames a log touched and there are still eighteen thousand of
 * those. `/research/per-object.html`.
 *
 * A run's anchor is not part of it, and that is right rather than a rounding
 * error: the tracker writes no command on the frame the selection was made on,
 * so the user's own edit is an `edit` span of its own immediately before the
 * band. Where the run started and where somebody chose are two different facts
 * and the timeline can afford both.
 */
export function editSpans(commands: readonly SelectionCommand[]): readonly EditSpan[] {
  const byFrame = new Map<number, FrameKind>();
  // ONE PASS, IN LOG ORDER, which is the order the fold replays a frame's own
  // commands in: it sorts by frame and the sort is stable, so commands sharing
  // a frame keep the order they were applied in.
  for (const command of commands) {
    const seen = byFrame.get(command.frame);
    if (!seen) {
      byFrame.set(command.frame, { group: command.group, absent: afterOne(false, command) });
      continue;
    }
    // A frame carrying any command from a run belongs to that run. Brushwork
    // applied to a frame during a run does not take it back out of one.
    seen.group ??= command.group;
    seen.absent = afterOne(seen.absent, command);
  }

  const spans: EditSpan[] = [];
  let openGroup: number | undefined;
  for (const frame of [...byFrame.keys()].toSorted((a, b) => a - b)) {
    const at = byFrame.get(frame);
    if (!at) continue;
    const kind = at.group === undefined ? 'edit' : at.absent ? 'absent' : 'tracked';
    const open = spans.at(-1);
    // Joined only along a run, only while it stays the same run, only across
    // consecutive frames and only while the answer stays the same. Two hand
    // edits on neighbouring frames are two edits and are drawn as two.
    if (
      open !== undefined &&
      at.group !== undefined &&
      at.group === openGroup &&
      open.kind === kind &&
      open.to === frame - 1
    ) {
      spans[spans.length - 1] = { from: open.from, to: frame, kind };
      continue;
    }
    spans.push({ from: frame, to: frame, kind });
    openGroup = at.group;
  }
  return spans;
}

export type SelectionCommand = {
  readonly frame: number;
  /**
   * Which gesture produced this, when one gesture produced several commands.
   *
   * Tracking is the only thing that does, and it is why this exists: following
   * an object through three hundred frames contributes three hundred commands,
   * and three hundred presses of undo to take them back is not undo, it is a
   * punishment. Commands sharing a group undo and redo together.
   *
   * Absent on everything else, because everything else is one gesture and one
   * command already, and an optional field that is usually absent is cheaper to
   * read than a group of one on every stroke.
   *
   * Deliberately NOT a nesting structure. A group is a flat run of consecutive
   * commands with the same id, which is all a long-running job produces, and
   * anything richer would be a transaction system built for a case that does
   * not exist.
   */
  readonly group?: number;
} & (
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
      /**
       * The model said the object is not in this frame at all.
       *
       * A tracker with nothing to report answers with an empty mask, which is
       * the reference's own behaviour and is right: an object behind something
       * is not an object that got smaller, and a decoder told there is nothing
       * there still draws something. What that costs is that the empty mask is
       * the same shape as a selection which legitimately covers nothing, so
       * everything downstream of the log had no way to tell a frame the model
       * gave up on from a frame somebody erased. `TrackedMask.present` knew,
       * crossed two files and died at the third.
       *
       * IT IS A PROPERTY OF THE COMMAND AND NOT OF THE RUN, which is the whole
       * decision. A run is a thing that happened once, in a session that ends;
       * the log is the thing that is saved, reloaded, replayed and undone, and
       * the question "why is there no selection on frame 412" is asked of a
       * document rather than of a job. `group` is already a fact about how a
       * command came to be rather than about what it does, so this is the
       * second of those and not the first.
       *
       * PRESENT ONLY WHEN IT IS TRUE. Eighteen thousand commands saying the
       * ordinary thing is eighteen thousand times the width of the word, and
       * absence is the case worth writing down. See `hasAnyCoverage`, which is
       * exact for it rather than approximate, and `editSpans`, which is what
       * lets a timeline draw a run with the occlusion in it.
       */
      readonly absent?: true;
    }
);
