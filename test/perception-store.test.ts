import { describe, expect, it } from 'vitest';
import { SelectionDocument } from '../src/core/document/selection-document.ts';
import type { SelectionCommand } from '../src/core/document/selection-command.ts';
import { PerceptionStore } from '../src/core/perception/perception-store.ts';
import type {
  MaskProposal,
  SceneEmbedding,
  SceneFrame,
  SegmentationEngine,
  SegmentPrompt,
} from '../src/core/perception/segmentation-engine.ts';

/**
 * What the system understands, against what it draws.
 *
 * The engine here is a fake, and deliberately so: none of these properties are
 * about segmentation quality. They are about the seam — that a click becomes
 * exactly one undoable command, that refining a prompt replaces its own command
 * and nobody else's, that an expensive encode is paid once, and that a result
 * the user has already moved past never lands. Every one of those is a bug that
 * a real model would hide rather than reveal.
 */

interface Recorded {
  readonly encodes: SceneFrame[];
  readonly prompts: SegmentPrompt[];
  readonly disposed: number[];
}

function proposal(confidence: number, fill: number): MaskProposal {
  return {
    mask: { width: 4, height: 4, coverage: new Uint8Array(16).fill(fill) },
    confidence,
  };
}

interface FakeOptions {
  /** Delays each decode in turn, so the finishing order can be controlled. */
  readonly decodeDelays?: readonly number[];
  readonly failEncode?: boolean;
}

function fakeEngine(options: FakeOptions = {}): { engine: SegmentationEngine; recorded: Recorded } {
  const recorded: Recorded = { encodes: [], prompts: [], disposed: [] };
  let handles = 0;

  const engine: SegmentationEngine = {
    encode(frame) {
      if (options.failEncode) return Promise.reject(new Error('no model here'));
      recorded.encodes.push(frame);
      const id = handles++;
      const embedding: SceneEmbedding = {
        dispose() {
          recorded.disposed.push(id);
        },
      };
      return Promise.resolve(embedding);
    },
    async decode(_embedding, prompt) {
      const delay = options.decodeDelays?.[recorded.prompts.length];
      recorded.prompts.push({ points: [...prompt.points] });
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
      // Deliberately not in confidence order: the store must not assume one.
      return [proposal(0.9, 255), proposal(0.4, 128), proposal(0.1, 64)];
    },
    dispose() {
      /* nothing to release in a fake */
    },
  };
  return { engine, recorded };
}

/**
 * A frame is only an identity here; nothing in the store dereferences the view.
 *
 * Written out structurally rather than asserted, so that if `SceneFrame` ever
 * grows a field the store actually reads, this stops compiling instead of
 * quietly handing it undefined.
 */
const frame = (label: string, width: number, height: number): SceneFrame => ({
  view: { label, __brand: 'GPUTextureView' },
  size: { width, height },
});

const FRAME = frame('first', 800, 600);
const OTHER_FRAME = frame('second', 400, 400);

function setup(options: FakeOptions = {}): {
  store: PerceptionStore;
  document: SelectionDocument;
  recorded: Recorded;
} {
  const document = new SelectionDocument();
  const { engine, recorded } = fakeEngine(options);
  const store = new PerceptionStore(document, () => Promise.resolve(engine));
  store.setFrame(FRAME);
  return { store, document, recorded };
}

function appliedMasks(document: SelectionDocument): Extract<SelectionCommand, { kind: 'applyMask' }>[] {
  return document.appliedCommands.filter((command) => command.kind === 'applyMask');
}

const STROKE: SelectionCommand = {
  kind: 'paint',
  stroke: { points: [{ x: 10, y: 10 }], radius: 5, hardness: 1 },
};

describe('a click on an object', () => {
  it('becomes exactly one undoable command, and one that adds to the selection', async () => {
    const { store, document } = setup();
    await store.select({ x: 100, y: 120 }, 'object');

    const masks = appliedMasks(document);
    expect(masks.length).toBe(1);
    // Adding rather than replacing: clicking an object must never discard
    // brushwork the user has already done.
    expect(masks[0]?.op).toBe('add');
    // And it asks for refinement, without which the boundary would be the
    // engine's own grid rather than the photograph's.
    expect(masks[0]?.refine).toBeDefined();

    document.undo();
    expect(document.appliedCommands.length).toBe(0);
  });

  it('commits the best answer the engine gave and keeps the rest', async () => {
    const { store, document } = setup();
    await store.select({ x: 100, y: 120 }, 'object');

    expect(store.proposals.length).toBe(3);
    expect(store.proposals[0]?.confidence).toBe(0.9);
    // The alternatives are what the system knows about and is not drawing.
    expect(appliedMasks(document)[0]?.mask.coverage[0]).toBe(255);
  });
});

