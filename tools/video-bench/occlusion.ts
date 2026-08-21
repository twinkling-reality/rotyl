// MEASUREMENT 14: what one more optional field on a command costs, and what
// the timeline was given to draw it with.
//
// A tracker asks the model, on every frame, whether the object is in it at all,
// and a frame it is not in gets an empty mask. That is the reference's own
// behaviour and it is right; what it costs is that an empty mask is also what a
// selection erased down to nothing looks like, so nothing downstream of the log
// could tell a tracker that gave up from a tracker that was asked and answered.
// The verdict is a field on the command now.
//
// The fair objection to that is arithmetic, so it is answered with arithmetic.
// A document is a JSON object per command with the packed masks in a region
// behind it, so a field added to a command is added as many times as there are
// commands, and ten minutes of tracking is eighteen thousand of them.
//
// TWO THINGS ARE ASKED AND ONLY ONE OF THEM IS THE FIELD.
//
//   WHAT THE FIELD COSTS. The same log is written twice, once with it and once
//   without, and the difference is the field and nothing else. That is the only
//   honest way to price it, because the frames it goes on differ from ordinary
//   tracked frames in a second way at the same time.
//
//   WHAT AN OCCLUSION COSTS, which is the second way and is the opposite sign.
//   An occluded frame's mask is empty, and an empty mask packs to a KILOBYTE
//   rather than to a silhouette's three and a half, so a run with occlusions in
//   it is the SMALLER document. Read off the two file sizes alone, the field
//   would look free or better than free, which it is not. This header said
//   three bytes until `EMPTY` below was run, and then went on saying it: the
//   guess a measurement disproved, quoted at the top of the file that disproved
//   it, which is the same defect as a document contradicting its own results.
//
// AND THE OTHER PROJECTION OVER THE SAME LOG, which is what the timeline is
// drawn from. It used to be handed the frame numbers an edit was made on and
// nothing else, so a run of three hundred frames could only be three hundred
// separate marks however they were styled, and one absolutely positioned
// element each.
//
// ITS OWN COMMAND AND ITS OWN FILE, and that is the rule this directory already
// follows rather than a preference. Both halves above fit somewhere else and
// both were written there first. The file cost is the same class of question as
// measurement 12 and shares its helpers; the projection is a projection over
// the command log, which is measurement 8. Measuring them there re-took those
// measurements, and moved figures six documents quote by noise: measurement
// 12's "eleven milliseconds to write and twelve to read" became ten and ten,
// and measurement 8's unpacking figure went from 10.5 ms to 11.0. Topical fit
// is the argument FOR folding two measurements together, which makes it exactly
// the wrong one.
//
// Fourteen rather than thirteen because `recovery.ts` is thirteen, and two
// entries in the trials ledger point at that number.
//
// Deliberately no GPU and no clips, like the two measurements either side of
// it: this is a data structure and the product's own writer over it.

import { editSpans, type SelectionCommand } from '../../src/core/document/selection-command.ts';
import { packCoverage, type CoverageMask } from '../../src/core/document/coverage-mask.ts';
import { DEFAULT_REFINE_SETTINGS } from '../../src/core/mask/refine-params.ts';
import { writeDocument, type RotylDocument } from '../../src/platform/document/document-file.ts';
import { STYLES } from '../../src/core/style/styles.ts';
import { coverage, MASK } from './log.ts';
import { sample, type Stat } from './util.ts';

/** Two seconds at thirty, which is a lorry crossing in front of somebody. */
const HIDDEN_FOR = 60;

/** One occlusion every hundred seconds, which is a busy street rather than a worst case. */
const EVERY = 3000;

/** Ten minutes at thirty, which is the size every other figure about a tracked log uses. */
const FRAMES = 18_000;

/**
 * What an occluded frame's mask actually is: nothing, through the real packer.
 *
 * Built rather than assumed, and the assumption was wrong by three hundred
 * times. A mask of nothing looks like it should pack to a byte or two, and
 * PackBits caps a repeat at 128, so sixty-five thousand zeroes are five hundred
 * and twelve repeats and a kilobyte. It is still a third of what a silhouette
 * costs, which is the point this makes; it is not free, which is the point the
 * fabricated version would have made instead.
 */
const EMPTY = packCoverage(MASK, MASK, new Uint8Array(MASK * MASK));

/** The media a document names. Not compared here; a digest of the right shape. */
const MEDIA = {
  name: 'city.mp4',
  bytes: 1_243_000_000,
  width: 1920,
  height: 1080,
  frames: FRAMES,
  digest: '0'.repeat(64),
};

const STYLE = STYLES[0] ?? { id: 'comic', controls: [] };

function documentOf(commands: readonly SelectionCommand[]): RotylDocument {
  return {
    media: MEDIA,
    commands,
    frame: FRAMES - 1,
    style: { id: STYLE.id, controls: {} },
  };
}

/**
 * A tracked run with the object going behind something, as the log holds it.
 *
 * `saySo` is the whole experiment: with it, the frames the model gave up on
 * carry the verdict; without it, they are the same commands with the same empty
 * masks and no way to tell what they mean.
 */
