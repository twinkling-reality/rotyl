import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_VERSION,
  describeDocumentReadError,
  documentFilename,
  looksLikeDocument,
  readDocument,
  writeDocument,
  type RotylDocument,
} from '../src/platform/document/document-file.ts';
import { compareMedia, digestMedia, type MediaIdentity } from '../src/platform/document/media-identity.ts';
import { packCoverage } from '../src/core/document/coverage-mask.ts';
import { SelectionDocument } from '../src/core/document/selection-document.ts';
import { commandsForFrame, type SelectionCommand } from '../src/core/document/selection-command.ts';
import { DEFAULT_REFINE_SETTINGS } from '../src/core/mask/refine-params.ts';

/**
 * The round trip, asserted rather than looked at.
 *
 * The whole architecture rests on the log being the source of truth, so what a
 * document has to prove is not that it wrote a file but that what comes back is
 * the same log, byte for byte in the masks and frame for frame in the commands.
 * A test that checked a length would pass on a file with every mask replaced by
 * the first one.
 *
 * No GPU anywhere in it, deliberately, which is why it can assert on three
 * hundred masks: this is a statement about bytes, and the mask a replay of them
 * builds on a real device is the end-to-end suite's job.
 */

const MASK_SIZE = 32;

/** A silhouette with a soft edge, which is the shape a packing's cost depends on. */
function coverage(seed: number): Uint8Array {
  const bytes = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (let y = 0; y < MASK_SIZE; y++) {
    for (let x = 0; x < MASK_SIZE; x++) {
      const dx = x - MASK_SIZE / 2 - (seed % 5);
      const dy = y - MASK_SIZE / 2;
      const t = Math.min(1, Math.max(0, (MASK_SIZE * 0.3 - Math.hypot(dx, dy)) / 2));
      bytes[y * MASK_SIZE + x] = Math.round(t * 255);
    }
  }
  return bytes;
}

const MEDIA: MediaIdentity = {
  name: 'city.mp4',
  bytes: 1234,
  width: 1920,
  height: 1080,
  frames: 300,
  digest: 'a'.repeat(64),
};

function documentWith(commands: readonly SelectionCommand[], extra?: Partial<RotylDocument>): RotylDocument {
  return {
    media: MEDIA,
    commands,
    frame: 0,
    style: { id: 'comic', controls: { strength: 0.75, palette: 2 } },
    ...extra,
  };
}

/** Write and read back, as the app does: chunks into a buffer, buffer into a log. */
function roundTrip(document: RotylDocument): RotylDocument {
  const chunks = writeDocument(document);
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const parsed = readDocument(bytes);
  if (!parsed.ok) throw new Error(`did not read back: ${describeDocumentReadError(parsed.error)}`);
  return parsed.value;
}

