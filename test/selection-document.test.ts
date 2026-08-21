import { describe, expect, it, vi } from 'vitest';
import { SelectionDocument } from '../src/core/document/selection-document.ts';
import { packCoverage } from '../src/core/document/coverage-mask.ts';
import {
  commandsForFrame,
  editSpans,
  hasAnyCoverage,
  type BrushStroke,
  type SelectionCommand,
} from '../src/core/document/selection-command.ts';

const stroke: BrushStroke = { points: [{ x: 1, y: 2 }], radius: 10, hardness: 0.8 };
const paint: SelectionCommand = { kind: 'paint', stroke, frame: 0 };
const erase: SelectionCommand = { kind: 'erase', stroke, frame: 0 };

describe('command log', () => {
  it('applies, undoes and redoes', () => {
    const document = new SelectionDocument();
    expect(document.canUndo).toBe(false);
    expect(document.canRedo).toBe(false);

    document.apply(paint);
    document.apply({ kind: 'invert', frame: 0 });
    expect(document.appliedCommands).toHaveLength(2);

    document.undo();
    expect(document.appliedCommands).toEqual([paint]);
    expect(document.canRedo).toBe(true);

    document.redo();
    expect(document.appliedCommands).toHaveLength(2);
    expect(document.canRedo).toBe(false);
  });

  it('discards the redo tail when a new edit lands after an undo', () => {
    const document = new SelectionDocument();
    document.apply(paint);
    document.apply({ kind: 'invert', frame: 0 });
    document.undo();
    document.apply(erase);

    expect(document.appliedCommands).toEqual([paint, erase]);
    expect(document.canRedo).toBe(false);
  });

  it('ignores undo and redo at the ends of history', () => {
    const document = new SelectionDocument();
    document.undo();
    document.redo();
    expect(document.appliedCommands).toEqual([]);
  });

  it('notifies subscribers and bumps the revision on every change', () => {
    const document = new SelectionDocument();
    const listener = vi.fn();
    const unsubscribe = document.subscribe(listener);

    const start = document.revision;
    document.apply(paint);
    document.undo();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(document.revision).toBe(start + 2);

    unsubscribe();
    document.apply(erase);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('returns a snapshot that later edits cannot mutate', () => {
    const document = new SelectionDocument();
    document.apply(paint);
    const snapshot = document.appliedCommands;
    document.apply(erase);
    expect(snapshot).toHaveLength(1);
  });
});

describe('coverage detection', () => {
  it('reports nothing selected for an empty or erase-only log', () => {
    expect(hasAnyCoverage([])).toBe(false);
    expect(hasAnyCoverage([erase, erase])).toBe(false);
  });

  it('reports a selection after painting, inverting, or applying a mask', () => {
    expect(hasAnyCoverage([paint])).toBe(true);
    expect(hasAnyCoverage([{ kind: 'invert', frame: 0 }])).toBe(true);
    expect(
      hasAnyCoverage([
        {
          kind: 'applyMask',
          frame: 0,
          op: 'replace',
          mask: packCoverage(1, 1, new Uint8Array([255])),
        },
      ]),
    ).toBe(true);
  });

  it('treats clear as absolute, and painting after it as a new selection', () => {
    expect(hasAnyCoverage([paint, { kind: 'clear', frame: 0 }])).toBe(false);
    expect(hasAnyCoverage([paint, { kind: 'clear', frame: 0 }, paint])).toBe(true);
  });

  it('is exact about a mask the model said the object was not in', () => {
    // The one case that used to be approximate and is not. An empty mask
    // applied with `replace` decides the frame, and what it decides is that
    // there is nothing on it: the overlay lifting everything toward paper there
    // would be claiming a selection the frame does not have.
    expect(hasAnyCoverage([paint, absent('replace')])).toBe(false);
    // Applied any other way it contributes nothing, so the scan carries on past
    // it to whatever was underneath. A second tracked object writes `add`, and
    // its going behind something must not blank the first one's region.
    expect(hasAnyCoverage([paint, absent('add')])).toBe(true);
    expect(hasAnyCoverage([absent('add')])).toBe(false);
    // And a stroke made afterwards is a selection whatever the model thought.
    expect(hasAnyCoverage([absent('replace'), paint])).toBe(true);
  });
});

/** A frame the model said the object is not in, which is what a tracker writes. */
const absent = (op: 'replace' | 'add', frame = 0, group?: number): SelectionCommand => ({
  kind: 'applyMask',
  mask: packCoverage(1, 1, new Uint8Array([0])),
  op,
  absent: true,
  frame,
  ...(group === undefined ? {} : { group }),
});

/**
 * The frame index, from the log's side.
 *
 * One list and one cursor, even across frames. What makes that liveable is that
 * undo says which command it moved past, so a host can follow it there; a test
 * for the returned value is a test for the whole undo model.
 */
const replace = (frame: number): SelectionCommand => ({
  kind: 'applyMask',
  mask: packCoverage(1, 1, new Uint8Array([255])),
  op: 'replace',
  frame,
});

describe('a log spanning frames', () => {
  const at = (frame: number): SelectionCommand => ({ kind: 'paint', stroke, frame });

  it('holds an edit from its frame onward', () => {
    const commands = [at(0), at(5), at(5), at(9)];
    expect(commandsForFrame(commands, 0).length).toBe(1);
    expect(commandsForFrame(commands, 5).length).toBe(3);
    // A frame between two edits carries whatever the last one said.
    expect(commandsForFrame(commands, 7).length).toBe(3);
    expect(commandsForFrame(commands, 9).length).toBe(4);
    // Nothing is in effect before the first edit.
    expect(commandsForFrame([at(4)], 2).length).toBe(0);
  });

  it('folds in frame order, whatever order the edits were made in', () => {
    // Painted at 100, then scrubbed back to clear 20. The clear means "from
    // frame 20", so at frame 100 it happens BEFORE the paint and not after it.
    const commands: SelectionCommand[] = [at(100), { kind: 'clear', frame: 20 }];
    expect(commandsForFrame(commands, 100).map((command) => command.frame)).toEqual([20, 100]);
    expect(hasAnyCoverage(commandsForFrame(commands, 100))).toBe(true);
    expect(hasAnyCoverage(commandsForFrame(commands, 50))).toBe(false);
  });

  it('cuts the fold at the last command that decides the frame by itself', () => {
    // A replace discards everything before it, so replaying what it discarded
    // is a texture upload and a refinement for a result nobody sees. On a
    // tracked clip that is one command per frame followed rather than one.
    expect(commandsForFrame([at(0), replace(1), at(2), replace(3), at(4)], 9)).toHaveLength(2);
    // An `add` decides nothing on its own, so what came before it stays.
    const add: SelectionCommand = {
      kind: 'applyMask',
      mask: packCoverage(1, 1, new Uint8Array([255])),
      op: 'add',
      frame: 3,
    };
    expect(commandsForFrame([at(0), replace(1), at(2), add, at(4)], 9)).toHaveLength(4);
    // A clear is absolute in the same way, and is kept rather than skipped
    // past, because what follows it may only add to what it left.
    expect(commandsForFrame([at(0), { kind: 'clear', frame: 1 }, at(2)], 9)).toHaveLength(2);
  });

  it('reports which frames carry an edit, in order and without repeats', () => {
    expect(editSpans([at(9), at(0), at(5), at(5)])).toEqual([
      { from: 0, to: 0, kind: 'edit' },
      { from: 5, to: 5, kind: 'edit' },
      { from: 9, to: 9, kind: 'edit' },
    ]);
    expect(editSpans([])).toEqual([]);
  });

  it('draws a run as one stretch rather than as one edit per frame', () => {
    // What `group` has recorded since tracking landed and what the projection
    // feeding the timeline used to discard. The anchor is the user's own
    // command and stays its own mark: where the run started and where somebody
    // chose are two different facts.
    const tracked = (frame: number): SelectionCommand => ({ ...replace(frame), group: 7 });
    expect(editSpans([at(4), tracked(5), tracked(6), tracked(7)])).toEqual([
      { from: 4, to: 4, kind: 'edit' },
      { from: 5, to: 7, kind: 'tracked' },
    ]);

    // Two runs are two stretches even where they touch, because they are two
    // gestures and one undo each.
    const second = (frame: number): SelectionCommand => ({ ...replace(frame), group: 8 });
    expect(editSpans([tracked(1), tracked(2), second(3), second(4)])).toEqual([
      { from: 1, to: 2, kind: 'tracked' },
      { from: 3, to: 4, kind: 'tracked' },
    ]);

    // And a gap in the frames breaks it, so a run that skipped frames is not
    // drawn as covering them.
    expect(editSpans([tracked(1), tracked(2), tracked(9)])).toEqual([
      { from: 1, to: 2, kind: 'tracked' },
      { from: 9, to: 9, kind: 'tracked' },
    ]);
  });

  it('breaks a run where the model said the object was not there', () => {
    const tracked = (frame: number): SelectionCommand => ({ ...replace(frame), group: 3 });
    expect(
      editSpans([tracked(10), tracked(11), absent('replace', 12, 3), absent('replace', 13, 3), tracked(14)]),
    ).toEqual([
      { from: 10, to: 11, kind: 'tracked' },
      { from: 12, to: 13, kind: 'absent' },
      { from: 14, to: 14, kind: 'tracked' },
    ]);
  });

  it('answers a frame the same way the fold does, in the same order', () => {
    // ORDER MATTERS, and it is the whole of what makes this agree with the
    // picture. A frame the tracker gave up on and the user then brushed has a
    // selection on it, whatever the model thought.
    expect(editSpans([absent('replace', 12, 3), { ...at(12), group: 3 }])).toEqual([
      { from: 12, to: 12, kind: 'tracked' },
    ]);
    // And the other way round it does not. Someone who painted at 12 and then
    // tracked over it sees nothing on that frame, because the tracker's replace
    // is what decides it and everything before one of those is discarded. A
    // timeline that drew it solid would be claiming a selection the frame does
    // not have, which is this chapter's own point upside down.
    expect(editSpans([{ ...at(12), group: 3 }, absent('replace', 12, 3)])).toEqual([
      { from: 12, to: 12, kind: 'absent' },
    ]);
    // The same test the fold passes, on the same commands.
    const both: SelectionCommand[] = [{ ...at(12), group: 3 }, absent('replace', 12, 3)];
    expect(hasAnyCoverage(commandsForFrame(both, 12))).toBe(false);

    // A clear empties the frame too and is not an absence: somebody emptied it.
    expect(editSpans([absent('replace', 4, 3), { kind: 'clear', frame: 4, group: 3 }])).toEqual([
      { from: 4, to: 4, kind: 'tracked' },
    ]);
    // An erase leaves the answer where it was, because it can only remove.
    expect(editSpans([absent('replace', 4, 3), { ...erase, frame: 4, group: 3 }])).toEqual([
      { from: 4, to: 4, kind: 'absent' },
    ]);
  });

  it('keeps two hand edits on neighbouring frames as two marks', () => {
    // The join is along a run and only along a run. Without that guard two
    // strokes a frame apart would fuse into a bar claiming a gesture nobody
    // made, and every other case in this file has a gap in it.
    expect(editSpans([at(4), at(5)])).toEqual([
      { from: 4, to: 4, kind: 'edit' },
      { from: 5, to: 5, kind: 'edit' },
    ]);
  });

  it('answers coverage per frame, not for the log', () => {
    const commands = [at(3), { kind: 'clear', frame: 3 } as SelectionCommand, at(8)];
    expect(hasAnyCoverage(commandsForFrame(commands, 3))).toBe(false);
    expect(hasAnyCoverage(commandsForFrame(commands, 8))).toBe(true);
    expect(hasAnyCoverage(commandsForFrame(commands, 1))).toBe(false);
  });

  it('says which command undo and redo moved past', () => {
    const document = new SelectionDocument();
    document.apply(at(2));
    document.apply(at(40));

    // The last thing done, which is not on the frame most likely being shown.
    expect(document.undo()?.frame).toBe(40);
    expect(document.undo()?.frame).toBe(2);
    expect(document.undo()).toBeUndefined();

    expect(document.redo()?.frame).toBe(2);
    expect(document.redo()?.frame).toBe(40);
    expect(document.redo()).toBeUndefined();
  });
});
