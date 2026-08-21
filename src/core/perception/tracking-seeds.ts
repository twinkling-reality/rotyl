import { expandCoverage, packCoverage, type CoverageMask } from '../document/coverage-mask.ts';
import type { SelectionCommand } from '../document/selection-command.ts';

/**
 * How many things a selection is made of, and which pixels belong to each.
 *
 * `runTracking` has taken a LIST of seeds since the day it landed, advances N
 * tracks against one embedding per frame, and writes `replace` for the first
 * and `add` for the rest. None of it was reachable, because the interface
 * passed exactly one seed, and the reason it passed one is that the product has
 * one selection and no concept of a set of them.
 *
 * IT DOES NOT NEED ONE. The log has recorded which objects somebody pointed at
 * since object selection landed, and nobody noticed. `SelectIntent` has three
 * values and the first is `object`, documented as "a different thing; starts a
 * fresh prompt". A fresh prompt clears `PerceptionStore`'s committed revision,
 * so the answer to it is a NEW `applyMask` command rather than a replacement of
 * the last one, while shift-click and alt-click refine the prompt in place and
 * replace it. So clicking two cars leaves two commands and clicking one car
 * twice leaves one, which is exactly the distinction a tracker needs and
 * exactly the one the interface already draws.
 *
 * So multi-object tracking needs no gesture, no mode, no list to manage and no
 * ninth button. It needs the selection read as the several answers it is
 * already made of.
 *
 * WHAT IS NOT A MODEL ANSWER BELONGS TO THE FIRST OBJECT. A brush stroke and a
 * dragged rectangle are regions somebody drew rather than things a model was
 * asked about, so nothing in the log says whether two brushed blobs are two
 * objects or one. Giving them their own track would be inventing an object
 * nobody named; giving them to the first is what happens today, because today
 * there is exactly one seed and everything is in it. The rule is therefore the
 * one that leaves a single-object selection byte for byte the seed it already
 * was: coverage no answer claims goes to the first, and a selection with no
 * answers in it at all is one seed of the whole thing.
 */

/** Where a coverage byte counts as inside, which is `mask-candidates`' own. */
const SOLID = 128;

/**
 * The model answers a frame's selection is made of, oldest first.
 *
 * Fed the output of `commandsForFrame`, so the fold's cut has already thrown
 * away everything a later `replace` or `clear` decided. A command the model
 * answered with "the object is not in this frame" is not one of these: its mask
 * is empty by construction, so there is nothing to seed a track from, and a run
 * started on a frame one object is hidden on genuinely cannot follow that one.
 */
function answersIn(commands: readonly SelectionCommand[]): readonly CoverageMask[] {
  const masks: CoverageMask[] = [];
  for (const command of commands) {
    if (command.kind === 'applyMask' && command.absent !== true) masks.push(command.mask);
  }
  return masks;
}

/**
 * How many objects a run started here would follow.
 *
 * FROM THE LOG AND NOT FROM THE GPU, which is what lets the Track button say it
 * before anything is pressed. It is the same source `hasAnyCoverage` answers
 * from and it inherits the same known inexactness: a click whose whole region
 * was later erased away still counts here, because answering exactly would mean
 * reading the mask back on the render path. `seedsFrom` sees the coverage and
 * drops such an object, so a run can follow one fewer than this said.
 *
 * One, not zero, for a selection with no model answers in it: a brushed or
 * dragged region is one thing to follow. Whether there is anything to follow at
 * all is `hasAnyCoverage`'s question and not this one.
 */
export function objectsInSelection(commands: readonly SelectionCommand[]): number {
  return Math.max(1, answersIn(commands).length);
}

/**
 * The selection, split among the objects it is made of.
 *
 * A PARTITION, so the union of what comes back is the selection and nothing is
 * followed twice. Where two answers overlap the later one takes it, for the
 * same reason a later command wins everywhere else in this log: it is the more
 * recent statement about that pixel.
 *
 * The coverage is the one the renderer holds, read back once when Track is
 * pressed, so everything that has happened to the selection since the clicks is
 * already in it: an erased wheel is gone, a cleared frame is empty, and an
 * answer erased away entirely comes out with nothing in it and is dropped
 * rather than handed to the tracker as a seed of nothing.
 */
export function seedsFrom(
  coverage: CoverageMask,
  commands: readonly SelectionCommand[],
): readonly CoverageMask[] {
  const answers = answersIn(commands);
  // One object is the whole selection, which is what this returned before it
  // could return anything else. Not an optimisation: it is the case that must
  // not change, because it is every run anybody has made so far.
  if (answers.length < 2) return [coverage];
  // A document from another build could hold a mask of a different shape. The
  // partition is pixel-wise and has no meaning across two resolutions, so it is
  // refused rather than resampled: one seed is a worse run, not a wrong one.
  if (answers.some((mask) => mask.width !== coverage.width || mask.height !== coverage.height)) {
    return [coverage];
  }

  const size = coverage.width * coverage.height;
  const total = expandCoverage(coverage);
  const parts = answers.map(() => new Uint8Array(size));
  // Whether some answer has taken this pixel, rather than which one took it.
  // Walked from the LAST answer back, so an overlap goes to the later one
  // without an index having to be stored per pixel: a byte per pixel would cap
  // this at 255 objects and wrap silently past it, and nothing else here has a
  // ceiling anybody could reach by clicking.
  const claimed = new Uint8Array(size);
  const scratch = new Uint8Array(size);
  for (let i = answers.length - 1; i >= 1; i--) {
    const mask = answers[i];
    const part = parts[i];
    if (!mask || !part) continue;
    expandCoverage(mask, scratch);
    for (let p = 0; p < size; p++) {
      if (claimed[p] === 1 || (scratch[p] ?? 0) < SOLID) continue;
      claimed[p] = 1;
      // The ramp is kept rather than thresholded. A seed is a coverage mask and
      // the tracker reads it as one, so squaring off the edge here would hand
      // the memory encoder a harder boundary than the user actually drew.
      part[p] = total[p] ?? 0;
    }
  }
  // And the first takes everything nobody else did, which is its own answer and
  // whatever was brushed or dragged on top of the lot.
  const first = parts[0];
  if (first) for (let p = 0; p < size; p++) if (claimed[p] !== 1) first[p] = total[p] ?? 0;

  const seeds: CoverageMask[] = [];
  for (const part of parts) {
    if (part.some((value) => value >= SOLID)) {
      seeds.push(packCoverage(coverage.width, coverage.height, part));
    }
  }

  // Every answer erased away leaves nothing to follow, and the selection is
  // then whatever was drawn by hand. That is one object, and it is the same one
  // this function returns when there were never any answers.
  return seeds.length > 0 ? seeds : [coverage];
}
