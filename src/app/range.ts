import type { FrameRange } from '../platform/export/export-source.ts';

/**
 * What In and Out mean, as arithmetic rather than as an event handler.
 *
 * Two rules, both of them decisions somebody could reasonably have made the
 * other way, and neither of them worth burying in a component where the only
 * way to check one is to drive a browser. What a range IS lives next to the
 * export in `FrameRange`, because that is what consumes it; what MOVING one
 * means lives here, because that is an interaction and interactions belong to
 * the interface.
 */

/**
 * The range after moving one of its ends to `frame`.
 *
 * FORGIVING RATHER THAN REFUSING. Setting a start past the current end, or an
 * end before the current start, is somebody re-marking the part they want
 * rather than a mistake to be rejected: the other end goes back to the clip's
 * own edge, which is the reading that leaves the frame they just marked inside
 * the range. A control that silently did nothing there would look broken, and
 * one that swapped the two ends would move a boundary they had not touched.
 */
export function movedEnd(
  range: FrameRange | undefined,
  which: 'from' | 'to',
  frame: number,
  last: number,
): FrameRange {
  const from = range?.from ?? 0;
  const to = range?.to ?? last;
  if (which === 'from') return { from: frame, to: frame > to ? last : to };
  return { from: frame < from ? 0 : from, to: frame };
}

/**
 * Whether a range covers the whole clip, which is not a range.
 *
 * Marked out to both edges, what somebody has said is "all of it", and all of
 * it is what an export does with no range at all. So it becomes none, and the
 * timeline goes back to carrying no marks: a clip nobody has said anything
 * about must not look like one they have.
 */
export const isWholeClip = (range: FrameRange, last: number): boolean => range.from <= 0 && range.to >= last;
