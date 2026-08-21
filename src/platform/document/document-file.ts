/**
 * The command log, as a file.
 *
 * `docs/architecture.md` has said from the beginning that strokes rather than
 * pixels are the source of truth, and that replaying the log rebuilds the mask.
 * Everything is built on that: undo is a cursor into it, export replays it
 * rather than asking the app what applies, and a lost graphics device is
 * survivable because the log belongs to the work rather than to the device.
 * This is the last place that was true only until the tab closed.
 *
 * WHY IT LIVES IN `platform` AND NOT IN `core`. Core owns what a document IS
 * and knows a frame is an integer and a mask is a packed byte run. What a
 * document becomes on a disk is bytes, a `TextEncoder`, a `Blob` and a file
 * handle, none of which exist in `tsconfig.core.json`'s world. That is the same
 * split as the frame provider, where core knows a frame index and platform
 * knows how to decode one, and the same as `destination.ts`, where core knows
 * nothing about a file handle. Core did not have to learn a file format for
 * this and it has not.
 *
 * A CONTAINER RATHER THAN JSON, and that is measured rather than assumed. The
 * bulk of a document is masks: one per frame a tracking run reached PER OBJECT
 * it followed, packed, about 3.4 KB each and so 62 MB for ten minutes of
 * following one thing and three times that for three. Base64 is a third larger
 * again and has to be built and taken apart a character at a time on both sides,
 * where a container writes the bytes the log already holds and reads them back
 * as views into one buffer with no copy at all. `/research/the-document.html`
 * has both, at one stroke, at a three hundred frame run and at ten minutes.
 *
 * SO THE HEADER IS JSON AND THE PAYLOAD IS NOT, which is the shape every honest
 * container has. Everything small enough to read in a text editor stays legible
 * and extensible, and the one thing that is neither goes in a region the header
 * points into. It needs no library, which a document format in a 51 KB
 * application has to be able to say.
 *
 * AND IT IS NOT BEHIND A DYNAMIC IMPORT, which is the opposite of what the
 * demuxer, the container writer and the inference runtime get, so it was
 * measured rather than assumed. Split off, this module and the digest beside it
 * are 2.46 KB gzipped across three chunks and take 1.58 KB off the application
 * bundle: a kilobyte and a half back for a session that never saves, and 0.9 KB
 * more in total plus three round trips for one that does. The writer is split
 * because it is 42.8 KB. This is not, and putting a network fetch in front of
 * Save to recover a kilobyte and a half would be a failure mode invented for
 * the one operation in the product that exists to keep somebody's afternoon.
 *
 *   0   magic          6 bytes, "ROTYL" and a zero
 *   6   version        u16, little endian
 *   8   header length  u32, little endian
 *   12  header         UTF-8 JSON, that many bytes
 *   ..  payloads       packed masks, concatenated, in the order the header names
 *
 * A FILE FROM A NEWER BUILD IS REFUSED BY SIGNATURE, which is the rule HEIC and
 * Matroska already follow on the way in. This is the first format this project
 * WRITES and therefore the first it will have to read from an older version of
 * itself, and the rule has to exist before there is a second version rather
 * than after, because after that it is archaeology. A version this build does
 * not know is a sentence saying so. A version below the current one is read by
 * whatever this build understands of it, which today is one version and is why
 * there is no reader table yet: adding one is where the second version goes.
 */

import type { SelectionCommand, SelectionRect, BrushStroke } from '../../core/document/selection-command.ts';
import type { CoverageMask } from '../../core/document/coverage-mask.ts';
import type { RefineSettings } from '../../core/mask/refine-params.ts';
import type { MediaIdentity } from './media-identity.ts';

/** "ROTYL" and a zero, so a text editor says what this is and a sniff is exact. */
const MAGIC = [0x52, 0x4f, 0x54, 0x59, 0x4c, 0x00] as const;

/** Magic, version and header length. */
const PREFIX_BYTES = 12;

export const DOCUMENT_VERSION = 1;

export const DOCUMENT_EXTENSION = 'rotyl';

/**
 * What is in the document, and what is in the tool.
 *
 * THE STYLE IS IN THE DOCUMENT, which refines what `docs/interface.md` says
 * rather than contradicting it. Closing a file keeps the style because closing
 * is the absence of information and re-picking a palette on every photograph
 * would be the tool forgetting what it was told. Opening a document is the
 * presence of information, and a document that reopened under somebody else's
 * palette would not be showing what was saved. The tie-breaker is export: it
 * replays the log at the style the app is set to, so a document carrying the
 * log and not the style saves half of what the picture depends on.
 *
 * THE PLAYHEAD AND THE RANGE ARE IN IT. Both are statements about this clip
 * that somebody made on purpose, and reopening ten minutes of tracking at frame
 * 0 loses the one thing that costs a scrub to find again.
 *
 * THE VIEW IS NOT. Zoom and pan are fitted against a canvas whose size belongs
 * to the window rather than to the work, so a document reopened in a smaller
 * window would restore a pan into empty space. It is already treated that way:
 * `use-rotyl.ts` carries the view across a lost device separately from the
 * document, because the document is the work and the view is where somebody was
 * standing.
 *
 * AND THE REDO TAIL IS NOT. A document is work that was done; a redo tail is
 * work that was undone, and `SelectionDocument.apply` discards it on the next
 * edit anyway, so a saved one would vanish the moment anybody drew.
 */
