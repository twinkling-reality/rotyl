/**
 * The framing a crash journal is written in, shared by both sides of the worker.
 *
 * A DOCUMENT AND A JOURNAL ARE THE SAME LOG IN TWO SHAPES, and the measurement
 * is why they are two. A document puts every command in one JSON header with
 * the masks in a region behind it, which is written once and read once: 11 ms
 * for ten minutes of tracking. A journal is written eighteen thousand times, so
 * the header cannot be at the front, because rewriting the whole document per
 * edit measures 2559 ms at that size. Appending one self-describing record
 * measures 0.13 ms whatever is already in the file.
 *
 * So a record carries its own lengths and nothing points backwards. A reader
 * walks forward and stops where the bytes stop, which is also what makes a
 * journal that was cut off mid-write recoverable up to the last whole record
 * rather than lost.
 *
 *   0  kind           u8, 0 for a command and 1 for the state around it
 *   1  json length    u32, little endian
 *   5  payload length u32, little endian
 *   9  json           UTF-8
 *   .. payload        a packed mask, or nothing
 *
 * See `/research/crash-recovery.html` for the numbers, and `journal.ts` for why
 * there are two kinds of record rather than one.
 */

export const RECORD_HEADER_BYTES = 9;

export const COMMAND_RECORD = 0;
export const STATE_RECORD = 1;

/** "ROTYLJ" and a zero, so a stray file in the origin private file system is not read as one. */
export const JOURNAL_MAGIC = [0x52, 0x4f, 0x54, 0x59, 0x4c, 0x4a, 0x00] as const;

/**
 * Bumped when a record stops meaning what it meant, on the same rule the
 * document format follows: a journal this build does not understand is
 * discarded rather than guessed at. Discarded rather than refused with a
 * sentence, because unlike a document nobody asked for it to be opened, and a
 * complaint about a file the user has never seen is not a message, it is noise.
 */
export const JOURNAL_VERSION = 1;

/** Magic and version, which is where the first record begins. */
export const JOURNAL_HEADER_BYTES = JOURNAL_MAGIC.length + 1;

export function journalHeader(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(JOURNAL_MAGIC.length + 1));
  out.set(JOURNAL_MAGIC, 0);
  out[JOURNAL_MAGIC.length] = JOURNAL_VERSION;
  return out;
}

export function isJournalHeader(bytes: Uint8Array): boolean {
  if (bytes.length < JOURNAL_MAGIC.length + 1) return false;
  return (
    JOURNAL_MAGIC.every((byte, index) => bytes[index] === byte) &&
    bytes[JOURNAL_MAGIC.length] === JOURNAL_VERSION
  );
}

/** One record, ready to be appended. */
export function frameRecord(
  kind: number,
  wire: unknown,
  payload: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(wire));
  const out = new Uint8Array(new ArrayBuffer(RECORD_HEADER_BYTES + json.length + payload.length));
  const view = new DataView(out.buffer);
  out[0] = kind;
  view.setUint32(1, json.length, true);
  view.setUint32(5, payload.length, true);
  out.set(json, RECORD_HEADER_BYTES);
  out.set(payload, RECORD_HEADER_BYTES + json.length);
  return out;
}

export interface WalkedRecord {
  readonly kind: number;
  readonly wire: unknown;
  readonly payload: Uint8Array<ArrayBuffer>;
  /**
   * Where this record began, and where the next one does.
   *
   * Carried out of the walk because a recovered session goes on being
   * journalled: an undo in it has to cut the file back to a record boundary,
   * and an append has to land after the last whole record rather than after
   * whatever fragment a killed tab left. Both are known here exactly and are
   * only reconstructable later by re-serialising the JSON and hoping it comes
   * out byte for byte the way it went in.
   */
  readonly at: number;
  readonly end: number;
}

/**
 * Every whole record in the file, and nothing after the first broken one.
 *
 * STOPS RATHER THAN THROWS. A journal is written by a tab that may have been
 * killed mid-append, so a trailing fragment is the ordinary case rather than
 * corruption, and everything before it is real work. A reader that refused the
 * whole file because the last write did not finish would be throwing away the
 * session to protect it.
 */
export function walkJournal(bytes: Uint8Array<ArrayBuffer>): readonly WalkedRecord[] {
  if (!isJournalHeader(bytes)) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out: WalkedRecord[] = [];

  let at = JOURNAL_MAGIC.length + 1;
  while (at + RECORD_HEADER_BYTES <= bytes.length) {
    const kind = bytes[at] ?? 0;
    const json = view.getUint32(at + 1, true);
    const payload = view.getUint32(at + 5, true);
    const end = at + RECORD_HEADER_BYTES + json + payload;
    if (end > bytes.length) break;
    let wire: unknown;
    try {
      wire = JSON.parse(
        decoder.decode(bytes.subarray(at + RECORD_HEADER_BYTES, at + RECORD_HEADER_BYTES + json)),
      );
    } catch {
      break;
    }
    out.push({ kind, wire, payload: bytes.subarray(end - payload, end), at, end });
    at = end;
  }
  return out;
}
