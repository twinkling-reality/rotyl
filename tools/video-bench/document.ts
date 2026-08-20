// MEASUREMENT 12: what the command log costs once it has to become a file.
//
// The log has been the source of truth since the first chapter and has never
// outlived a tab. What a brush stroke costs to write down is nothing and
// everybody knows it. What nobody here had measured is what a TRACKED RUN
// costs, and that decides whether saving is a file format or a paragraph in
// known limits: measurement 8 puts a packed mask at 3.4 KB and ten minutes of
// tracking at 62 MB held in memory, and the question is what happens to those
// 62 MB on the way to a disk and back.
//
// Three things are asked, and only the second one could have forced a different
// design.
//
//   WHAT A DOCUMENT COSTS TO WRITE, TO READ BACK AND TO HOLD, at one stroke, at
//   a three hundred frame run and at ten minutes of tracking. This drives the
//   product's own writer and reader rather than a sketch of them, so the bytes
//   below are the bytes a save produces.
//
//   WHICH SHAPE OF FILE. A container with a JSON header and the packed masks
//   behind it, against the obvious alternative of JSON with the masks base64
//   encoded. Base64 is a third larger before anything else happens; what is not
//   arithmetic is what it costs to build and take apart, which is where a
//   ten-minute document either opens instantly or does not.
//
//   WHAT A REPLAY COSTS AFTER A LOAD, which decides whether the file can be
//   dumb. If opening a document is a fold and one texture upload, nothing has
//   to be cached in it. If it is not, the file has to carry something the fold
//   cannot recompute, and that is a different format.
//
// And a fourth that is not about the log at all: WHAT IDENTIFYING THE MEDIA
// COSTS. A browser has no paths, so a document names a file it cannot address,
// and the choice is between something cheap and weak and something strong and
// slow. See `media-identity.ts` for what the numbers below decided.
//
// Deliberately no GPU and no clips, exactly like measurement 8: this is
// arithmetic over a data structure and a `crypto.subtle` call, and it runs
// anywhere.

import { commandsForFrame, type SelectionCommand } from '../../src/core/document/selection-command.ts';
import { expandCoverage, type CoverageMask } from '../../src/core/document/coverage-mask.ts';
import { DEFAULT_REFINE_SETTINGS } from '../../src/core/mask/refine-params.ts';
import {
  readDocument,
  writeDocument,
  type RotylDocument,
} from '../../src/platform/document/document-file.ts';
import { digestMedia } from '../../src/platform/document/media-identity.ts';
import { coverage, MASK } from './log.ts';
import { sample, type Stat } from './util.ts';

/** A photograph's whole log: somebody drew one line on it. */
function oneStroke(): SelectionCommand[] {
  const points = Array.from({ length: 60 }, (_, i) => ({ x: 400 + i * 7, y: 300 + Math.sin(i / 4) * 90 }));
  return [{ kind: 'paint', stroke: { points, radius: 64, hardness: 0.7 }, frame: 0 }];
}

/**
 * A tracked run's log: the click that seeded it, then one mask per frame.
 *
 * The same shape measurement 8 folds, so the two files describe the same log
 * and "62 MB held" and "62 MB written" are comparable claims rather than two
 * numbers about two different silhouettes.
 */
function trackedRun(frames: number, mask: CoverageMask): SelectionCommand[] {
  const commands: SelectionCommand[] = oneStroke();
  const group = 1;
  for (let frame = 0; frame < frames; frame++) {
    commands.push({ kind: 'applyMask', mask, op: 'replace', refine: DEFAULT_REFINE_SETTINGS, frame, group });
  }
  return commands;
}

/** The media a document names, with a digest that is not recomputed here. */
const MEDIA = {
  name: 'city.mp4',
  bytes: 1_243_000_000,
  width: 1920,
  height: 1080,
  frames: 18_000,
  digest: '0'.repeat(64),
} as const;

function documentOf(commands: readonly SelectionCommand[], frame: number): RotylDocument {
  return {
    media: MEDIA,
    commands,
    frame,
    range: { from: 0, to: Math.max(0, frame) },
    style: { id: 'comic', controls: { strength: 0.8, detail: 0.5, palette: 2 } },
  };
}