export interface RotylDocument {
  readonly media: MediaIdentity;
  /** The applied commands, oldest first. Never the redo tail. */
  readonly commands: readonly SelectionCommand[];
  /** Where the playhead was. Zero on a photograph. */
  readonly frame: number;
  /** Which frames a clip export writes, where one was marked. */
  readonly range?: { readonly from: number; readonly to: number };
  readonly style: { readonly id: string; readonly controls: Readonly<Record<string, number>> };
}

export type DocumentReadError =
  | { readonly kind: 'not-a-document' }
  | { readonly kind: 'from-a-newer-version'; readonly version: number }
  | { readonly kind: 'damaged'; readonly detail: string };

export function describeDocumentReadError(error: DocumentReadError): string {
  switch (error.kind) {
    case 'from-a-newer-version':
      // Named rather than described, because the only thing anybody can do
      // about it is find the build that wrote it.
      return `That document was written by a newer version of Rotyl (format ${String(error.version)}, this build reads ${String(DOCUMENT_VERSION)}).`;
    case 'damaged':
      return `That document could not be read: ${error.detail}.`;
    default:
      return 'That file is not a Rotyl document.';
  }
}

/** Whether the bytes are a document at all, before any of it is parsed. */
export async function looksLikeDocument(file: Blob): Promise<boolean> {
  try {
    const header = new Uint8Array(await file.slice(0, MAGIC.length).arrayBuffer());
    return MAGIC.every((byte, index) => header[index] === byte);
  } catch {
    return false;
  }
}

/** What a document is called, given what it was made against. */
export function documentFilename(mediaName: string): string {
  const stem = mediaName.replace(/\.[^.]+$/, '') || 'selection';
  return `${stem}.${DOCUMENT_EXTENSION}`;
}

/**
 * The document as a sequence of chunks, so nothing has to be assembled.
 *
 * CHUNKS RATHER THAN ONE BUFFER, for the reason a clip export writes each
 * packet as its chunk closes rather than holding the file: a ten-minute tracked
 * run is 62 MB of packed masks per object followed that the log is already
 * holding, and assembling a second copy of them to write the first one would
 * hold the document twice at the moment it is saved. Given a file handle each
 * chunk goes straight out and nothing is held; given none, a `Blob` takes the
 * list and the browser decides where to keep it. One writer, two targets, one
 * line different, which is the same shape the export sink has.
 *
 * The mask payloads are the log's own arrays, handed over rather than copied,
 * so this allocates the header and nothing else.
 */
/** Nothing, without allocating a fresh one every time a stroke is written. */
const NO_PAYLOAD = new Uint8Array(new ArrayBuffer(0));

/**
 * One command, split into the part that is JSON and the part that is not.
 *
 * Exported because a document is not the only thing that writes commands down.
 * The crash journal appends them one at a time into a file of its own, and two
 * encodings of the same command would be two places to get the mask's offset
 * wrong. `at` is where this command's mask will live in whatever payload region
 * the caller is building: a document concatenates them all, and a journal gives
 * each record a region of its own and passes zero.
 */
export function commandToWire(
  command: SelectionCommand,
  at: number,
): { readonly wire: unknown; readonly payload: Uint8Array<ArrayBuffer> } {
  if (command.kind !== 'applyMask') return { wire: command, payload: NO_PAYLOAD };
  const { mask, ...rest } = command;
  return {
    wire: { ...rest, mask: { width: mask.width, height: mask.height, at, length: mask.packed.length } },
    payload: mask.packed,
  };
}

/**
 * Everything a document says that is not a command: which file, where the
 * playhead was, which part is exported, and what it looked like.
 *
 * Exported and named because the crash journal writes exactly this, as one
 * record, and a second reader for the same four fields would be a second place
 * for them to drift. Throws on anything it does not recognise, like every other
 * reader here, because all of it comes off a disk.
 */
