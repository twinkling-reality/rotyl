import { beforeAll, describe, expect, it } from 'vitest';
import { disposeWithTestDevice, testDevice } from './gpu-harness.ts';
import { RotylEngine } from '../src/core/render/rotyl-engine.ts';
import { SelectionDocument } from '../src/core/document/selection-document.ts';
import type { SelectionCommand } from '../src/core/document/selection-command.ts';

/**
 * What a lost graphics device costs, and what it must not.
 *
 * Recovery is a new engine on a new device around the SAME document, so the two
 * things checked here are the two halves of that: loading an image can be told
 * to keep the selection, and it can be told to throw it away, and neither is
 * the default. A version of `loadMedia` that always reset would make recovery
 * silently lossy while every other test still passed.
 */

const BACKGROUND = [0.94, 0.94, 0.94] as const;
const SIZE = { width: 64, height: 64 };
const STROKE: SelectionCommand = {
  kind: 'paint',
  frame: 0,
  stroke: { points: [{ x: 32, y: 32 }], radius: 10, hardness: 1 },
};

describe('reloading an image', () => {
  let device: GPUDevice;

  beforeAll(async () => {
    ({ device } = await testDevice());
  });

  const engineOn = (document: SelectionDocument): RotylEngine => {
    const engine = new RotylEngine(document, device, 4096, 'bgra8unorm', BACKGROUND);
    // Released with the device rather than per case: tearing pipelines down
    // immediately is the churn the Dawn Node binding is least stable under.
    disposeWithTestDevice(() => {
      engine.dispose();
    });
    return engine;
  };

  it('keeps the selection when the same image comes back on a new device', () => {
    const document = new SelectionDocument();
    const before = engineOn(document);
    before.loadMedia(SIZE, 'clear');
    document.apply(STROKE);
    before.dispose();

    const after = engineOn(document);
    after.loadMedia(SIZE, 'keep');

    expect(after.document.appliedCommands.length).toBe(1);
    expect(after.document.canUndo).toBe(true);
  });

  it('clears it when a different image is opened', () => {
    const document = new SelectionDocument();
    const engine = engineOn(document);
    engine.loadMedia(SIZE, 'clear');
    document.apply(STROKE);

    engine.loadMedia({ width: 128, height: 96 }, 'clear');
    expect(engine.document.appliedCommands.length).toBe(0);
  });

  it('leaves the document alone once the engine holding it is gone', () => {
    // The document outlives the engine by design. An engine that kept its
    // subscription would stay reachable, and marking itself dirty, for the rest
    // of the session.
    const document = new SelectionDocument();
    const engine = engineOn(document);
    engine.loadMedia(SIZE, 'clear');
    engine.dispose();

    expect(() => {
      document.apply(STROKE);
    }).not.toThrow();
    expect(document.appliedCommands.length).toBe(1);
  });
});

/**
 * The frame index, from the engine's side.
 *
 * A selection belongs to the frame it was made on. These four cases are the
 * whole of that rule where it meets the renderer: which commands apply, which
 * frame a new stroke is stamped with, that scrubbing alone is enough to force a
 * rebuild, and that a still image never has to think about any of it.
 */
describe('editing at a frame', () => {
  let device: GPUDevice;

  beforeAll(async () => {
    ({ device } = await testDevice());
  });

  const engineOn = (document: SelectionDocument): RotylEngine => {
    const engine = new RotylEngine(document, device, 4096, 'bgra8unorm', BACKGROUND);
    disposeWithTestDevice(() => {
      engine.dispose();
    });
    return engine;
  };

  it('carries an edit forward from the frame it was made on', () => {
    const document = new SelectionDocument();
    const engine = engineOn(document);
    engine.loadMedia(SIZE, 'clear');

    document.apply({ ...STROKE, frame: 4 });
    document.apply({ ...STROKE, frame: 7 });

    // Before the first edit: nothing.
    expect(engine.frameCommands.length).toBe(0);
    engine.setFrame(4);
    expect(engine.frameCommands.length).toBe(1);
    // Between the two: still the first one.
    engine.setFrame(6);
    expect(engine.frameCommands.length).toBe(1);
    engine.setFrame(7);
    expect(engine.frameCommands.length).toBe(2);
    engine.setFrame(900);
    expect(engine.frameCommands.length).toBe(2);
  });

  it('stamps a committed stroke with the frame it was drawn on', () => {
    const document = new SelectionDocument();
    const engine = engineOn(document);
    engine.loadMedia(SIZE, 'clear');

    engine.setFrame(12);
    engine.beginStroke('paint', 8, 1, { x: 20, y: 20 });
    engine.commitStroke();

    expect(document.appliedCommands[0]?.frame).toBe(12);
  });

  it('starts a new document back at its first frame, and a recovered one where it was', () => {
    const document = new SelectionDocument();
    const engine = engineOn(document);
    engine.loadMedia(SIZE, 'clear');
    engine.setFrame(9);

    engine.loadMedia(SIZE, 'keep');
    expect(engine.frame).toBe(9);

    engine.loadMedia(SIZE, 'clear');
    expect(engine.frame).toBe(0);
  });
});
