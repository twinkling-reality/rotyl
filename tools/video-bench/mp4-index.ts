// The sample tables of a finished MP4, read the way a player reads them.
//
// WHY A PARSER AND NOT THE DEMUXER. mediabunny will hand back every packet of a
// file and says nothing about WHERE in the file each one is, which is the only
// question measurement 11 asks. A player answers it out of `stco`, `stsc`,
// `stsz` and `stts`, so this reads the same four boxes and reports, for every
// sample, the byte it starts at and the moment it plays.
//
// Outside src/ deliberately, like everything else in this directory: nothing in
// Rotyl reads a container by hand, and nothing here should end up doing so.

/** One sample: when it plays, where it is, and how long it is. */
export interface IndexedSample {
  readonly seconds: number;
  readonly offset: number;
  readonly size: number;
}

export interface IndexedTrack {
  readonly kind: 'video' | 'audio' | 'other';
  readonly timescale: number;
  readonly samples: readonly IndexedSample[];
}

/** The top-level boxes in order, which is where "the index is at the front" is settled. */
export interface Mp4Index {
  readonly boxes: readonly { readonly type: string; readonly bytes: number }[];
  readonly tracks: readonly IndexedTrack[];
}

interface Box {
  readonly type: string;
  /** The payload, without the header. */
  readonly body: Uint8Array;
  /** Where the whole box starts in its parent's coordinates. */
  readonly start: number;
  readonly size: number;
}

const HANDLERS: Record<string, IndexedTrack['kind']> = { vide: 'video', soun: 'audio' };

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The boxes directly inside `bytes`.
 *
 * Stops rather than throws on a length it cannot make sense of: a truncated
 * file is a thing this can be handed, and half an answer plus the box order is
 * more use than an exception.
 */
function children(bytes: Uint8Array): readonly Box[] {
  const data = view(bytes);
  const out: Box[] = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    let size = data.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > bytes.length) break;
      size = Number(data.getBigUint64(at + 8));
      header = 16;
    }
    if (size === 0) size = bytes.length - at;
    if (size < header) break;
    const type = String.fromCharCode(
      bytes[at + 4] ?? 0,
      bytes[at + 5] ?? 0,
      bytes[at + 6] ?? 0,
      bytes[at + 7] ?? 0,
    );
    // A box that runs past the end is reported and then stops the walk, rather
    // than being dropped. The caller that hands over only the front of a file,
    // which is the one that wants the box ORDER and not the media, would
    // otherwise be told the media box is not there at all.
    out.push({ type, body: bytes.subarray(at + header, Math.min(at + size, bytes.length)), start: at, size });
    if (at + size > bytes.length) break;
    at += size;
  }
  return out;
}

function find(boxes: readonly Box[], type: string): Box | undefined {
  return boxes.find((box) => box.type === type);
}

/** A box reached by name through however many containers. */
function descend(bytes: Uint8Array, path: readonly string[]): Box | undefined {
  let boxes = children(bytes);
  let found: Box | undefined;
  for (const step of path) {
    found = find(boxes, step);
    if (!found) return undefined;
    boxes = children(found.body);
  }
  return found;
}

/** stts: runs of (count, delta) in the track's own timescale, in decode order. */
function decodeTimes(stts: Uint8Array, count: number): Float64Array {
  const data = view(stts);
  const entries = data.getUint32(4);
  const times = new Float64Array(count);
  let sample = 0;
  let now = 0;
  for (let entry = 0; entry < entries; entry++) {
    const runs = data.getUint32(8 + entry * 8);
    const delta = data.getUint32(12 + entry * 8);
    for (let i = 0; i < runs && sample < count; i++) {
      times[sample++] = now;
      now += delta;
    }
  }
  return times;
}

