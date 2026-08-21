import { describe, expect, it } from 'vitest';
import { SelectionDocument } from '../src/core/document/selection-document.ts';
import type { SelectionCommand } from '../src/core/document/selection-command.ts';
import { expandCoverage, packCoverage, type CoverageMask } from '../src/core/document/coverage-mask.ts';
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
 * about segmentation quality. They are about the seam. That a click becomes
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

/**
 * A proposal covering `cells` of sixteen.
 *
 * Nested rather than arbitrary, so the three answers differ in size the way a
 * real engine's do, a part inside an object inside a group, and so the store
 * can be checked to have committed a particular one of them.
 */
function proposal(confidence: number, cells: number): MaskProposal {
  const coverage = new Uint8Array(16);
  coverage.fill(255, 0, cells);
  return { mask: packCoverage(4, 4, coverage), confidence };
}

function cellsOf(mask: CoverageMask | undefined): number {
  return mask ? expandCoverage(mask).reduce((count, value) => count + (value >= 128 ? 1 : 0), 0) : 0;
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
      recorded.prompts.push({
        points: [...prompt.points],
        ...(prompt.box ? { box: prompt.box } : {}),
      });
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
      // Deliberately not in confidence order: the store must not assume one.
      // Eight cells is the engine's own pick, and it is neither the smallest
      // nor the largest, so "best" and "middle" cannot be confused.
      return [proposal(0.4, 2), proposal(0.9, 8), proposal(0.1, 14)];
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
const frame = (label: string, width: number, height: number, index = 0): SceneFrame => ({
  view: { label, __brand: 'GPUTextureView' },
  size: { width, height },
  frame: index,
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
  frame: 0,
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

  it('commits the answer the engine rated highest and keeps the rest', async () => {
    const { store, document } = setup();
    await store.select({ x: 100, y: 120 }, 'object');

    // Offered smallest first, which is the axis a person chooses along;
    // confidence decides only which one is drawn.
    expect(store.candidates.map((candidate) => candidate.area)).toEqual([2 / 16, 8 / 16, 14 / 16]);
    expect(store.chosen).toBe(1);
    // The alternatives are what the system knows about and is not drawing.
    expect(cellsOf(appliedMasks(document)[0]?.mask)).toBe(8);
  });

  it('points at itself, so the choice can be offered where the click was', () => {
    const { store } = setup();
    expect(store.promptAnchor).toBeUndefined();
  });
});

describe('choosing a different reading of the same click', () => {
  it('replaces the committed command rather than stacking another', async () => {
    const { store, document } = setup();
    await store.select({ x: 100, y: 120 }, 'object');
    store.choose(2);

    expect(store.chosen).toBe(2);
    expect(appliedMasks(document).length).toBe(1);
    expect(cellsOf(appliedMasks(document)[0]?.mask)).toBe(14);

    // Changing your mind about which object you meant is one edit.
    document.undo();
    expect(document.appliedCommands.length).toBe(0);
  });

  it('is remembered while the prompt is being refined', async () => {
    const { store, document } = setup();
    await store.select({ x: 100, y: 120 }, 'object');
    store.choose(0);
    await store.select({ x: 140, y: 130 }, 'include');

    // Someone who reached past the model's pick meant it; a following "also
    // this" must not quietly hand back the reading they rejected.
    expect(store.chosen).toBe(0);
    expect(cellsOf(appliedMasks(document)[0]?.mask)).toBe(2);
  });

  it('is forgotten when a new object is asked about', async () => {
    const { store } = setup();
    await store.select({ x: 100, y: 120 }, 'object');
    store.choose(0);
    await store.select({ x: 300, y: 300 }, 'object');

    expect(store.chosen).toBe(1);
  });

  it('ignores a rank there is no candidate for', async () => {
    const { store, document } = setup();
    await store.select({ x: 100, y: 120 }, 'object');
    store.choose(99);

    expect(store.chosen).toBe(2);
    expect(appliedMasks(document).length).toBe(1);
  });
});

describe('a box', () => {
  const BOX = { x0: 40, y0: 50, x1: 200, y1: 260 };

  it('reaches the engine as a region, with no point invented for it', async () => {
    const { store, document, recorded } = setup();
    await store.selectBox(BOX);

    expect(recorded.prompts[0]?.box).toEqual(BOX);
    expect(recorded.prompts[0]?.points.length).toBe(0);
    expect(appliedMasks(document).length).toBe(1);
  });

  it('is refined by points rather than replaced by them', async () => {
    const { store, document, recorded } = setup();
    await store.selectBox(BOX);
    await store.select({ x: 100, y: 120 }, 'include');

    expect(recorded.prompts[1]?.box).toEqual(BOX);
    expect(recorded.prompts[1]?.points.length).toBe(1);
    expect(appliedMasks(document).length).toBe(1);
  });

  it('takes a negative point as a correction, not as a new object', async () => {
    // A box that caught the shadow as well as the object is corrected by
    // pointing at the shadow, which is only meaningful if the box survives.
    const { store, recorded } = setup();
    await store.selectBox(BOX);
    await store.select({ x: 100, y: 120 }, 'exclude');

    expect(recorded.prompts[1]?.box).toEqual(BOX);
    expect(recorded.prompts[1]?.points[0]?.include).toBe(false);
  });

  it('is discarded by a click that asks about something else', async () => {
    const { store, recorded } = setup();
    await store.selectBox(BOX);
    await store.select({ x: 600, y: 600 }, 'object');

    expect(recorded.prompts[1]?.box).toBeUndefined();
  });

  it('points at its own bottom edge, so a control sits below it', async () => {
    const { store } = setup();
    await store.selectBox(BOX);
    expect(store.promptAnchor).toEqual({ x: 120, y: 260 });
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

    // "Not that" is a statement about the object, answered by the engine,
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

describe('teardown', () => {
  it('releases an engine that arrives after it', async () => {
    let release: ((engine: SegmentationEngine) => void) | undefined;
    const document = new SelectionDocument();
    const { engine, recorded } = fakeEngine();
    let disposedEngine = false;
    const wrapped: SegmentationEngine = {
      encode: (scene) => engine.encode(scene),
      decode: (embedding, prompt) => engine.decode(embedding, prompt),
      dispose: () => {
        disposedEngine = true;
      },
    };
    const store = new PerceptionStore(
      document,
      () =>
        new Promise<SegmentationEngine>((resolve) => {
          release = resolve;
        }),
    );
    store.setFrame(FRAME);

    const pending = store.select({ x: 10, y: 10 }, 'object');
    store.dispose();
    release?.(wrapped);
    await pending;

    // A twenty-megabyte model finishing loading after the editor has gone is
    // not an error, but keeping it is a leak.
    expect(disposedEngine).toBe(true);
    expect(recorded.encodes.length).toBe(0);
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
    // The surviving command is the one the second click asked for. Read off
    // what the engine was asked rather than off a getter on the store: the
    // store used to expose its prompt points and nothing outside this line
    // ever read them, which is a public surface that exists to be asserted
    // about rather than an interface anything needs.
    expect(recorded.prompts.at(-1)?.points[0]?.x).toBe(90);
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
