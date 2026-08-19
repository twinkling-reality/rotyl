/**
 * The bookkeeping a memory bank is, with no model in it.
 *
 * A tracked frame is two graphs and a pile of arithmetic, and the arithmetic is
 * where a tracker goes quietly wrong. It is here rather than in the platform
 * layer because none of it needs a GPU, a runtime or a browser: it is a fixed
 * layout, a sine table and three lines of scaling, all of which can be checked
 * against the reference implementation by a unit test rather than by looking at
 * a mask and deciding it seems about right.
 *
 * WHAT THE BANK IS. `memory_attention` accepts one shape and only one: 3648
 * tokens of 64 dimensions, being seven spatial entries of 512 tokens each and a
 * block of 64 at the end for object pointers. The reference concatenates only
 * as many entries as it has, which would be a different graph shape per frame
 * and, on a WebGPU backend, a pipeline recompile with each one. So the bank is
 * always full size and the entries that do not exist are masked out of the
 * cross-attention, which is what `keyMask` is. Softmax with a masked key is
 * softmax without it.
 *
 * WHERE AN ENTRY GOES IS NOT WHERE IT ARRIVED. Real entries take the first
 * slots so their rotary frequencies are the ones the reference would have given
 * them, and the pointer block sits at the end, where the graph's
 * `num_k_exclude_rope` expects it. Anything else lands in the right shape and
 * the wrong positions, which produces a mask rather than an error.
 */

/** Tokens one memory entry occupies after the spatial perceiver. */
export const TOKENS_PER_MEMORY = 512;
/** Entries the bank holds, from the checkpoint's `num_maskmem`. */
export const MEMORY_ENTRIES = 7;
/** Tokens the pointer block occupies: sixteen pointers of four tokens each. */
export const POINTER_TOKENS = 64;
/** Dimensions of a memory token, from the checkpoint's `mem_dim`. */
export const MEMORY_DIM = 64;

export const MEMORY_TOKENS = MEMORY_ENTRIES * TOKENS_PER_MEMORY + POINTER_TOKENS;

/**
 * What a masked key is worth, before the softmax.
 *
 * Large and negative rather than negative infinity: a row that is entirely
 * masked would be all infinities, and softmax over those is NaN rather than
 * zero. There is no such row here, because a bank with no entries at all never
 * reaches attention, but the value costs nothing and the failure it avoids is
 * silent.
 */
const MASKED = -1e4;

/** One frame's memory, as the encoder gave it up. */
export interface MemoryEntry {
  /** `memory_features`, 512 tokens of 64. */
  readonly features: Float32Array;
  /** `memory_positions`, the spatial position of each of those tokens. */
  readonly positions: Float32Array;
}

export interface BankInput {
  readonly memory: Float32Array;
  readonly positions: Float32Array;
  readonly keyMask: Float32Array;
}

/**
 * Lay a bank of entries out at the one shape the graph accepts.
 *
 * `entries` is newest LAST, which is the order a run produces them in and the
 * order the temporal encoding below assumes.
 *
 * The temporal row an entry gets is how many frames back it is, and that is the
 * parameter this codebase went looking for and did not find written down: the
 * encoder returns where a token is in the picture, and the checkpoint's
 * `memory_temporal_positional_encoding` says when. Added to the spatial
 * position rather than concatenated, which is what the reference does and what
 * makes the two commensurate.
 */