/** stsz, or stz2 in its compact form. Returns one length per sample. */
function sampleSizes(stbl: readonly Box[]): Uint32Array {
  const stsz = find(stbl, 'stsz');
  if (stsz) {
    const data = view(stsz.body);
    const uniform = data.getUint32(4);
    const count = data.getUint32(8);
    const sizes = new Uint32Array(count);
    if (uniform !== 0) return sizes.fill(uniform);
    for (let i = 0; i < count; i++) sizes[i] = data.getUint32(12 + i * 4);
    return sizes;
  }
  const stz2 = find(stbl, 'stz2');
  if (!stz2) return new Uint32Array(0);
  const data = view(stz2.body);
  const width = data.getUint8(7);
  const count = data.getUint32(8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    if (width === 16) sizes[i] = data.getUint16(12 + i * 2);
    else if (width === 8) sizes[i] = data.getUint8(12 + i);
    else {
      // Four-bit fields, two to a byte, high nibble first.
      const byte = data.getUint8(12 + (i >> 1));
      sizes[i] = (i & 1) === 0 ? byte >> 4 : byte & 0xf;
    }
  }
  return sizes;
}

function chunkOffsets(stbl: readonly Box[]): Float64Array {
  const stco = find(stbl, 'stco');
  if (stco) {
    const data = view(stco.body);
    const count = data.getUint32(4);
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) out[i] = data.getUint32(8 + i * 4);
    return out;
  }
  const co64 = find(stbl, 'co64');
  if (!co64) return new Float64Array(0);
  const data = view(co64.body);
  const count = data.getUint32(4);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = Number(data.getBigUint64(8 + i * 8));
  return out;
}

/** stsc: how many samples each chunk holds, stated as runs of chunks. */
function samplesPerChunk(stsc: Uint8Array, chunks: number): Uint32Array {
  const data = view(stsc);
  const entries = data.getUint32(4);
  const out = new Uint32Array(chunks);
  for (let entry = 0; entry < entries; entry++) {
    const first = data.getUint32(8 + entry * 12) - 1;
    const per = data.getUint32(12 + entry * 12);
    const next = entry + 1 < entries ? data.getUint32(8 + (entry + 1) * 12) - 1 : chunks;
    for (let chunk = first; chunk < next && chunk < chunks; chunk++) out[chunk] = per;
  }
  return out;
}

function readTrack(trak: Uint8Array): IndexedTrack | undefined {
  const mdia = find(children(trak), 'mdia');
  if (!mdia) return undefined;
  const inside = children(mdia.body);

  const mdhd = find(inside, 'mdhd');
  if (!mdhd) return undefined;
  const mdhdData = view(mdhd.body);
  const version = mdhdData.getUint8(0);
  const timescale = version === 1 ? mdhdData.getUint32(20) : mdhdData.getUint32(12);

  const hdlr = find(inside, 'hdlr');
  const handler = hdlr
    ? String.fromCharCode(hdlr.body[8] ?? 0, hdlr.body[9] ?? 0, hdlr.body[10] ?? 0, hdlr.body[11] ?? 0)
    : '';
  const kind = HANDLERS[handler] ?? 'other';

  const stblBox = descend(mdia.body, ['minf', 'stbl']);
  if (!stblBox) return undefined;
  const stbl = children(stblBox.body);
  const stts = find(stbl, 'stts');
  const stsc = find(stbl, 'stsc');
  if (!stts || !stsc) return undefined;

  const sizes = sampleSizes(stbl);
  const offsets = chunkOffsets(stbl);
  const per = samplesPerChunk(stsc.body, offsets.length);
  const times = decodeTimes(stts.body, sizes.length);

  const samples: IndexedSample[] = [];
  let sample = 0;
  for (let chunk = 0; chunk < offsets.length; chunk++) {
    let at = offsets[chunk] ?? 0;
    const held = per[chunk] ?? 0;
    for (let i = 0; i < held && sample < sizes.length; i++) {
      const size = sizes[sample] ?? 0;
      samples.push({ seconds: (times[sample] ?? 0) / timescale, offset: at, size });
      at += size;
      sample++;
    }
  }
  return { kind, timescale, samples };
}

/**
 * Read a finished MP4's index.
 *
 * Takes the whole file rather than a reader, because everything this is pointed
 * at is a file a measurement just wrote and is already holding.
 */
export function mp4Index(file: Uint8Array): Mp4Index {
  const top = children(file);
  const moov = find(top, 'moov');
  const tracks: IndexedTrack[] = [];
  if (moov) {
    for (const box of children(moov.body)) {
      if (box.type !== 'trak') continue;
      const track = readTrack(box.body);
      if (track) tracks.push(track);
    }
  }
  return {
    boxes: top.map((box) => ({ type: box.type, bytes: box.size })),
    tracks,
  };
}