/**
 * Byte by byte in a loop, never spread.
 *
 * `toEqual` on two `Uint8Array`s compares them properly, but building the
 * failure message it might need is what costs, and the unit suite's own limits
 * page is explicit that garbage made by a test with no GPU in it aborts the
 * ones that have.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false;
  return true;
}

describe('a saved document', () => {
  it('brings a photograph back exactly, stroke, rectangle and mask', () => {
    const commands: SelectionCommand[] = [
      {
        kind: 'paint',
        stroke: {
          points: [
            { x: 4, y: 9 },
            { x: 40, y: 90 },
          ],
          radius: 12,
          hardness: 0.4,
        },
        frame: 0,
      },
      { kind: 'rect', rect: { x0: 3, y0: 4, x1: 300, y1: 40 }, mode: 'erase', frame: 0 },
      { kind: 'invert', frame: 0 },
      {
        kind: 'applyMask',
        mask: packCoverage(MASK_SIZE, MASK_SIZE, coverage(1)),
        op: 'add',
        refine: DEFAULT_REFINE_SETTINGS,
        frame: 0,
      },
    ];

    const back = roundTrip(documentWith(commands));
    expect(back.commands).toHaveLength(commands.length);
    expect(back.media).toEqual(MEDIA);
    expect(back.style).toEqual({ id: 'comic', controls: { strength: 0.75, palette: 2 } });
    // The masks compared as bytes rather than the commands compared as objects,
    // because the object comparison is what would pass on a mask replaced by a
    // view of the wrong length.
    for (const [index, before] of commands.entries()) {
      const after = back.commands[index];
      expect(after?.kind).toBe(before.kind);
      expect(after?.frame).toBe(before.frame);
      if (before.kind === 'applyMask' && after?.kind === 'applyMask') {
        expect(after.mask.width).toBe(before.mask.width);
        expect(sameBytes(after.mask.packed, before.mask.packed)).toBe(true);
        expect(after.op).toBe(before.op);
        expect(after.refine).toEqual(before.refine);
      }
    }
    expect(back.commands[0]).toEqual(commands[0]);
    expect(back.commands[1]).toEqual(commands[1]);
  });

  it('brings a three hundred frame tracked run back, with every frame still meaning what it meant', () => {
    const group = 7;
    const commands: SelectionCommand[] = [
      { kind: 'paint', stroke: { points: [{ x: 1, y: 1 }], radius: 8, hardness: 1 }, frame: 12 },
    ];
    for (let frame = 12; frame < 312; frame++) {
      commands.push({
        kind: 'applyMask',
        mask: packCoverage(MASK_SIZE, MASK_SIZE, coverage(frame)),
        op: 'replace',
        refine: DEFAULT_REFINE_SETTINGS,
        frame,
        group,
      });
    }

    const back = roundTrip(documentWith(commands, { frame: 250, range: { from: 20, to: 280 } }));
    expect(back.commands).toHaveLength(301);
    expect(back.frame).toBe(250);
    expect(back.range).toEqual({ from: 20, to: 280 });

    let matched = 0;
    for (const [index, before] of commands.entries()) {
      const after = back.commands[index];
      if (!after || after.frame !== before.frame || after.group !== before.group) continue;
      if (before.kind !== 'applyMask' || after.kind !== 'applyMask') {
        matched++;
        continue;
      }
      if (sameBytes(after.mask.packed, before.mask.packed)) matched++;
    }
    expect(matched).toBe(commands.length);

    // AND THE FOLD STILL ANSWERS THE SAME THING. Every mask in that run differs
    // from its neighbours, so a document that mixed two of them up would still
    // have three hundred masks of the right length and would put the wrong one
    // on the frame being shown.
    for (const frame of [12, 100, 250, 311]) {
      const before = commandsForFrame(commands, frame);
      const after = commandsForFrame(back.commands, frame);
      expect(after).toHaveLength(before.length);
      const a = before.at(-1);
      const b = after.at(-1);
      expect(b?.frame).toBe(a?.frame);
      if (a?.kind === 'applyMask' && b?.kind === 'applyMask') {
        expect(sameBytes(b.mask.packed, a.mask.packed)).toBe(true);
      }
    }
  });

  it('loads into a command log that undoes a tracked run as one gesture', () => {
    const group = 3;
    const commands: SelectionCommand[] = [
      { kind: 'paint', stroke: { points: [{ x: 1, y: 1 }], radius: 8, hardness: 1 }, frame: 0 },
      { kind: 'clear', frame: 5, group },
      { kind: 'clear', frame: 6, group },
      { kind: 'clear', frame: 7, group },
    ];
    const back = roundTrip(documentWith(commands));

    const document = new SelectionDocument();
    document.load(back.commands);
    expect(document.appliedCommands).toHaveLength(4);
    expect(document.canRedo).toBe(false);

    // The whole run, in one press, landing on the frame it started at.
    expect(document.undo()?.frame).toBe(5);
    expect(document.appliedCommands).toHaveLength(1);
    expect(document.undo()?.frame).toBe(0);
    expect(document.appliedCommands).toHaveLength(0);

    // And a group id handed out after a load cannot collide with a loaded one,
    // which would weld two gestures into one undo.
    expect(document.beginGroup()).toBeGreaterThan(group);
  });

  it('refuses a file that is not a document', async () => {
    const notOne = new Uint8Array(new ArrayBuffer(64));
    notOne.set([0x89, 0x50, 0x4e, 0x47], 0);
    const parsed = readDocument(notOne);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe('not-a-document');
    expect(await looksLikeDocument(new Blob([notOne]))).toBe(false);
    expect(await looksLikeDocument(new Blob([writeDocument(documentWith([]))[0] ?? new Uint8Array()]))).toBe(
      true,
    );
  });

  it('refuses a document from a newer build, by version, before parsing anything', () => {
    const chunks = writeDocument(documentWith([{ kind: 'clear', frame: 0 }]));
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const bytes = new Uint8Array(new ArrayBuffer(total));
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    // Written by a build that reads a format this one does not.
    new DataView(bytes.buffer).setUint16(6, DOCUMENT_VERSION + 1, true);
    const parsed = readDocument(bytes);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.kind).toBe('from-a-newer-version');
      expect(describeDocumentReadError(parsed.error)).toContain('newer version');
    }
  });

  it('refuses a truncated document rather than replaying the part that arrived', () => {
    const commands: SelectionCommand[] = [
      {
        kind: 'applyMask',
        mask: packCoverage(MASK_SIZE, MASK_SIZE, coverage(2)),
        op: 'replace',
        frame: 0,
      },
    ];
    const chunks = writeDocument(documentWith(commands));
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const bytes = new Uint8Array(new ArrayBuffer(total));
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }

    // A write that stopped part way, which a page cannot prevent: the payload
    // offsets are absolute, so a mask reaching past the end is caught rather
    // than silently short.
    const short = bytes.subarray(0, total - 8);
    const cut = new Uint8Array(new ArrayBuffer(short.length));
    cut.set(short);
    const parsed = readDocument(cut);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe('damaged');
  });

  it('refuses a header that says something no command could mean', () => {
    const chunks = writeDocument(documentWith([{ kind: 'clear', frame: 0 }]));
    const prefix = chunks[0];
    const header = chunks[1];
    if (!prefix || !header) throw new Error('unreachable');
    const text = new TextDecoder().decode(header).replace('"clear"', '"scribble"');
    const replaced = new TextEncoder().encode(text);
    const bytes = new Uint8Array(new ArrayBuffer(prefix.length + replaced.length));
    bytes.set(prefix, 0);
    bytes.set(replaced, prefix.length);
    new DataView(bytes.buffer).setUint32(8, replaced.length, true);

    const parsed = readDocument(bytes);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.kind).toBe('damaged');
      expect(describeDocumentReadError(parsed.error)).toContain('scribble');
    }
  });

  it('names itself after the file it was made on', () => {
    expect(documentFilename('city.mp4')).toBe('city.rotyl');
    expect(documentFilename('holiday.snap.jpeg')).toBe('holiday.snap.rotyl');
    expect(documentFilename('')).toBe('selection.rotyl');
  });
});

describe('which file a document belongs to', () => {
  it('digests the ends and the length, so two clips of the same shape differ', async () => {
    const body = new Uint8Array(new ArrayBuffer(4096));
    for (let at = 0; at < body.length; at++) body[at] = at & 0xff;
    const one = await digestMedia(new Blob([body]));
    expect(await digestMedia(new Blob([body]))).toBe(one);

    // A different last byte, which a name and a length cannot see.
    const changed = new Uint8Array(new ArrayBuffer(body.length));
    changed.set(body);
    changed[changed.length - 1] = 0;
    expect(await digestMedia(new Blob([changed]))).not.toBe(one);

    // And a truncation, which is what the length in the probe is for.
    expect(await digestMedia(new Blob([body.subarray(0, 4000)]))).not.toBe(one);
  });

  it('tells a re-encode of the same clip apart from a different clip', () => {
    const saved = MEDIA;
    expect(compareMedia(saved, { ...saved })).toBe('same');
    // Same shape, different bytes: replayable, and worth a sentence.
    expect(compareMedia(saved, { ...saved, digest: 'b'.repeat(64) })).toBe('restyled');
    expect(compareMedia(saved, { ...saved, bytes: saved.bytes + 1 })).toBe('restyled');
    // A different shape: frame 299 may not exist and a stroke may be off the
    // image, so there is nothing to replay against.
    expect(compareMedia(saved, { ...saved, frames: 30 })).toBe('wrong');
    expect(compareMedia(saved, { ...saved, width: 1280, height: 720 })).toBe('wrong');
    // A renamed file is the same file. The name is what the drop zone asks for
    // when it has a document and no media, and nothing else.
    expect(compareMedia(saved, { ...saved, name: 'city-copy.mp4' })).toBe('same');
  });
});