export function documentStateFromWire(wire: unknown): Omit<RotylDocument, 'commands'> {
  const raw = object(wire, 'the document state');
  const style = object(raw.style, 'the style');
  const range = raw.range === undefined ? undefined : object(raw.range, 'the range');
  return {
    media: asMedia(raw.media),
    frame: integer(raw.frame, 'the frame'),
    ...(range
      ? { range: { from: integer(range.from, 'the range start'), to: integer(range.to, 'the range end') } }
      : {}),
    style: { id: string(style.id, 'the style id'), controls: asControls(style.controls) },
  };
}

/** One command back, reading its mask out of `payload`. See `commandToWire`. */
export function commandFromWire(wire: unknown, payload: Uint8Array<ArrayBuffer>): SelectionCommand {
  return asCommand(wire, payload);
}

export function writeDocument(document: RotylDocument): readonly Uint8Array<ArrayBuffer>[] {
  const payloads: Uint8Array<ArrayBuffer>[] = [];
  let at = 0;

  const commands = document.commands.map((command) => {
    const { wire, payload } = commandToWire(command, at);
    if (payload.length > 0) {
      payloads.push(payload);
      at += payload.length;
    }
    return wire;
  });

  const header = new TextEncoder().encode(
    JSON.stringify({
      media: document.media,
      frame: document.frame,
      ...(document.range ? { range: document.range } : {}),
      style: document.style,
      commands,
    }),
  );

  const prefix = new Uint8Array(PREFIX_BYTES);
  prefix.set(MAGIC, 0);
  const view = new DataView(prefix.buffer);
  view.setUint16(6, DOCUMENT_VERSION, true);
  view.setUint32(8, header.length, true);

  return [prefix, header, ...payloads];
}

/**
 * A file that says it is a document but is not one this can use.
 *
 * Thrown internally and caught once at the top rather than threaded back
 * through thirty call sites as a result. Every field below comes off a disk and
 * has to be CHECKED rather than asserted: the failure an unchecked header
 * produces is a stroke at NaN or a mask sliced past the end of the payload,
 * which replays as a picture rather than as an error.
 */
class Damaged extends Error {}

/**
 * A predicate rather than an assertion, so nothing below is a cast.
 *
 * Every value here comes off a disk, and a cast is precisely the thing that
 * would let a header say whatever it liked. Narrowing through a guard costs one
 * function and means the compiler is checking the reader rather than being told
 * to trust it.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Damaged(`${what} is not an object`);
  return value;
}

function number(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Damaged(`${what} is not a number`);
  return value;
}

function integer(value: unknown, what: string): number {
  const found = number(value, what);
  if (!Number.isInteger(found) || found < 0) throw new Damaged(`${what} is not a frame number`);
  return found;
}

function string(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Damaged(`${what} is not text`);
  return value;
}

/**
 * A field that is only ever written when it is true, checked as that.
 *
 * `absent` is present or it is not, and `false` would be a third state meaning
 * the same as the first: a reader that accepted one would let two documents say
 * the same thing two ways. Refusing it now, while there is one version of this
 * format, is cheaper than deciding later which of the two an old file meant.
 */
function flag(value: unknown, what: string): true {
  if (value !== true) throw new Damaged(`${what} is not set`);
  return true;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  const found = string(value, what);
  const match = allowed.find((candidate) => candidate === found);
  if (match === undefined) throw new Damaged(`${what} is ${found}`);
  return match;
}

function asStroke(value: unknown): BrushStroke {
  const raw = object(value, 'a stroke');
  const points = raw.points;
  if (!Array.isArray(points)) throw new Damaged('a stroke has no points');
  return {
    points: points.map((point) => {
      const at = object(point, 'a stroke point');
      return { x: number(at.x, 'a stroke x'), y: number(at.y, 'a stroke y') };
    }),
    radius: number(raw.radius, 'a stroke radius'),
    hardness: number(raw.hardness, 'a stroke hardness'),
  };
}

function asRect(value: unknown): SelectionRect {
  const raw = object(value, 'a rectangle');
  return {
    x0: number(raw.x0, 'a rectangle x0'),
    y0: number(raw.y0, 'a rectangle y0'),
    x1: number(raw.x1, 'a rectangle x1'),
    y1: number(raw.y1, 'a rectangle y1'),
  };
}

function asRefine(value: unknown): RefineSettings {
  const raw = object(value, 'refine settings');
  return {
    windowFraction: number(raw.windowFraction, 'a window fraction'),
    epsilon: number(raw.epsilon, 'an epsilon'),
    firmness: number(raw.firmness, 'a firmness'),
  };
}

/**
 * A mask, as a view into the payload region rather than as a copy of it.
 *
 * `subarray` and not `slice`, which is what makes reading a ten-minute document
 * one allocation: the log ends up pointing at the same buffer the file was read
 * into, exactly as it pointed at the buffer the tracker produced.
 */
