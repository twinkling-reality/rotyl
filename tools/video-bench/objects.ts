// MEASUREMENT 15: which of the figures about a tracked log are per RUN, and
// which were per OBJECT all along.
//
// A run writes one `applyMask` per frame it followed the object to, and until
// multi-object tracking was reachable that sentence had an unstated "the" in
// it: there was exactly one object, so a figure about a run and a figure about
// an object were the same figure. Four of them are quoted in three documents
// and every one is true of one object and silent about N:
//
//   docs/limits.md        3.4 KB a packed mask, 62 MB for ten minutes
//   docs/limits.md        folding eighteen thousand commands is 0.2 ms
//   docs/architecture.md  a replay is a fold to ONE and a texture upload, 0.3 ms
//   docs/video.md         eighteen thousand elements to two
//
// Three of the four move with N and one of them does not, and which is which is
// not guessable from the sentences. So it is measured rather than multiplied.
//
// FOUR THINGS ARE ASKED, AND THEY ARE THE FOUR SENTENCES ABOVE.
//
//   THE FILE, which is the one that really is arithmetic. A document is a JSON
//   object per command with the packed masks in a region behind it, and N
//   objects is N commands per frame, so it is N times the masks and N times the
//   header entries. Measured anyway, because "obviously linear" is how the
//   empty mask came to be written down as three bytes.
//
//   THE FOLD, which is not. `commandsForFrame` filters and sorts the WHOLE log
//   on every frame, so twice the commands is twice the filter and rather more
//   than twice the sort.
//
//   WHAT THE FOLD LEAVES, which is the one that is not a number at all. The cut
//   lands at the last command that decides the frame by itself, and a run
//   writes `replace` for the first object and `add` for the rest. So the cut
//   lands on the FIRST object's command and the frame folds to N rather than to
//   one, and a replay unpacks one mask per object. "A fold to one" is not a
//   figure that moved; it is a sentence that stopped being true.
//
//   THE PROJECTION, which is the one on the render path. `editSpans` runs over
//   the whole log on every render of the editor, so it is the only one of the
//   four where twice the commands is twice something a person can feel. What it
//   DRAWS does not move, because a run is one gesture whatever it followed and
//   every command in it carries the same group, and that is worth a column of
//   its own rather than a claim.
//
// ITS OWN COMMAND AND ITS OWN FILE, which is measurement 14's rule arriving at
// the door it was written for. Every one of the four already has a home: the
// file cost is measurement 12's class, the fold and the replay are measurement
// 8's, and the projection is measurement 14's own. Adding an objects dimension
// to any of them would re-take that measurement and move figures nobody in this
// chapter changed, which is exactly what measurement 14 exists to record having
// cost. A question about a dimension none of them has is a new finding, and a
// new finding gets a file.
//
// AND ITS ONE-OBJECT COLUMN IS TAKEN HERE RATHER THAN QUOTED. Three of these
// four numbers exist in three other results files at one object, and a control
// that sits in another file taken on another day is not a control:
// `tools/style-bench` learned that and re-takes its reference scene inside
// every run. So the ratios below are internally consistent, and the one-object
// cells agreeing with the three files they duplicate is a check rather than a
// coincidence.
//
// Deliberately no GPU and no clips, like the three measurements it sits beside:
// this is a data structure, the product's own writer over it, and the two
// projections the product asks of it.

import {
  commandsForFrame,
  editSpans,
  type SelectionCommand,
} from '../../src/core/document/selection-command.ts';
import { expandCoverage, type CoverageMask } from '../../src/core/document/coverage-mask.ts';
import { DEFAULT_REFINE_SETTINGS } from '../../src/core/mask/refine-params.ts';
import { writeDocument, type RotylDocument } from '../../src/platform/document/document-file.ts';
import { coverage, MASK } from './log.ts';
import { sample, type Stat } from './util.ts';

/** Ten minutes at thirty, which is the size every other figure about a tracked log uses. */
const FRAMES = 18_000;

/** One, two and three. Nobody clicks thirty cars, and the shape of the answer is visible by three. */
const OBJECTS = [1, 2, 3] as const;

/** The media a document names. Not compared here; a digest of the right shape. */
const MEDIA = {
  name: 'city.mp4',
  bytes: 1_243_000_000,
  width: 1920,
  height: 1080,
  frames: FRAMES,
  digest: '0'.repeat(64),
};

