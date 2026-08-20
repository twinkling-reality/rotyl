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
 * slots and the pointer block sits at the end, where the graph's
 * `num_k_exclude_rope` expects it: the last 64 keys are the ones it gives no
 * rotary position to. Anything else lands in the right shape and the wrong
 * positions, which produces a mask rather than an error.
 *
 * AND THE BANK IS NOT A SLIDING WINDOW, which is the correction this file cost.
 * The reference holds the frame the object was pointed at plus the six frames
 * before this one, and it never lets go of the first: it is the only entry in
 * the bank that is a decision somebody made rather than the tracker's own
 * opinion of its own previous opinion. Keeping the last seven instead drops it
 * on the eighth frame of a run and quietly turns a tracker into a thing that
 * follows whatever it followed last. `tools/edgetam-export/host.py` reproduces
 * the reference's own bank exactly, to the last bit of every one of its 233,472
 * floats, and does so only with the anchor kept.
 */

/** The feature grid memory attention works over, from the checkpoint. */
export const FEATURE_GRID = 64;
export const FEATURE_TOKENS = FEATURE_GRID * FEATURE_GRID;
/** Dimensions of a vision token, from the checkpoint's `hidden_dim`. */
export const FEATURE_DIM = 256;
/** Resolution the mask decoder answers at, whatever the photograph is. */
export const MASK_SIZE = 256;
/** Resolution the memory encoder declares for the mask it is given. */
export const MEMORY_MASK = 1024;

/** Tokens one memory entry occupies after the spatial perceiver. */
export const TOKENS_PER_MEMORY = 512;
/** Entries the bank holds, from the checkpoint's `num_maskmem`. */
export const MEMORY_ENTRIES = 7;
/** Tokens the pointer block occupies: sixteen pointers of four tokens each. */
export const POINTER_TOKENS = 64;
/**
 * How many tokens one object pointer becomes.
 *
 * A pointer is 256 dimensions and a memory token is 64, so the reference splits
 * each one into four consecutive tokens rather than projecting it. Nothing
 * chooses this: it is `hidden_dim / mem_dim`.
 */
export const POINTER_SPLITS = 4;
/** Pointers the block holds, from the checkpoint's `max_object_pointers_in_encoder`. */
export const MAX_POINTERS = POINTER_TOKENS / POINTER_SPLITS;
/** Dimensions of a memory token, from the checkpoint's `mem_dim`. */
export const MEMORY_DIM = 64;
/** Dimensions of one object pointer, before it is split into tokens. */
export const POINTER_DIM = POINTER_SPLITS * MEMORY_DIM;

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

/** How many tracked frames the bank holds beside the anchor. */
export const RECENT_ENTRIES = MEMORY_ENTRIES - 1;

/**
 * Lay a bank out at the one shape the graph accepts.
 *
 * TWO ARGUMENTS RATHER THAN A LIST, because the reference has two kinds of
 * entry and gives them different times. `anchor` is the frame the object was
 * pointed at, which the reference calls a conditioning frame and never drops;
 * `recent` is the tracked frames since, newest LAST, at most `RECENT_ENTRIES`
 * of them. Handing this one list and letting it work out which is which is what
 * it did first, and it was wrong on the first frame of every run.
 *
 * The temporal row an entry gets is how long ago it is, and that is the
 * parameter this codebase went looking for and did not find written down: the
 * encoder returns where a token is in the picture, and the checkpoint's
 * `memory_temporal_positional_encoding` says when. Added to the spatial
 * position rather than concatenated, which is what the reference does and what
 * makes the two commensurate.
 *
 * THE ANCHOR IS ALWAYS THE OLDEST ROW, whatever else the bank holds. The
 * reference asks for row `relative_temporal_offset - 1` and a conditioning
 * frame's offset is zero, so it indexes from the end and lands on the last row.
 * A run three frames old therefore has its anchor at row six and its two
 * tracked frames at rows one and zero, with the four rows between them unused.
 * Numbering the anchor by its position in a short list gives it row two, which
 * is a bank claiming the user's own frame is more recent than it is.
 */