describe('refining a prompt', () => {
  it('replaces its own command rather than stacking another', async () => {
    const { store, document, recorded } = setup();
    await store.select({ x: 100, y: 120 }, 'object');
    await store.select({ x: 140, y: 130 }, 'include');

    expect(appliedMasks(document).length).toBe(1);
    expect(recorded.prompts[1]?.points.length).toBe(2);
    expect(recorded.prompts[1]?.points.every((point) => point.include)).toBe(true);
  });

  it('carries a negative point rather than removing coverage', async () => {
    const { store, recorded } = setup();
    await store.select({ x: 100, y: 120 }, 'object');
    await store.select({ x: 300, y: 300 }, 'exclude');

    // "Not that" is a statement about the object, answered by the engine —
    // not a subtraction applied to the mask behind its back.
    expect(recorded.prompts[1]?.points[1]?.include).toBe(false);
  });

  it('starts a new object when there is nothing yet to exclude from', async () => {
    const { store, recorded } = setup();
    await store.select({ x: 100, y: 120 }, 'exclude');
    expect(recorded.prompts[0]?.points[0]?.include).toBe(true);
  });

  it('never undoes an edit that is not its own', async () => {
    const { store, document } = setup();
    await store.select({ x: 100, y: 120 }, 'object');
    document.apply(STROKE);
    await store.select({ x: 140, y: 130 }, 'include');

    // The stroke landed between the two clicks, so the refinement has to become
    // a new command. Undoing blindly would silently discard it.
    expect(document.appliedCommands.length).toBe(3);
    expect(document.appliedCommands[1]?.kind).toBe('paint');
  });

  it('starts fresh after the prompt is ended', async () => {
    const { store, document, recorded } = setup();
    await store.select({ x: 100, y: 120 }, 'object');
    store.endPrompt();
    await store.select({ x: 140, y: 130 }, 'include');

    expect(recorded.prompts[1]?.points.length).toBe(1);
    expect(appliedMasks(document).length).toBe(2);
  });
});

describe('the expensive half', () => {
  it('is paid once per frame, however many times it is asked', async () => {
    const { store, recorded } = setup();
    await store.select({ x: 10, y: 10 }, 'object');
    await store.select({ x: 20, y: 20 }, 'object');
    await store.select({ x: 30, y: 30 }, 'include');

    expect(recorded.encodes.length).toBe(1);
    expect(recorded.prompts.length).toBe(3);
  });

  it('is paid again, and released, when the frame changes', async () => {
    const { store, recorded } = setup();
    await store.select({ x: 10, y: 10 }, 'object');
    store.setFrame(OTHER_FRAME);
    await store.select({ x: 10, y: 10 }, 'object');

    expect(recorded.encodes.length).toBe(2);
    // Tens of megabytes per frame; leaving them to the collector is not a plan.
    expect(recorded.disposed).toEqual([0]);
  });

  it('reports what it is doing so a long wait is not a dead interface', async () => {
    const { store } = setup();
    expect(store.status.kind).toBe('idle');
    const pending = store.select({ x: 10, y: 10 }, 'object');
    expect(['loading', 'understanding', 'thinking']).toContain(store.status.kind);
    await pending;
    expect(store.status.kind).toBe('ready');
  });

  it('says so when the model cannot be had, rather than failing silently', async () => {
    const { store, document } = setup({ failEncode: true });
    await store.select({ x: 10, y: 10 }, 'object');

    expect(store.status.kind).toBe('failed');
    expect(document.appliedCommands.length).toBe(0);
  });
});

describe('a result the user has moved past', () => {
  it('never lands, even when it arrives last', async () => {
    // The first decode is made to finish after the second, which is the case
    // that actually happens: the click the user gave up waiting for is the slow
    // one, and it would otherwise overwrite the answer they went on to get.
    const { store, document, recorded } = setup({ decodeDelays: [20, 0] });

    const first = store.select({ x: 10, y: 10 }, 'object');
    // Long enough for the first click to be inside its decode rather than still
    // queued behind the encode.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = store.select({ x: 90, y: 90 }, 'object');
    await Promise.all([first, second]);

    expect(recorded.prompts.length).toBe(2);
    expect(appliedMasks(document).length).toBe(1);
    // The surviving command is the one the second click asked for.
    expect(store.promptPoints[0]?.x).toBe(90);
  });

  it('does not pay for the frame twice when clicks overlap', async () => {
    // Two clicks before the first encode returns. The second must wait on the
    // encode already running rather than starting a second one.
    const { store, recorded } = setup();
    await Promise.all([store.select({ x: 10, y: 10 }, 'object'), store.select({ x: 90, y: 90 }, 'object')]);

    expect(recorded.encodes.length).toBe(1);
    expect(recorded.disposed.length).toBe(0);
  });
});