function documentOf(commands: readonly SelectionCommand[]): RotylDocument {
  return {
    media: MEDIA,
    commands,
    frame: FRAMES - 1,
    style: { id: 'comic', controls: {} },
  };
}

/**
 * A run following `count` things, as the log holds it.
 *
 * THE SAME SILHOUETTE FOR EVERY OBJECT, which is the rule `coverage`'s own
 * docstring already sets for measurements 8 and 12: two harnesses drawing their
 * own masks would make "62 MB held" and "62 MB written" two numbers about two
 * different logs, and this one has to be comparable with both. A real second
 * object is a different silhouette, and the packing charges for the perimeter
 * rather than for the identity, so what differs between two real objects is the
 * same spread measurement 8's compression sweep already brackets.
 *
 * `replace` for the first and `add` for the rest, which is `runTracking`'s own
 * ordering and is the whole reason the fold answer moves: the cut lands on the
 * first object's command and everything after it survives.
 */
function run(count: number, mask: CoverageMask): SelectionCommand[] {
  const commands: SelectionCommand[] = [
    // The anchor, which a run writes no command for, because the user's own is
    // already there.
    { kind: 'paint', stroke: { points: [{ x: 400, y: 300 }], radius: 64, hardness: 0.7 }, frame: 0 },
  ];
  // One group for the whole run however many objects it followed, which is what
  // `runTracking` writes: a run is one gesture and one undo, and following a
  // second thing does not make it two.
  const group = 1;
  for (let frame = 1; frame < FRAMES; frame++) {
    for (let object = 0; object < count; object++) {
      commands.push({
        kind: 'applyMask',
        mask,
        op: object === 0 ? 'replace' : 'add',
        refine: DEFAULT_REFINE_SETTINGS,
        frame,
        group,
      });
    }
  }
  return commands;
}

const total = (chunks: readonly Uint8Array[]): number => chunks.reduce((sum, chunk) => sum + chunk.length, 0);

export async function objects(): Promise<unknown> {
  const mask = coverage(0.5);
  const into = new Uint8Array(MASK * MASK);
  const out: Record<string, unknown> = {};

  for (const count of OBJECTS) {
    const commands = run(count, mask);

    // THE FILE. Written rather than added up, through the product's own writer.
    let chunks: readonly Uint8Array[] = [];
    const writing = await sample(5, 2, () => {
      chunks = writeDocument(documentOf(commands));
    });
    const bytes = total(chunks);

    // THE FOLD, asked of the LAST frame, which is the worst case and also the
    // common one: playback walks forward, so every frame after the first asks
    // about a prefix that includes everything.
    let folded: readonly SelectionCommand[] = [];
    const fold: Stat = await sample(15, 3, () => {
      folded = commandsForFrame(commands, FRAMES - 1);
    });

    // AND WHAT OPENING A DOCUMENT THEN COSTS, which is the fold plus unpacking
    // every mask the cut left standing. One at one object; one per object after
    // that, and that is the sentence rather than the number.
    let unpacked = 0;
    const replay: Stat = await sample(15, 3, () => {
      const applies = commandsForFrame(commands, FRAMES - 1);
      unpacked = 0;
      for (const command of applies) {
        if (command.kind !== 'applyMask') continue;
        expandCoverage(command.mask, into);
        unpacked++;
      }
    });

    // THE PROJECTION, which is the one that runs on every render of the editor.
    let spans: unknown;
    const projection: Stat = await sample(15, 3, () => {
      spans = editSpans(commands);
    });

    out[`${String(count)} object${count === 1 ? '' : 's'}`] = {
      commands: commands.length,
      file_bytes: bytes,
      file_megabytes: Math.round((bytes / 1e6) * 100) / 100,
      write_ms: writing,
      fold: {
        ms: fold,
        // Held, and reported, so it is obvious the fold was not optimised away
        // and so the number that stopped being one is visible rather than
        // implied.
        folded_to: folded.length,
      },
      replay: { ms: replay, masks_unpacked: unpacked },
      projection: {
        ms: projection,
        // What the timeline draws, which is the column that does NOT move: the
        // user's own command on the anchor frame, and the run itself.
        elements: Array.isArray(spans) ? spans.length : 0,
      },
    };
  }

  return {
    frames: FRAMES,
    a_packed_mask_bytes: mask.packed.length,
    per_objects: out,
  };
}
