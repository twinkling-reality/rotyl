import { describe, expect, it } from 'vitest';
import { isWholeClip, movedEnd } from '../src/app/range.ts';

/**
 * What In and Out do, which is two decisions and not one.
 *
 * Both of them could reasonably have gone the other way, and both are the kind
 * of thing that is right when it is written and quietly wrong after somebody
 * tidies it. Neither needs a browser: they are arithmetic over two numbers, and
 * the only reason they were ever inside a component is that a component is
 * where the button lives.
 */

const LAST = 299;

describe('marking the part of a clip to export', () => {
  it('starts a range at the playhead and runs it to the end', () => {
    expect(movedEnd(undefined, 'from', 60, LAST)).toEqual({ from: 60, to: LAST });
  });

  it('ends a range at the playhead and runs it from the start', () => {
    expect(movedEnd(undefined, 'to', 120, LAST)).toEqual({ from: 0, to: 120 });
  });

  it('moves one end and leaves the other where it was', () => {
    const range = { from: 40, to: 200 };
    expect(movedEnd(range, 'from', 60, LAST)).toEqual({ from: 60, to: 200 });
    expect(movedEnd(range, 'to', 150, LAST)).toEqual({ from: 40, to: 150 });
  });

  it('sends the other end to the clip’s edge rather than refusing a crossed pair', () => {
    // Marking a start past the current end is somebody re-marking the part they
    // want. Refusing would look broken and swapping the two would move a
    // boundary they did not touch, so the untouched end goes back to the edge
    // and the frame they just marked is inside the range either way.
    expect(movedEnd({ from: 40, to: 80 }, 'from', 200, LAST)).toEqual({ from: 200, to: LAST });
    expect(movedEnd({ from: 200, to: 260 }, 'to', 30, LAST)).toEqual({ from: 0, to: 30 });
  });

  it('allows a range of one frame, where the two ends meet', () => {
    expect(movedEnd({ from: 50, to: 50 }, 'to', 50, LAST)).toEqual({ from: 50, to: 50 });
  });

  it('reads a range that covers everything as no range at all', () => {
    // Which is what makes the timeline carry no marks for a clip nobody has
    // said anything about, including one somebody has just un-said.
    expect(isWholeClip({ from: 0, to: LAST }, LAST)).toBe(true);
    expect(isWholeClip({ from: 0, to: 298 }, LAST)).toBe(false);
    expect(isWholeClip({ from: 1, to: LAST }, LAST)).toBe(false);
  });

  it('survives a one-frame clip, where every range is the whole of it', () => {
    expect(movedEnd(undefined, 'from', 0, 0)).toEqual({ from: 0, to: 0 });
    expect(isWholeClip({ from: 0, to: 0 }, 0)).toBe(true);
  });
});