export function layOutBank(
  entries: readonly MemoryEntry[],
  temporal: Float32Array,
  keep = MEMORY_ENTRIES,
): BankInput {
  const memory = new Float32Array(MEMORY_TOKENS * MEMORY_DIM);
  const positions = new Float32Array(MEMORY_TOKENS * MEMORY_DIM);
  const keyMask = new Float32Array(MEMORY_TOKENS).fill(MASKED);

  // Oldest first into the low slots, keeping the most recent `keep` of them,
  // which is what the reference's window comes to once a run only ever moves
  // forward and every frame is a tracked one.
  const held = entries.slice(-keep);
  held.forEach((entry, index) => {
    const at = index * TOKENS_PER_MEMORY * MEMORY_DIM;
    memory.set(entry.features, at);

    // How many frames back this entry is, counting the newest as one, which is
    // the row the reference indexes with `relative_temporal_offset - 1`.
    const age = held.length - index - 1;
    const row = Math.min(age, MEMORY_ENTRIES - 1) * MEMORY_DIM;
    for (let token = 0; token < TOKENS_PER_MEMORY; token++) {
      const into = at + token * MEMORY_DIM;
      for (let channel = 0; channel < MEMORY_DIM; channel++) {
        positions[into + channel] =
          (entry.positions[token * MEMORY_DIM + channel] ?? 0) + (temporal[row + channel] ?? 0);
      }
    }
    keyMask.fill(0, index * TOKENS_PER_MEMORY, (index + 1) * TOKENS_PER_MEMORY);
  });

  // The pointer block stays masked. The published mask decoder does not expose
  // `object_pointer`, so there is nothing to put in it; what that costs is one
  // frame on the way back from an occlusion, measured, in tools/edgetam-export.
  return { memory, positions, keyMask };
}

/**
 * The mask the memory encoder wants, from the mask the decoder produced.
 *
 * Three lines the reference does either side of the graph, kept out of it so
 * the graph has one meaning rather than a mode. A mask that came from a click
 * is thresholded, because the user has already decided; one that came from a
 * previous frame's prediction is passed through a sigmoid, because the model
 * has not. Both are then scaled and shifted by two constants from the config.
 */
export function maskForMemory(
  logits: Float32Array,
  fromPrompt: boolean,
  scale: number,
  bias: number,
): Float32Array {
  const out = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const value = logits[i] ?? 0;
    const decided = fromPrompt ? (value > 0 ? 1 : 0) : 1 / (1 + Math.exp(-value));
    out[i] = decided * scale + bias;
  }
  return out;
}

/**
 * The vision position encoding, which is 4 MB and should be computed rather
 * than served.
 *
 * It takes no input beyond the size of the feature grid, so it is the same
 * tensor on every frame of every clip, and shipping it would add a third of the
 * attention graph's whole size for something a loop produces in a millisecond.
 *
 * Laid out as memory attention takes it: token-major, `channels` contiguous per
 * token, token index being y times the width plus x. The reference reaches the
 * same layout by flattening an NxCxHxW tensor and permuting it, which is worth
 * knowing because getting that transpose backwards produces a plausible field
 * with the axes swapped and no error anywhere.
 */
export function visionPositionEncoding(
  width: number,
  height: number,
  channels: number,
  temperature = 10000,
): Float32Array {
  const features = channels / 2;
  const scale = 2 * Math.PI;
  const out = new Float32Array(width * height * channels);

  // The reference divides each index by the last one, so the grid is one-based
  // and normalised to end at exactly `scale`.
  const frequencies = new Float32Array(features);
  for (let i = 0; i < features; i++) {
    frequencies[i] = temperature ** ((2 * Math.floor(i / 2)) / features);
  }

  for (let y = 0; y < height; y++) {
    const down = ((y + 1) / (height + 1e-6)) * scale;
    for (let x = 0; x < width; x++) {
      const across = ((x + 1) / (width + 1e-6)) * scale;
      const token = (y * width + x) * channels;
      // y first and then x, which is the order the reference concatenates them
      // in, and each pair is a sine and the cosine that follows it.
      for (let i = 0; i < features; i += 2) {
        const yi = down / (frequencies[i] ?? 1);
        const yj = down / (frequencies[i + 1] ?? 1);
        out[token + i] = Math.sin(yi);
        out[token + i + 1] = Math.cos(yj);
        const xi = across / (frequencies[i] ?? 1);
        const xj = across / (frequencies[i + 1] ?? 1);
        out[token + features + i] = Math.sin(xi);
        out[token + features + i + 1] = Math.cos(xj);
      }
    }
  }
  return out;
}
