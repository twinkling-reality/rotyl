import { describe, expect, it, vi } from 'vitest';
import { SelectionDocument } from '../src/core/document/selection-document.ts';
import {
  commandsForFrame,
  editedFrames,
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
          mask: { width: 1, height: 1, coverage: new Uint8Array([255]) },
        },
      ]),
    ).toBe(true);
  });

  it('treats clear as absolute, and painting after it as a new selection', () => {
    expect(hasAnyCoverage([paint, { kind: 'clear', frame: 0 }])).toBe(false);
    expect(hasAnyCoverage([paint, { kind: 'clear', frame: 0 }, paint])).toBe(true);
  });
});

/**
 * The frame index, from the log's side.
 *
 * One list and one cursor, even across frames. What makes that liveable is that
 * undo says which command it moved past, so a host can follow it there; a test
 * for the returned value is a test for the whole undo model.
 */
describe('a log spanning frames', () => {
  const at = (frame: number): SelectionCommand => ({ kind: 'paint', stroke, frame });

  it('folds only the commands made on the frame asked for', () => {
    const commands = [at(0), at(5), at(5), at(9)];
    expect(commandsForFrame(commands, 5).length).toBe(2);
    expect(commandsForFrame(commands, 9).length).toBe(1);
    // A frame nobody has edited has nothing selected, and says so.
    expect(commandsForFrame(commands, 7).length).toBe(0);
  });

  it('reports which frames carry an edit, in order and without repeats', () => {
    expect(editedFrames([at(9), at(0), at(5), at(5)])).toEqual([0, 5, 9]);
    expect(editedFrames([])).toEqual([]);
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