function asMask(value: unknown, payload: Uint8Array<ArrayBuffer>): CoverageMask {
  const raw = object(value, 'a mask');
  const width = integer(raw.width, 'a mask width');
  const height = integer(raw.height, 'a mask height');
  const at = integer(raw.at, 'a mask offset');
  const length = integer(raw.length, 'a mask length');
  if (at + length > payload.length) throw new Damaged('a mask reaches past the end of the file');
  if (width === 0 || height === 0) throw new Damaged('a mask has no size');
  return { width, height, packed: payload.subarray(at, at + length) };
}

function asCommand(value: unknown, payload: Uint8Array<ArrayBuffer>): SelectionCommand {
  const raw = object(value, 'a command');
  const frame = integer(raw.frame, 'a command frame');
  // Absent on everything but a tracking run, so absent rather than defaulted:
  // a group of one on every stroke would weld two neighbouring edits into one
  // undo the first time somebody saved and reopened.
  const base = raw.group === undefined ? { frame } : { frame, group: integer(raw.group, 'a group') };

  switch (raw.kind) {
    case 'clear':
      return { ...base, kind: 'clear' };
    case 'invert':
      return { ...base, kind: 'invert' };
    case 'paint':
      return { ...base, kind: 'paint', stroke: asStroke(raw.stroke) };
    case 'erase':
      return { ...base, kind: 'erase', stroke: asStroke(raw.stroke) };
    case 'rect':
      return {
        ...base,
        kind: 'rect',
        rect: asRect(raw.rect),
        mode: oneOf(raw.mode, ['paint', 'erase'] as const, 'a rectangle mode'),
      };
    case 'applyMask':
      return {
        ...base,
        kind: 'applyMask',
        mask: asMask(raw.mask, payload),
        op: oneOf(raw.op, ['replace', 'add', 'subtract'] as const, 'a mask operation'),
        ...(raw.refine === undefined ? {} : { refine: asRefine(raw.refine) }),
        // The one field here that is about how the command came to be rather
        // than about what it does, and the reason it is in the file at all:
        // a mask the model said the object was not in is empty, an empty mask
        // is what an erased selection also is, and a document that dropped the
        // difference would reopen unable to say which of the two it held.
        ...(raw.absent === undefined ? {} : { absent: flag(raw.absent, 'an absence') }),
      };
    default:
      throw new Damaged(`a command of kind ${String(raw.kind)}`);
  }
}

function asMedia(value: unknown): MediaIdentity {
  const raw = object(value, 'the media');
  return {
    name: string(raw.name, 'the media name'),
    bytes: integer(raw.bytes, 'the media size'),
    width: integer(raw.width, 'the media width'),
    height: integer(raw.height, 'the media height'),
    frames: integer(raw.frames, 'the media frame count'),
    digest: string(raw.digest, 'the media digest'),
  };
}

function asControls(value: unknown): Record<string, number> {
  const raw = object(value, 'the style controls');
  const out: Record<string, number> = {};
  for (const [key, setting] of Object.entries(raw)) out[key] = number(setting, `the ${key} control`);
  return out;
}

export function readDocument(
  bytes: Uint8Array<ArrayBuffer>,
): { ok: true; value: RotylDocument } | { ok: false; error: DocumentReadError } {
  if (bytes.length < PREFIX_BYTES || !MAGIC.every((byte, index) => bytes[index] === byte)) {
    return { ok: false, error: { kind: 'not-a-document' } };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(6, true);
  // Refused by version before anything is parsed, for the same reason HEIC is
  // refused by signature: a format this build does not know produces a mask of
  // roughly the right shape if it is guessed at, and a plausible wrong answer
  // is worse than a sentence.
  if (version > DOCUMENT_VERSION) return { ok: false, error: { kind: 'from-a-newer-version', version } };

  const headerLength = view.getUint32(8, true);
  if (PREFIX_BYTES + headerLength > bytes.length) {
    return { ok: false, error: { kind: 'damaged', detail: 'the header is longer than the file' } };
  }

  try {
    const header = object(
      JSON.parse(new TextDecoder().decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength))),
      'the header',
    );
    const payload = bytes.subarray(PREFIX_BYTES + headerLength);
    const raw = header.commands;
    if (!Array.isArray(raw)) throw new Damaged('the header has no commands');

    return {
      ok: true,
      value: {
        ...documentStateFromWire(header),
        commands: raw.map((entry) => asCommand(entry, payload)),
      },
    };
  } catch (cause) {
    if (cause instanceof Damaged) return { ok: false, error: { kind: 'damaged', detail: cause.message } };
    // A JSON.parse failure, which says something true and unhelpful about a
    // character position. The useful part is that the header is not readable.
    return { ok: false, error: { kind: 'damaged', detail: 'the header is not readable' } };
  }
}