function run(mask: CoverageMask, occluded: boolean, saySo: boolean): SelectionCommand[] {
  const commands: SelectionCommand[] = [
    // The anchor, which a run writes no command for, because the user's own is
    // already there.
    { kind: 'paint', stroke: { points: [{ x: 400, y: 300 }], radius: 64, hardness: 0.7 }, frame: 0 },
  ];
  const group = 1;
  for (let frame = 1; frame < FRAMES; frame++) {
    const hidden = occluded && frame >= EVERY && frame % EVERY < HIDDEN_FOR;
    commands.push({
      kind: 'applyMask',
      mask: hidden ? EMPTY : mask,
      op: 'replace',
      refine: DEFAULT_REFINE_SETTINGS,
      frame,
      group,
      ...(hidden && saySo ? { absent: true as const } : {}),
    });
  }
  return commands;
}

const total = (chunks: readonly Uint8Array[]): number => chunks.reduce((sum, chunk) => sum + chunk.length, 0);

async function write(commands: readonly SelectionCommand[]): Promise<{ bytes: number; ms: Stat }> {
  const document = documentOf(commands);
  let chunks: readonly Uint8Array[] = [];
  const ms = await sample(5, 2, () => {
    chunks = writeDocument(document);
  });
  return { bytes: total(chunks), ms };
}

export async function occlusion(): Promise<unknown> {
  const mask = coverage(0.5);

  const plain = await write(run(mask, false, false));
  const said = await write(run(mask, true, true));
  const unsaid = await write(run(mask, true, false));

  const carrying = run(mask, true, true).filter(
    (command) => command.kind === 'applyMask' && command.absent === true,
  ).length;

  return {
    commands: FRAMES,
    frames_hidden: carrying,
    a_packed_mask_bytes: mask.packed.length,
    an_empty_packed_mask_bytes: EMPTY.packed.length,
    // The field, isolated: the same log, written twice, one field apart.
    the_field: {
      with_it_bytes: said.bytes,
      without_it_bytes: unsaid.bytes,
      bytes: said.bytes - unsaid.bytes,
      bytes_per_command: Math.round(((said.bytes - unsaid.bytes) / carrying) * 10) / 10,
      // Of the whole file, so the ratio is visible rather than left to be
      // divided by whoever reads it.
      per_cent_of_the_file: Math.round((said.bytes / unsaid.bytes - 1) * 1e6) / 1e4,
    },
    // And the occlusion, which moves the other way and by three orders more.
    the_occlusion: {
      nothing_hidden_bytes: plain.bytes,
      hidden_bytes: said.bytes,
      megabytes_saved: Math.round(((plain.bytes - said.bytes) / 1e6) * 100) / 100,
    },
    writing: {
      nothing_hidden_ms: plain.ms,
      hidden_and_said_ms: said.ms,
    },
    timeline: await timeline(mask),
  };
}

/**
 * The other projection over the same log, which nobody had priced.
 *
 * The fold is what the RENDERER asks of the log. The timeline asks something
 * else, and what it used to be handed was the frame numbers an edit was made on
 * and nothing else: right for a stroke, and for a run it says the opposite of
 * what happened, since a run is one gesture and `group` has recorded that since
 * the day tracking landed. It also produced one absolutely positioned element
 * per entry, so a ten-minute run put eighteen thousand of them on a track six
 * hundred pixels wide.
 *
 * Here rather than beside the fold in measurement 8 for the reason this whole
 * file exists: measured there, it re-took that measurement's compression
 * figures, which three documents quote, and moved one of them by noise.
 *
 * Each occlusion is two seconds, and how many of them fit is a property of the
 * clip rather than a knob: three of them in a ten-second run would be a subject
 * hidden for most of it, which is a different measurement in this one's clothes.
 */
async function timeline(mask: CoverageMask): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const [frames, occlusions] of [
    [300, 1],
    [3000, 3],
    [18_000, 3],
  ] as const) {
    for (const [name, count] of [
      ['nothing hidden', 0],
      [occlusions === 1 ? 'hidden once' : 'hidden three times', occlusions],
    ] as const) {
      const commands = sizedRun(frames, mask, count);
      let held: unknown;
      out[`${String(frames)} frames, ${name}`] = {
        commands: commands.length,
        // What the projection this replaced produced, which is one per edited
        // frame and therefore one element per edited frame on the track.
        marks: new Set(commands.map((command) => command.frame)).size,
        elements: editSpans(commands).length,
        // Run on every render of the editor, which is why it is timed at all.
        projection_ms: await sample(15, 3, () => {
          held = editSpans(commands);
        }),
        // Held so the projection cannot be optimised away.
        first: Array.isArray(held) ? (held[0] as unknown) : undefined,
      };
    }
  }
  return out;
}

/** The same run at any length, with `occlusions` stretches of it hidden. */
function sizedRun(frames: number, mask: CoverageMask, occlusions: number): SelectionCommand[] {
  const commands: SelectionCommand[] = [
    { kind: 'paint', stroke: { points: [{ x: 400, y: 300 }], radius: 64, hardness: 0.7 }, frame: 0 },
  ];
  const every = occlusions > 0 ? Math.floor(frames / (occlusions + 1)) : frames + 1;
  const group = 1;
  for (let frame = 1; frame < frames; frame++) {
    const hidden = occlusions > 0 && frame >= every && frame % every < HIDDEN_FOR;
    commands.push({
      kind: 'applyMask',
      mask: hidden ? EMPTY : mask,
      op: 'replace',
      refine: DEFAULT_REFINE_SETTINGS,
      frame,
      group,
      ...(hidden ? { absent: true as const } : {}),
    });
  }
  return commands;
}