export function layOutBank(
  anchor: MemoryEntry,
  recent: readonly MemoryEntry[],
  temporal: Float32Array,
  pointers: readonly Float32Array[] = [],
): BankInput {
  const memory = new Float32Array(MEMORY_TOKENS * MEMORY_DIM);
  const positions = new Float32Array(MEMORY_TOKENS * MEMORY_DIM);
  const keyMask = new Float32Array(MEMORY_TOKENS).fill(MASKED);

  const held = [anchor, ...recent.slice(-RECENT_ENTRIES)];
  held.forEach((entry, slot) => {
    const at = slot * TOKENS_PER_MEMORY * MEMORY_DIM;
    memory.set(entry.features, at);

    // The anchor's own row, then the tracked frames counting back from the one
    // before this: the newest takes row zero.
    const age = slot === 0 ? MEMORY_ENTRIES - 1 : held.length - slot - 1;
    const row = Math.min(age, MEMORY_ENTRIES - 1) * MEMORY_DIM;
    for (let token = 0; token < TOKENS_PER_MEMORY; token++) {
      const into = at + token * MEMORY_DIM;
      for (let channel = 0; channel < MEMORY_DIM; channel++) {
        positions[into + channel] =
          (entry.positions[token * MEMORY_DIM + channel] ?? 0) + (temporal[row + channel] ?? 0);
      }
    }
    keyMask.fill(0, slot * TOKENS_PER_MEMORY, (slot + 1) * TOKENS_PER_MEMORY);
  });

  // THE POINTER BLOCK, which sits at the end because that is where the graph's
  // `num_k_exclude_rope` looks for it: the last 64 keys are the ones it does
  // NOT give a rotary position to.
  //
  // THREE THINGS ABOUT IT ARE NOT GUESSABLE and all three are silent if wrong.
  // A pointer is 256 dimensions against a token's 64, so each one becomes four
  // consecutive tokens, which is a split rather than a projection. Its position
  // is ZERO, because this checkpoint has
  // `enable_temporal_pos_encoding_for_object_pointers` off, so the block says
  // what the object looked like and never when. And with no rotary and no
  // position, attention over the block is a sum over a set: the order pointers
  // are laid out in cannot change the answer. They are laid out in the
  // reference's order anyway, so a comparison against it is exact rather than
  // merely equivalent.
  pointers.slice(0, MAX_POINTERS).forEach((pointer, index) => {
    const at = (POINTER_START + index * POINTER_SPLITS) * MEMORY_DIM;
    memory.set(pointer.subarray(0, POINTER_DIM), at);
    keyMask.fill(0, POINTER_START + index * POINTER_SPLITS, POINTER_START + (index + 1) * POINTER_SPLITS);
  });

  return { memory, positions, keyMask };
}

/** Where the pointer block starts, which is after every spatial slot. */
const POINTER_START = MEMORY_ENTRIES * TOKENS_PER_MEMORY;

/**
 * The vision encoder's feature map, with the no-memory embedding taken back
 * off, in the layout memory attention wants.
 *
 * TWO THINGS AT ONCE because they are one pass over four megabytes. The map
 * arrives channel-major as (1, 256, 64, 64) and attention takes it token-major
 * as (4096, 1, 256), and doing the transpose twice to keep the subtraction
 * separate would cost more than the subtraction does.
 *
 * THE SUBTRACTION IS THE ONE THAT IS NOT OBVIOUS. The published vision encoder
 * ADDS `no_memory_embedding` to its last feature map, which is right for a
 * single image, where there is no memory and the model is told so. On a tracked
 * frame memory attention replaces that, so it has to come off again first.
 * Leaving it on produces a mask, of roughly the right object, drifting for no
 * visible reason. `host.py` puts the published encoder's output against the
 * reference's own features at 1.7e-5 with it off, and 0.07 with it on.
 */
