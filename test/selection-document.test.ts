import { describe, expect, it, vi } from 'vitest';
import { SelectionDocument } from '../src/core/document/selection-document.ts';
import {
  hasAnyCoverage,
  type BrushStroke,
  type SelectionCommand,
} from '../src/core/document/selection-command.ts';

const stroke: BrushStroke = { points: [{ x: 1, y: 2 }], radius: 10, hardness: 0.8 };
const paint: SelectionCommand = { kind: 'paint', stroke };
const erase: SelectionCommand = { kind: 'erase', stroke };

describe('command log', () => {
  it('applies, undoes and redoes', () => {
    const document = new SelectionDocument();
    expect(document.canUndo).toBe(false);
    expect(document.canRedo).toBe(false);

    document.apply(paint);
    document.apply({ kind: 'invert' });
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
    document.apply({ kind: 'invert' });
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
    expect(hasAnyCoverage([{ kind: 'invert' }])).toBe(true);
    expect(
      hasAnyCoverage([
        {
          kind: 'applyMask',
          op: 'replace',
          mask: { width: 1, height: 1, coverage: new Uint8Array([255]) },
        },
      ]),
    ).toBe(true);
  });

  it('treats clear as absolute, and painting after it as a new selection', () => {
    expect(hasAnyCoverage([paint, { kind: 'clear' }])).toBe(false);
    expect(hasAnyCoverage([paint, { kind: 'clear' }, paint])).toBe(true);
  });
});
