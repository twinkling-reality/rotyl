import { describe, expect, it } from 'vitest';
import {
  COMMAND_RECORD,
  JOURNAL_HEADER_BYTES,
  JOURNAL_MAGIC,
  STATE_RECORD,
  frameRecord,
  isJournalHeader,
  journalHeader,
  walkJournal,
} from '../src/platform/document/journal-record.ts';
import {
  commandFromWire,
  commandToWire,
  documentStateFromWire,
} from '../src/platform/document/document-file.ts';
import { packCoverage } from '../src/core/document/coverage-mask.ts';
import type { SelectionCommand } from '../src/core/document/selection-command.ts';
import { DEFAULT_REFINE_SETTINGS } from '../src/core/mask/refine-params.ts';

/**
 * The framing a crash journal is written in, without a browser.
 *
 * What a journal has to survive is a tab that was killed, which means the
 * ordinary case is a file whose last record is half there. Everything below is
 * about that: that a whole record comes back exactly, that a fragment after it
 * is stopped at rather than thrown, and that the work in front of the fragment
 * is kept. The origin private file system it lands in is the end-to-end suite's
 * job; this is about the bytes.
 */

const MASK = 16;

function coverage(seed: number): Uint8Array {
  const bytes = new Uint8Array(MASK * MASK);
  for (let at = 0; at < bytes.length; at++) bytes[at] = (at * 7 + seed * 31) % 256 > 128 ? 255 : 0;
  return bytes;
}

const STATE = {
  media: {
    name: 'city.mp4',
    bytes: 1234,
    width: 1920,
    height: 1080,
    frames: 300,
    digest: 'c'.repeat(64),
  },
  frame: 42,
  range: { from: 10, to: 200 },
  style: { id: 'poster', controls: { strength: 0.5 } },
};

function join(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function commandRecord(command: SelectionCommand): Uint8Array<ArrayBuffer> {
  const { wire, payload } = commandToWire(command, 0);
  return frameRecord(COMMAND_RECORD, wire, payload);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false;
  return true;
}

describe('a crash journal', () => {
  it('brings back the state and every command that was written', () => {
    const commands: SelectionCommand[] = [
      { kind: 'paint', stroke: { points: [{ x: 3, y: 4 }], radius: 9, hardness: 0.5 }, frame: 0 },
      { kind: 'applyMask', mask: packCoverage(MASK, MASK, coverage(1)), op: 'replace', frame: 1, group: 4 },
      {
        kind: 'applyMask',
        mask: packCoverage(MASK, MASK, new Uint8Array(MASK * MASK)),
        op: 'replace',
        absent: true,
        frame: 3,
        group: 4,
      },
      {
        kind: 'applyMask',
        mask: packCoverage(MASK, MASK, coverage(2)),
        op: 'replace',
        refine: DEFAULT_REFINE_SETTINGS,
        frame: 2,
        group: 4,
      },
    ];

    const bytes = join([
      journalHeader(),
      frameRecord(STATE_RECORD, STATE, new Uint8Array(new ArrayBuffer(0))),
      ...commands.map((command) => commandRecord(command)),
    ]);

    const walked = walkJournal(bytes);
    expect(walked).toHaveLength(5);
    expect(walked[0]?.kind).toBe(STATE_RECORD);
    expect(documentStateFromWire(walked[0]?.wire)).toEqual(STATE);

    // Every mask compared as bytes rather than the commands as objects, for the
    // reason the document round trip does it that way: a journal that handed
    // back the wrong mask of the right length would pass an object comparison
    // on everything except the one field that matters.
    for (const [index, before] of commands.entries()) {
      const entry = walked[index + 1];
      expect(entry?.kind).toBe(COMMAND_RECORD);
      const after = commandFromWire(entry?.wire, entry?.payload ?? new Uint8Array(new ArrayBuffer(0)));
      expect(after.kind).toBe(before.kind);
      expect(after.frame).toBe(before.frame);
      expect(after.group).toBe(before.group);
      if (before.kind === 'applyMask' && after.kind === 'applyMask') {
        expect(sameBytes(after.mask.packed, before.mask.packed)).toBe(true);
        // The occlusion too, on the same read path the document uses: one
        // decoder for both formats is why this is one field and not two.
        expect(after.absent).toBe(before.absent);
      }
    }
  });

  it('reports where each record began and ended, so a resumed session appends after it', () => {
    const header = journalHeader();
    const one = commandRecord({ kind: 'clear', frame: 0 });
    const two = commandRecord({ kind: 'invert', frame: 1 });
    const walked = walkJournal(join([header, one, two]));

    expect(header.length).toBe(JOURNAL_HEADER_BYTES);
    expect(walked[0]?.at).toBe(JOURNAL_HEADER_BYTES);
    expect(walked[0]?.end).toBe(JOURNAL_HEADER_BYTES + one.length);
    expect(walked[1]?.at).toBe(walked[0]?.end);
    expect(walked[1]?.end).toBe(JOURNAL_HEADER_BYTES + one.length + two.length);
  });

  it('keeps the work in front of a record the tab was killed half way through', () => {
    const last = commandRecord({
      kind: 'applyMask',
      mask: packCoverage(MASK, MASK, coverage(3)),
      op: 'add',
      frame: 1,
    });
    const whole = join([
      journalHeader(),
      frameRecord(STATE_RECORD, STATE, new Uint8Array(new ArrayBuffer(0))),
      commandRecord({ kind: 'clear', frame: 0 }),
      last,
    ]);

    // Cut anywhere inside that last record, including one byte into it and one
    // byte short of the end. Everything before it is real work, and a reader
    // that refused the file would be throwing away the session in order to
    // protect it.
    for (const cut of [1, 5, Math.floor(last.length / 2), last.length - 1]) {
      const short = new Uint8Array(new ArrayBuffer(whole.length - cut));
      short.set(whole.subarray(0, short.length));
      const walked = walkJournal(short);
      // The state and the clear, and not the record that never finished.
      expect(walked).toHaveLength(2);
      expect(walked.at(-1)?.end).toBeLessThanOrEqual(short.length);
      expect(documentStateFromWire(walked[0]?.wire)).toEqual(STATE);
      expect(commandFromWire(walked[1]?.wire, new Uint8Array(new ArrayBuffer(0))).kind).toBe('clear');
    }
  });

  it('reads nothing at all out of a file that is not a journal', () => {
    expect(walkJournal(new Uint8Array(new ArrayBuffer(0)))).toEqual([]);

    const png = new Uint8Array(new ArrayBuffer(64));
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    expect(walkJournal(png)).toEqual([]);
    expect(isJournalHeader(png)).toBe(false);

    // And nothing out of one a newer build wrote, which is the same rule the
    // document format follows on the way in. Discarded rather than refused with
    // a sentence, because nobody asked for this file to be opened.
    const newer = join([journalHeader(), commandRecord({ kind: 'clear', frame: 0 })]);
    newer[JOURNAL_MAGIC.length] = 99;
    expect(walkJournal(newer)).toEqual([]);
  });
});