/** Total bytes across a chunk list, which is what a save writes. */
function totalBytes(chunks: readonly Uint8Array[]): number {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  return total;
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(totalBytes(chunks));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * The alternative, reproduced here rather than shipped.
 *
 * The same rule `long-clip.ts` follows for the sink that used to ship: the
 * thing being compared against has to exist somewhere, and the place for it is
 * next to the measurement that rejected it rather than in the product.
 *
 * Base64 in blocks, because a character at a time is minutes on a megabyte and
 * spreading a typed array into `apply` overflows the argument list at about
 * a hundred thousand elements.
 */
const BLOCK = 8192;

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let at = 0; at < bytes.length; at += BLOCK) {
    parts.push(String.fromCharCode(...bytes.subarray(at, at + BLOCK)));
  }
  return btoa(parts.join(''));
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at);
  return out;
}

function writeAsJson(document: RotylDocument): string {
  return JSON.stringify(document, (_key, value: unknown) =>
    value instanceof Uint8Array ? toBase64(value) : value,
  );
}

/**
 * The parse, with every mask rebuilt, counted rather than typed.
 *
 * The commands are counted in the reviver instead of read off a cast result,
 * which is the same thing said without asserting a shape onto whatever was in
 * the string. It is also the only way to be sure the base64 was actually
 * decoded: an unused parse result is a measurement of nothing.
 */
function readAsJson(text: string): { document: unknown; commands: number } {
  let commands = 0;
  const document: unknown = JSON.parse(text, (key, value: unknown) => {
    if (key === 'packed' && typeof value === 'string') return fromBase64(value);
    if (key === 'commands' && Array.isArray(value)) commands = value.length;
    return value;
  });
  return { document, commands };
}

/** Fewer repeats on the rungs that take seconds, stated rather than hidden. */
function repeats(commands: number): { n: number; warmup: number } {
  if (commands > 10_000) return { n: 3, warmup: 1 };
  if (commands > 100) return { n: 9, warmup: 3 };
  return { n: 15, warmup: 3 };
}

async function measureCase(
  commands: readonly SelectionCommand[],
  frame: number,
): Promise<Record<string, unknown>> {
  const document = documentOf(commands, frame);
  const { n, warmup } = repeats(commands.length);

  // What the log is holding before any of this: the packed masks themselves,
  // which the container hands over rather than copying.
  let held = 0;
  for (const command of commands) if (command.kind === 'applyMask') held += command.mask.packed.length;

  let chunks: readonly Uint8Array<ArrayBuffer>[] = [];
  const encode: Stat = await sample(n, warmup, () => {
    chunks = writeDocument(document);
  });
  const bytes = joined(chunks);

  // Through a real Blob, because that is what a save with nowhere to write
  // produces and what an open reads back. It is also the only part of the write
  // path that has to touch every byte.
  // The chunks the encode above produced, not a fresh encode: this is the part
  // of a save that has to touch every byte, and the part of an open that has to
  // read them back, isolated from building the header.
  let roundTripped = new Uint8Array(new ArrayBuffer(0));
  const throughBlob: Stat = await sample(n, warmup, async () => {
    roundTripped = new Uint8Array(await new Blob([...chunks]).arrayBuffer());
  });

  let loaded: RotylDocument | undefined;
  const read: Stat = await sample(n, warmup, () => {
    const result = readDocument(roundTripped);
    if (!result.ok) throw new Error(`the container did not read back: ${result.error.kind}`);
    loaded = result.value;
  });

  // A round trip that lost a byte would measure beautifully. Asserted rather
  // than assumed, on the one thing the whole chapter is about.
  if (!loaded) throw new Error('unreachable');
  const parsed: RotylDocument = loaded;
  if (parsed.commands.length !== commands.length) throw new Error('the command count changed');
  for (const [index, before] of commands.entries()) {
    const after = parsed.commands[index];
    if (!after || after.kind !== before.kind || after.frame !== before.frame) {
      throw new Error(`command ${String(index)} came back different`);
    }
    if (before.kind === 'applyMask' && after.kind === 'applyMask') {
      if (after.mask.packed.length !== before.mask.packed.length) {
        throw new Error(`mask ${String(index)} came back a different length`);
      }
      for (let at = 0; at < before.mask.packed.length; at++) {
        if (after.mask.packed[at] !== before.mask.packed[at]) {
          throw new Error(`mask ${String(index)} came back different at byte ${String(at)}`);
        }
      }
    }
  }

  let json = '';
  const jsonWrite: Stat = await sample(n, warmup, () => {
    json = writeAsJson(document);
  });
  const jsonRead: Stat = await sample(n, warmup, () => {
    const back = readAsJson(json);
    if (back.commands !== commands.length) throw new Error('the JSON did not read back');
  });

  // What opening a document then costs before anything is on screen: fold the
  // loaded log to the frame it was saved on, and unpack the one mask the fold
  // cut to. Everything else is a texture upload the renderer does anyway.
  let folded = 0;
  const into = new Uint8Array(MASK * MASK);
  const replay: Stat = await sample(n, warmup, () => {
    const applies = commandsForFrame(parsed.commands, frame);
    folded = applies.length;
    for (const command of applies) if (command.kind === 'applyMask') expandCoverage(command.mask, into);
  });

  return {
    commands: commands.length,
    held_megabytes: Math.round((held / 1e6) * 10) / 10,
    container: {
      bytes: totalBytes(chunks),
      megabytes: Math.round((bytes.length / 1e6) * 100) / 100,
      chunks: chunks.length,
      encode_ms: encode,
      through_a_blob_ms: throughBlob,
      read_ms: read,
    },
    json_base64: {
      bytes: json.length,
      megabytes: Math.round((json.length / 1e6) * 100) / 100,
      larger_by: Math.round((json.length / bytes.length) * 1000) / 1000,
      write_ms: jsonWrite,
      read_ms: jsonRead,
    },
    replay: { folded_to: folded, ms: replay },
  };
}

