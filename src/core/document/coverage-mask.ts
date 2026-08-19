/**
 * A mask small enough that a log can hold three hundred of them.
 *
 * Strokes are cheap to keep because a stroke is a few dozen numbers. A mask is
 * not: the segmentation engine answers at 256 px square whatever the photograph
 * is, which is 64 KB, and that was fine while a mask arrived once per click.
 * Tracking contributes one per frame it has followed the object to, so ten
 * seconds is 20 MB and ten minutes is 1.2 GB, and the log stops being the cheap
 * source of truth that undo and device-loss recovery depend on.
 *
 * So the mask changes shape and the document model does not. Nothing else about
 * the log moves: a mask is still a resolution-independent statement about the
 * image, replaying it still reconstructs a boundary rather than magnifying one,
 * and the command that carries it is the same command.
 *
 * PACKBITS, which is a control byte followed by either a repeat or a run of
 * literals. Measured against the alternative, pairs of a value and a length:
 * on a crisp boundary the two are the same size to within a fifth of a per
 * cent, so the realistic case does not decide it. Two other things do.
 *
 * A WIDE RAMP, which is what an engine produces where it is unsure rather than
 * where it is confident, costs pairs two bytes for every pixel of it. Measured
 * on a boundary six texels across, pairs give 9.2 times and this gives 11.8.
 * That case is not exotic: `edgetam-engine.ts` maps the decision boundary to
 * clearly-decided over its whole range on purpose, so a confident edge crosses
 * it within a texel and an ambiguous region never leaves it.
 *
 * AND IT CANNOT LOSE. Pairs double the size of a mask that alternates every
 * pixel; the worst this can do is one byte in every 128. The masks in a log
 * come from a model rather than from a person, so neither of those is a case
 * anybody would meet on purpose, and an encoding with an unbounded bad case is
 * still a worse thing to keep in the one structure the document cannot rebuild.
 */

export interface CoverageMask {
  readonly width: number;
  readonly height: number;
  /**
   * Row-major coverage, 0 to 255, packed.
   *
   * A control byte under 128 introduces that many literal bytes plus one; a
   * control byte over 128 repeats the byte after it 257 minus the control
   * times. 128 is a no-op and is never written. Rows are not delimited: they
   * are `width` apart in what comes back, and a run is free to cross one,
   * which is worth about a tenth of the size on a mask this shape.
   */
  readonly packed: Uint8Array;
}

/** Longest repeat, and longest run of literals, a control byte can describe. */
const MOST = 128;

export function packCoverage(width: number, height: number, coverage: Uint8Array): CoverageMask {
  const length = width * height;
  if (coverage.length !== length) {
    throw new Error(
      `packCoverage: ${String(coverage.length)} bytes for a ${String(width)}x${String(height)} mask`,
    );
  }

  // Worst case is a control byte per 128 literals, so this is allocated once
  // and sliced rather than grown.
  const out = new Uint8Array(length + Math.ceil(length / MOST) + 1);
  let written = 0;
  let at = 0;

  while (at < length) {
    let repeat = 1;
    while (at + repeat < length && repeat < MOST && coverage[at + repeat] === coverage[at]) repeat++;

    // THREE, NOT TWO, and that is what bounds the worst case. A pair costs two
    // bytes either way, but taking it as a repeat also ends the run of literals
    // around it and buys a second control byte for the one that follows. An
    // encoder that breaks at two turns a mask alternating between singles and
    // pairs into four bytes for every three, where this cannot exceed one byte
    // in every 128 whatever it is handed.
    if (repeat >= 3) {
      out[written++] = 257 - repeat;
      out[written++] = coverage[at] ?? 0;
      at += repeat;
      continue;
    }

    // Literals until a repeat worth breaking for begins. There is no run of
    // three at `at`, or the branch above would have taken it, so this always
    // advances.
    let end = at;
    while (end < length && end - at < MOST) {
      if (
        end + 2 < length &&
        coverage[end] === coverage[end + 1] &&
        coverage[end + 1] === coverage[end + 2]
      ) {
        break;
      }
      end++;
    }
    out[written++] = end - at - 1;
    out.set(coverage.subarray(at, end), written);
    written += end - at;
    at = end;
  }

  return { width, height, packed: out.slice(0, written) };
}

/**
 * The bytes back, row-major, for the two things that want random access: the
 * texture upload on replay and the overlap between two candidates.
 *
 * `into` because a replay expands one of these per command and a tracked clip
 * has one per frame, so the caller holds a buffer rather than leaving several
 * hundred 64 KB arrays a frame for the collector to find.
 */
export function expandCoverage(mask: CoverageMask, into?: Uint8Array): Uint8Array {
  const length = mask.width * mask.height;
  if (into && into.length < length) {
    throw new Error(`expandCoverage: a ${String(into.length)} byte buffer for ${String(length)} bytes`);
  }
  const out = into ?? new Uint8Array(length);

  let at = 0;
  let written = 0;
  while (at < mask.packed.length && written < length) {
    const control = mask.packed[at++] ?? 0;
    if (control < MOST) {
      const count = Math.min(control + 1, length - written);
      out.set(mask.packed.subarray(at, at + count), written);
      at += control + 1;
      written += count;
    } else if (control > MOST) {
      const count = Math.min(257 - control, length - written);
      out.fill(mask.packed[at++] ?? 0, written, written + count);
      written += count;
    }
  }

  return out;
}

/** How much of a mask is covered at or above `solid`, as a fraction. */
export function packedArea(mask: CoverageMask, solid: number): number {
  let inside = 0;
  let at = 0;
  while (at < mask.packed.length) {
    const control = mask.packed[at++] ?? 0;
    if (control < MOST) {
      const count = control + 1;
      for (let i = 0; i < count; i++) if ((mask.packed[at + i] ?? 0) >= solid) inside++;
      at += count;
    } else if (control > MOST) {
      if ((mask.packed[at++] ?? 0) >= solid) inside += 257 - control;
    }
  }
  return inside / Math.max(1, mask.width * mask.height);
}
