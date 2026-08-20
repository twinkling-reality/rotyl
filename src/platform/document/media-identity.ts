/**
 * Which file a saved document belongs to, in a place with no paths.
 *
 * A browser cannot address the media. There is no path to record and no way to
 * reopen one, so a document says what it was made against and the person
 * supplies the file again. That leaves exactly one question worth engineering:
 * whether the file they supplied is the one it was made against, because a
 * selection replayed over the wrong clip is a wrong answer that looks like a
 * right one.
 *
 * THE WHOLE FILE IS NOT HASHABLE HERE, and that is a fact about the platform
 * rather than a budget. `crypto.subtle.digest` takes a BufferSource and not a
 * stream, so digesting two gigabytes means holding two gigabytes, which is the
 * exact mistake `docs/limits.md` measures a clip export making. There is no
 * incremental SHA-256 in a browser and adding one is a dependency to answer a
 * question a kilobyte of probe answers. See `/research/the-document.html` for
 * what a digest costs per megabyte and what that comes to on a real clip.
 *
 * SO THE PROBE IS BOUNDED AND THE SHAPE IS FREE. Two things are compared and
 * they fail differently:
 *
 *   THE SHAPE, which is the dimensions and the frame count, is read from the
 *     open file at no cost because the loader already read it. A file of a
 *     different shape cannot replay the log at all: frame 1043 may not exist
 *     and a stroke at (3000, 2000) may be off the image. That is a fact rather
 *     than a suspicion, so it is refused.
 *
 *   THE BYTES, which are a digest over the first and last megabyte and the
 *     length. A file of the same shape and different bytes replays perfectly
 *     and may be a re-encode of the same clip, which is an ordinary thing to
 *     have done. So it opens, and says so, in the row beside the file's name
 *     where the soundtrack warning lives, because it is a fact about the open
 *     file rather than something that just happened.
 *
 * What a bounded probe cannot see is a file that agrees at both ends and in
 * length and differs in the middle. On media that is a re-encode with the same
 * container layout and the same byte count, which is not something anybody
 * arrives at by accident. It is in `docs/limits.md` rather than left implied.
 *
 * The NAME is recorded and is not part of the comparison. A renamed file is the
 * same file, and the name is what the interface asks for when it has a document
 * and no media to go with it.
 */

/**
 * How much of each end goes into the digest.
 *
 * A megabyte at each end reaches past every container's header and index on the
 * way in and past the last of the media on the way out, so two different clips
 * of the same shape disagree here even when one is a prefix of the other.
 */
const PROBE_BYTES = 1 << 20;

/** What a document records about the file it was made against. */
export interface MediaIdentity {
  readonly name: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** 1 for a photograph, the container's own frame count for a clip. */
  readonly frames: number;
  /** Hex SHA-256 over the first megabyte, the last megabyte and the length. */
  readonly digest: string;
}

function hex(buffer: ArrayBuffer): string {
  let out = '';
  for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * The digest of a file, without holding the file.
 *
 * Two slices and eight bytes of length, whatever the file is, so this costs the
 * same on a photograph and on a two gigabyte clip. Below two megabytes the two
 * slices meet and the whole file is digested, which is the strong answer
 * arriving for free on the files small enough to give it away.
 */
export async function digestMedia(file: Blob): Promise<string> {
  const length = file.size;
  const head = new Uint8Array(await file.slice(0, Math.min(PROBE_BYTES, length)).arrayBuffer());
  // Starting at PROBE_BYTES rather than at length - PROBE_BYTES so the two
  // slices never overlap on a file between one and two megabytes: digesting the
  // same bytes twice is not wrong, and reading them twice is work for nothing.
  const tail =
    length > PROBE_BYTES
      ? new Uint8Array(await file.slice(Math.max(PROBE_BYTES, length - PROBE_BYTES)).arrayBuffer())
      : new Uint8Array(0);

  const probe = new Uint8Array(head.length + tail.length + 8);
  probe.set(head, 0);
  probe.set(tail, head.length);
  // The length, so a truncated file cannot digest the same as a whole one that
  // happens to share both ends.
  new DataView(probe.buffer).setBigUint64(head.length + tail.length, BigInt(length));

  return hex(await crypto.subtle.digest('SHA-256', probe));
}

/**
 * What the file somebody supplied is, relative to the one a document names.
 *
 * Three answers rather than two, because the two ways of being wrong want
 * opposite treatment and folding them together would either refuse a re-encode
 * somebody meant to open or replay a log over a picture it was never drawn on.
 */
export type MediaMatch =
  /** The same file. */
  | 'same'
  /** The same shape, different bytes: replayable, and worth saying. */
  | 'restyled'
  /** A different shape: the log does not describe this picture. */
  | 'wrong';

export function compareMedia(saved: MediaIdentity, opened: MediaIdentity): MediaMatch {
  if (saved.width !== opened.width || saved.height !== opened.height || saved.frames !== opened.frames) {
    return 'wrong';
  }
  if (saved.bytes !== opened.bytes || saved.digest !== opened.digest) return 'restyled';
  return 'same';
}