export function toTokenMajor(features: Float32Array, noMemory: readonly number[]): Float32Array {
  const out = new Float32Array(FEATURE_TOKENS * FEATURE_DIM);
  for (let channel = 0; channel < FEATURE_DIM; channel++) {
    const offset = channel * FEATURE_TOKENS;
    const bias = noMemory[channel] ?? 0;
    for (let token = 0; token < FEATURE_TOKENS; token++) {
      out[token * FEATURE_DIM + channel] = (features[offset + token] ?? 0) - bias;
    }
  }
  return out;
}

/**
 * Token-major back to channel-major, which is what the mask decoder takes.
 *
 * Memory attention answers at (1, 1, 4096, 256), so its buffer is the same
 * token-major order it was given, and the decoder wants (1, 256, 64, 64) again.
 * A field transposed here is a plausible mask of roughly the right object and
 * no error anywhere, which is why it is checked against the reference's own two
 * tensors rather than against this file's reading of a permute.
 */
export function toChannelMajor(tokens: Float32Array): Float32Array {
  const out = new Float32Array(FEATURE_TOKENS * FEATURE_DIM);
  for (let token = 0; token < FEATURE_TOKENS; token++) {
    const offset = token * FEATURE_DIM;
    for (let channel = 0; channel < FEATURE_DIM; channel++) {
      out[channel * FEATURE_TOKENS + token] = tokens[offset + channel] ?? 0;
    }
  }
  return out;
}

/**
 * The 256 px field the decoder answered at, at the 1024 px the memory encoder
 * declares.
 *
 * BILINEAR, AND THAT WAS A CORRECTION. This was nearest first, on the reasoning
 * that the reference upsamples a high-resolution mask it already holds while
 * this reconstructs a decision, so a bilinear ramp four texels wide would feed
 * the bank a softer object than the decoder found. The reference holds no such
 * mask: its `pred_masks_high_res` is a bilinear interpolation of exactly these
 * logits and nothing else. Measured against what the reference hands the
 * encoder, nearest is out by 18.7 on a field that spans 20, which is the whole
 * of it, along every edge. Feeding the 256 px field in unscaled is a shape
 * error and says so; feeding it in wrongly resampled says nothing at all.
 *
 * Weights along one axis, applied twice, because they are the same 1024 of them
 * for every row and every column.
 */
export function atMemoryResolution(field: Float32Array): Float32Array {
  const out = new Float32Array(MEMORY_MASK * MEMORY_MASK);
  const scale = MASK_SIZE / MEMORY_MASK;

  const low = new Int32Array(MEMORY_MASK);
  const high = new Int32Array(MEMORY_MASK);
  const fraction = new Float32Array(MEMORY_MASK);
  for (let out1 = 0; out1 < MEMORY_MASK; out1++) {
    // The reference's own mapping, which clamps the COORDINATE at zero rather
    // than the index, so the first half-texel is flat instead of extrapolated.
    const source = Math.max(0, scale * (out1 + 0.5) - 0.5);
    const floor = Math.floor(source);
    low[out1] = floor;
    high[out1] = Math.min(floor + 1, MASK_SIZE - 1);
    fraction[out1] = source - floor;
  }

  for (let y = 0; y < MEMORY_MASK; y++) {
    const top = (low[y] ?? 0) * MASK_SIZE;
    const bottom = (high[y] ?? 0) * MASK_SIZE;
    const down = fraction[y] ?? 0;
    const into = y * MEMORY_MASK;
    for (let x = 0; x < MEMORY_MASK; x++) {
      const left = low[x] ?? 0;
      const right = high[x] ?? 0;
      const across = fraction[x] ?? 0;
      const upper =
        (field[top + left] ?? 0) + ((field[top + right] ?? 0) - (field[top + left] ?? 0)) * across;
      const lower =
        (field[bottom + left] ?? 0) + ((field[bottom + right] ?? 0) - (field[bottom + left] ?? 0)) * across;
      out[into + x] = upper + (lower - upper) * down;
    }
  }
  return out;
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