/**
 * What identifying the media costs, which is the one decision in this chapter
 * that is not about the log.
 *
 * The question is whether a document can afford to digest the whole file it
 * names. Two things decide it and only one is a timing. `crypto.subtle.digest`
 * takes a BufferSource and there is no streaming form of it anywhere in the
 * platform, so a whole-file digest means the whole file resident: a two
 * gigabyte clip has to be in the heap at once, which is the exact thing
 * measurement 10 shows a clip export failing at. The rate below then says what
 * it would cost even where it fits.
 */
async function identity(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  const whole: Record<string, unknown> = {};
  for (const megabytes of [1, 16, 64, 256, 1024]) {
    const size = megabytes * (1 << 20);
    try {
      const buffer = new Uint8Array(size);
      // Touched, because an untouched allocation is a promise rather than a
      // page and would measure the fault rather than the digest.
      for (let at = 0; at < size; at += 4096) buffer[at] = at & 0xff;
      const timing = await sample(megabytes > 64 ? 3 : 7, 1, async () => {
        await crypto.subtle.digest('SHA-256', buffer);
      });
      whole[`${String(megabytes)} MB`] = {
        ms: timing,
        megabytes_per_second: Math.round(megabytes / (timing.median / 1000)),
      };
    } catch (error) {
      // A rung that will not allocate IS the finding, at the size where it
      // stops. Reported rather than thrown, so the smaller rungs survive it.
      whole[`${String(megabytes)} MB`] = { failed: String(error) };
    }
  }
  out.the_whole_file = whole;

  // The bounded probe, on blobs standing in for media of each size. Two slices
  // and eight bytes whatever the file is, so this should be flat, and flat is
  // the finding.
  const bounded: Record<string, unknown> = {};
  const block = new Uint8Array(1 << 20);
  for (let at = 0; at < block.length; at += 512) block[at] = at & 0xff;
  for (const megabytes of [2, 64, 1024]) {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < megabytes; i++) parts.push(block);
    const blob = new Blob(parts);
    let digest = '';
    const timing = await sample(7, 2, async () => {
      digest = await digestMedia(blob);
    });
    bounded[`${String(megabytes)} MB`] = { ms: timing, digest_length: digest.length };
  }
  out.the_first_and_last_megabyte = bounded;

  return out;
}

export async function documentCost(): Promise<unknown> {
  const mask = coverage(0.5);
  const out: Record<string, unknown> = {
    a_packed_mask_bytes: mask.packed.length,
  };

  out['one stroke'] = await measureCase(oneStroke(), 0);
  out['a tracked run'] = await measureCase(trackedRun(300, mask), 299);
  out['ten minutes'] = await measureCase(trackedRun(18_000, mask), 17_999);
  out.identity = await identity();

  return out;
}
