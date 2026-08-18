// MEASUREMENT 8: what a tracked clip does to the command log.
//
// Tracking contributes one applyMask command per frame it has followed the
// object to. That is the mechanism the document was built for and it needs no
// new command type, which is exactly why it is worth measuring before it is
// built: a design that fits is not the same as a design that scales, and the
// log is what makes undo and device-loss recovery cheap.
//
// Two numbers decide it and only one of them is uncertain.
//
//   THE BYTES are arithmetic. A mask at the engine's own 256 px square is
//   65,536 bytes, so three hundred frames is 19 MB and ten minutes at 30 fps is
//   1.2 GB. Nothing needs measuring there; what needs measuring is what a real
//   mask compresses to, because coverage is nearly binary and a run-length
//   encoding of it is a different order of magnitude.
//
//   THE FOLD is not arithmetic and is the one that can force a different
//   design. `commandsForFrame` filters and sorts the whole log on every frame,
//   which is nothing at ten commands and is a per-frame cost at ten thousand.
//   Playback has a 33 ms budget and the style chain is already spending most of
//   it.
//
// Deliberately no GPU here. This is a measurement about a data structure, and
// the data structure is DOM-free core code that runs anywhere.

import {
  commandsForFrame,
  type CoverageMask,
  type SelectionCommand,
} from '../../src/core/document/selection-command.ts';
import { DEFAULT_REFINE_SETTINGS } from '../../src/core/mask/refine-params.ts';
import { sample, stats, type Stat } from './util.ts';

/** What the engine answers at, whatever the photograph is. */
const MASK = 256;

/**
 * A mask shaped like something a tracker returns.
 *
 * `roughness` moves the boundary between a circle and a coastline, which is the
 * only property a run-length encoding cares about: its cost is the perimeter,
 * not the area. A real object's silhouette sits somewhere between the two and
 * the point of the sweep is to bracket it rather than to pick one.
 */
function coverage(roughness: number): CoverageMask {
  const data = new Uint8Array(MASK * MASK);
  const centre = MASK / 2;
  for (let y = 0; y < MASK; y++) {
    for (let x = 0; x < MASK; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const angle = Math.atan2(dy, dx);
      // Three harmonics, so the boundary is wobbly at more than one scale, the
      // way a silhouette is.
      const wobble =
        1 +
        roughness * (0.25 * Math.sin(angle * 7) + 0.15 * Math.sin(angle * 19) + 0.08 * Math.sin(angle * 41));
      const radius = MASK * 0.34 * wobble;
      const distance = Math.hypot(dx, dy);
      // A soft edge over two texels, which is what the engine's own answer has
      // and what makes this more than a bitmap.
      const t = Math.min(1, Math.max(0, (radius - distance) / 2));
      data[y * MASK + x] = Math.round(t * 255);
    }
  }
  return { width: MASK, height: MASK, coverage: data };
}

/**
 * Run-length encode by row, and return the bytes it would take.
 *
 * Two bytes a run: a value and a length, with a run capped at 255. Not a real
 * format, and deliberately the dumbest one that could work, because the
 * question is whether the order of magnitude changes rather than which codec
 * wins.
 */
function runLengthBytes(mask: CoverageMask): { bytes: number; runs: number } {
  let runs = 0;
  for (let y = 0; y < mask.height; y++) {
    let x = 0;
    while (x < mask.width) {
      const value = mask.coverage[y * mask.width + x];
      let length = 1;
      while (
        x + length < mask.width &&
        length < 255 &&
        mask.coverage[y * mask.width + x + length] === value
      ) {
        length++;
      }
      runs++;
      x += length;
    }
  }
  return { bytes: runs * 2, runs };
}

function trackedLog(frames: number, mask: CoverageMask): SelectionCommand[] {
  const commands: SelectionCommand[] = [];
  // One click, then a mask on every frame after it, which is the shape a
  // tracked clip produces: the user's own command first and the tracker's
  // folded on top of the held value at each frame it reached.
  for (let frame = 0; frame < frames; frame++) {
    commands.push({ kind: 'applyMask', mask, op: 'replace', refine: DEFAULT_REFINE_SETTINGS, frame });
  }
  return commands;
}

export async function log(): Promise<unknown> {
  const out: Record<string, unknown> = {};

  // What a mask costs, and what it would cost compressed.
  const compression: Record<string, unknown> = {};
  for (const roughness of [0, 0.5, 1]) {
    const mask = coverage(roughness);
    const { bytes, runs } = runLengthBytes(mask);
    compression[`roughness ${String(roughness)}`] = {
      raw_bytes: mask.coverage.length,
      run_length_bytes: bytes,
      runs,
      ratio: Math.round((mask.coverage.length / bytes) * 10) / 10,
    };
  }
  out.compression = compression;

  // The fold, at the sizes a clip actually reaches. The frame asked for is the
  // LAST one, which is the worst case and also the common one: playback walks
  // forward, so every frame after the first is asking about a prefix that
  // includes everything.
  const mask = coverage(0.5);
  const fold: Record<string, unknown> = {};
  for (const frames of [30, 300, 3000, 18000]) {
    const commands = trackedLog(frames, mask);
    let held: unknown;
    const timing: Stat = await sample(15, 3, () => {
      held = commandsForFrame(commands, frames - 1);
    });
    const middle: Stat = await sample(15, 3, () => {
      held = commandsForFrame(commands, Math.floor(frames / 2));
    });
    fold[`${String(frames)} frames`] = {
      at_the_end: timing,
      at_the_middle: middle,
      // Held so the fold cannot be optimised away, and reported so it is
      // obvious that it was not.
      folded: Array.isArray(held) ? held.length : 0,
      mask_megabytes: Math.round(((frames * mask.coverage.length) / 1e6) * 10) / 10,
    };
  }
  out.fold = fold;

  // The same thing with one command per SECOND rather than per frame, which is
  // the cheapest way of spending less: a tracker that contributes a keyframe
  // every thirty frames and lets the existing hold-forward rule cover the gap.
  const sparse: Record<string, unknown> = {};
  for (const frames of [3000, 18000]) {
    const commands = trackedLog(Math.ceil(frames / 30), mask).map((command, index) => ({
      ...command,
      frame: index * 30,
    }));
    let held: unknown;
    sparse[`${String(frames)} frames`] = {
      commands: commands.length,
      at_the_end: await sample(15, 3, () => {
        held = commandsForFrame(commands, frames - 1);
      }),
      folded: Array.isArray(held) ? held.length : 0,
      mask_megabytes: Math.round(((commands.length * mask.coverage.length) / 1e6) * 10) / 10,
    };
  }
  out.one_in_thirty = sparse;

  // What it costs to hold the bytes at all, rather than to fold them. Allocated
  // and touched, because an untouched typed array is a promise rather than a
  // page.
  const allocation: number[] = [];
  for (let run = 0; run < 5; run++) {
    const t0 = performance.now();
    const held: Uint8Array[] = [];
    for (let i = 0; i < 300; i++) {
      const copy = new Uint8Array(mask.coverage);
      copy[0] = i & 0xff;
      held.push(copy);
    }
    allocation.push(performance.now() - t0);
    if (held.length !== 300) throw new Error('unreachable');
  }
  out.allocating_300_masks_ms = stats(allocation);

  return out;
}
