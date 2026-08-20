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
//   mask compresses to, because coverage is nearly binary and a packing of it
//   is a different order of magnitude. This runs the packing the document
//   actually uses rather than a sketch of one, so the ratio below is the ratio
//   a log gets and not an argument for building it.
//
//   THE FOLD is not arithmetic and is the one that can force a different
//   design. `commandsForFrame` filters and sorts the whole log on every frame,
//   which is nothing at ten commands and is a per-frame cost at ten thousand.
//   Playback has a 33 ms budget and the style chain is already spending most of
//   it.
//
// Deliberately no GPU here. This is a measurement about a data structure, and
// the data structure is DOM-free core code that runs anywhere.

import { commandsForFrame, type SelectionCommand } from '../../src/core/document/selection-command.ts';
import { expandCoverage, packCoverage, type CoverageMask } from '../../src/core/document/coverage-mask.ts';
import { DEFAULT_REFINE_SETTINGS } from '../../src/core/mask/refine-params.ts';
import { sample, stats, type Stat } from './util.ts';

/** What the engine answers at, whatever the photograph is. */
export const MASK = 256;

/**
 * A mask shaped like something a tracker returns.
 *
 * `roughness` moves the boundary between a circle and a coastline, and `ramp`
 * moves how wide the boundary itself is. Those are the two properties a packing
 * cares about, because its cost is the perimeter rather than the area and a
 * soft perimeter is a wider one. A real silhouette sits inside both sweeps and
 * the point of them is to bracket it rather than to pick one.
 *
 * The ramp matters more than it looks. `edgetam-engine.ts` maps the decision
 * boundary to clearly-decided across the whole 0 to 255 range on purpose, so a
 * confident edge crosses it inside a texel and a region the model is unsure
 * about never leaves it. The second sweep is what an unsure answer costs.
 *
 * Exported so that `document.ts` measures a file made of the same masks this
 * one measures in memory. Two harnesses drawing their own silhouettes would
 * make "62 MB held" and "62 MB written" two numbers about two different logs.
 */
export function coverage(roughness: number, ramp = 2): CoverageMask {
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
      // A soft edge, which is what the engine's own answer has and what makes
      // this more than a bitmap.
      const t = Math.min(1, Math.max(0, (radius - distance) / ramp));
      data[y * MASK + x] = Math.round(t * 255);
    }
  }
  return packCoverage(MASK, MASK, data);
}

const RAW_BYTES = MASK * MASK;

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

  // What a mask costs packed, and what it costs to get the bytes back, which
  // is the price the packing charges: a replay unpacks one of these per
  // applyMask command before it can upload it.
  const compression: Record<string, unknown> = {};
  const cases: readonly (readonly [string, CoverageMask])[] = [
    ['roughness 0', coverage(0)],
    ['roughness 0.5', coverage(0.5)],
    ['roughness 1', coverage(1)],
    ['a boundary 6 texels wide', coverage(0.5, 6)],
    ['a boundary 16 texels wide', coverage(0.5, 16)],
  ];
  const into = new Uint8Array(RAW_BYTES);
  for (const [name, mask] of cases) {
    let held = 0;
    compression[name] = {
      raw_bytes: RAW_BYTES,
      packed_bytes: mask.packed.length,
      ratio: Math.round((RAW_BYTES / mask.packed.length) * 10) / 10,
      // Three hundred of them, which is a replay of a ten-second tracked run
      // rather than one command: a single mask unpacks below what a timer here
      // can see, and the question is what a whole rebuild of the mask pays.
      unpacking_300_ms: await sample(15, 3, () => {
        for (let i = 0; i < 300; i++) held = expandCoverage(mask, into)[i] ?? 0;
      }),
      // Held so the unpacking cannot be optimised away.
      last_byte: held,
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
      raw_megabytes: Math.round(((frames * RAW_BYTES) / 1e6) * 10) / 10,
      packed_megabytes: Math.round(((frames * mask.packed.length) / 1e6) * 10) / 10,
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
      raw_megabytes: Math.round(((commands.length * RAW_BYTES) / 1e6) * 10) / 10,
      packed_megabytes: Math.round(((commands.length * mask.packed.length) / 1e6) * 10) / 10,
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
      const copy = new Uint8Array(mask.packed);
      copy[0] = i & 0xff;
      held.push(copy);
    }
    allocation.push(performance.now() - t0);
    if (held.length !== 300) throw new Error('unreachable');
  }
  out.allocating_300_masks_ms = stats(allocation);

  return out;
}
