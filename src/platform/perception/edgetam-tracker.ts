import { packCoverage, type CoverageMask } from '../../core/document/coverage-mask.ts';
import { expandCoverage } from '../../core/document/coverage-mask.ts';
import {
  layOutBank,
  maskForMemory,
  MEMORY_DIM,
  MEMORY_TOKENS,
  visionPositionEncoding,
  type MemoryEntry,
} from '../../core/perception/memory-bank.ts';
import type { SceneEmbedding } from '../../core/perception/segmentation-engine.ts';
import type { ObjectTrack, TrackedMask, TrackingEngine } from '../../core/perception/tracking-engine.ts';
import { conditionedDecoder, embeddingTensors, type EdgeTamTensor } from './edgetam-engine.ts';
import { fetchModel } from './model-store.ts';
import type * as OrtNamespace from 'onnxruntime-web/webgpu';

/**
 * EdgeTAM, as a Rotyl tracking engine.
 *
 * `SegmentationEngine` answers "what is under this click" and this answers
 * "where did it go". They share the expensive half and nothing else: one read
 * of a frame serves every track advancing against it, which is why a second
 * object costs a mask decode and a memory bank rather than a second encode.
 *
 * FOUR SESSIONS MAKE A TRACKED FRAME and two of them are already open. The
 * vision encoder and the mask decoder belong to the segmentation engine; the
 * two here are memory attention, which conditions this frame's features on what
 * the bank remembers, and the memory encoder, which turns this frame's answer
 * into the next entry in it. The graphs are produced by `tools/edgetam-export`
 * and are not in any published release, so `host` is where whoever is running
 * this put them. There is no default: a wrong guess would 404 after a
 * twenty-megabyte download.
 *
 * WHAT IT DOES WITHOUT, and it is a measured trade rather than an omission. The
 * published mask decoder does not expose `object_pointer`, the token carrying
 * an object's identity between frames, so the bank's pointer block stays empty.
 * Measured on a fixture with a three-frame occlusion, that costs exactly one
 * frame on the way back: the tracker produces no mask on the frame the object
 * reappears and picks it up on the next. Re-exporting the decoder buys it back.
 *
 * THE ONE SUBTRACTION THAT IS NOT OBVIOUS. The published vision encoder adds
 * `no_memory_embedding` to its last feature map, which is correct for a single
 * image, where there is no memory and the model is told so. On a tracked frame
 * memory attention replaces that, so it has to come off again first. Leaving it
 * on produces a mask, of roughly the right object, drifting for no visible
 * reason.
 */

type Ort = typeof OrtNamespace;
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;

/** The feature grid memory attention works over, from the checkpoint. */
const FEATURE = 64;
const TOKENS = FEATURE * FEATURE;
const CHANNELS = 256;
/** Resolution the mask decoder answers at, and the one the memory encoder wants. */
const MASK_SIZE = 256;
const MEMORY_MASK = 1024;
/** The conditioned map, which is `image_embeddings.2` by another name. */
const TOP_EMBEDDING = 'image_embeddings.2';

/** What `parameters.py` writes beside the graphs. */
interface Parameters {
  readonly parameters: {
    readonly no_memory_embedding: readonly number[];
    readonly memory_temporal_positional_encoding: readonly number[];
  };
  readonly constants: {
    readonly sigmoid_scale_for_mem_enc: number;
    readonly sigmoid_bias_for_mem_enc: number;
  };
}

export interface EdgeTamTrackerOptions {
  /**
   * Where the two graphs and `parameters.json` are served from.
   *
   * They are a derivative work of an Apache-2.0 checkpoint, so whoever hosts
   * them ships the licence and the attribution with them; see
   * `tools/edgetam-export`.
   */
  readonly host: string;
  readonly onProgress: (progress: number) => void;
}

const ATTENTION = { graph: 'memory_attention_shared_fp16.onnx', weights: '', bytes: 12_000_000 };
const ENCODER = { graph: 'memory_encoder.onnx', weights: '', bytes: 6_700_000 };

/** A model output, checked rather than assumed to be float data. */
function floatsOf(tensor: EdgeTamTensor | undefined, name: string): Float32Array {
  const data = tensor?.data;
  if (!(data instanceof Float32Array)) throw new Error(`EdgeTAM tracking: ${name} was not float data`);
  return data;
}

/**
 * The encoder's feature map, with the no-memory embedding taken back off, in
 * the layout attention wants.
 *
 * Two things at once because they are one pass over four megabytes: the map
 * arrives channel-major as (1, 256, 64, 64) and attention takes it token-major
 * as (4096, 1, 256). Doing the transpose twice to keep them separate would cost
 * more than the subtraction does.
 */
function rawTokens(features: Float32Array, noMemory: readonly number[]): Float32Array {
  const out = new Float32Array(TOKENS * CHANNELS);
  for (let channel = 0; channel < CHANNELS; channel++) {
    const offset = channel * TOKENS;
    const bias = noMemory[channel] ?? 0;
    for (let token = 0; token < TOKENS; token++) {
      out[token * CHANNELS + channel] = (features[offset + token] ?? 0) - bias;
    }
  }
  return out;
}

/** Token-major back to channel-major, which is what the mask decoder takes. */
function toChannelMajor(tokens: Float32Array): Float32Array {
  const out = new Float32Array(TOKENS * CHANNELS);
  for (let token = 0; token < TOKENS; token++) {
    const offset = token * CHANNELS;
    for (let channel = 0; channel < CHANNELS; channel++) {
      out[channel * TOKENS + token] = tokens[offset + channel] ?? 0;
    }
  }
  return out;
}

/**
 * A 256 px field at the 1024 px the memory encoder declares.
 *
 * Nearest, and deliberately: the reference upsamples the high-resolution mask
 * it already has, which this does not, so what is being reconstructed is a
 * decision rather than a boundary. Bilinear here would invent a ramp four
 * texels wide around every edge and feed the bank a softer object than the one
 * the decoder found. Feeding the 256 px field in unscaled is a shape error and
 * says so; feeding it in wrongly scaled says nothing at all.
 */
function atMemoryResolution(field: Float32Array): Float32Array {
  const out = new Float32Array(MEMORY_MASK * MEMORY_MASK);
  const step = MEMORY_MASK / MASK_SIZE;
  for (let y = 0; y < MEMORY_MASK; y++) {
    const row = Math.floor(y / step) * MASK_SIZE;
    const into = y * MEMORY_MASK;
    for (let x = 0; x < MEMORY_MASK; x++) {
      out[into + x] = field[row + Math.floor(x / step)] ?? 0;
    }
  }
  return out;
}

/**
 * Where the coverage ramp sits, in logits.
 *
 * The same constant `edgetam-engine.ts` uses and for the same reason: zero is
 * the model's own decision boundary, and a ramp centred there paints a haze
 * over everything it is merely unsure about.
 */
const DECIDED_LOGIT = 2;

function coverageFrom(logits: Float32Array, offset: number): CoverageMask {
  const coverage = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (let i = 0; i < coverage.length; i++) {
    const t = Math.min(1, Math.max(0, (logits[offset + i] ?? 0) / DECIDED_LOGIT));
    coverage[i] = Math.round(255 * t * t * (3 - 2 * t));
  }
  return packCoverage(MASK_SIZE, MASK_SIZE, coverage);
}

/** A seed's coverage read back as the logits the rest of this works in. */
function seedLogits(seed: CoverageMask): Float32Array {
  const coverage = expandCoverage(seed);
  const out = new Float32Array(MASK_SIZE * MASK_SIZE);
  const scaleX = seed.width / MASK_SIZE;
  const scaleY = seed.height / MASK_SIZE;
  for (let y = 0; y < MASK_SIZE; y++) {
    const row = Math.min(seed.height - 1, Math.floor(y * scaleY)) * seed.width;
    for (let x = 0; x < MASK_SIZE; x++) {
      const at = row + Math.min(seed.width - 1, Math.floor(x * scaleX));
      // Centred on the same decision boundary the decoder's own output is, so
      // the threshold below reads a seed and a prediction the same way.
      out[y * MASK_SIZE + x] = ((coverage[at] ?? 0) - 127.5) / 127.5;
    }
  }
  return out;
}

export async function loadEdgeTamTracker(options: EdgeTamTrackerOptions): Promise<TrackingEngine> {
  const { host, onProgress } = options;
  const ort = await import('onnxruntime-web/webgpu');

  const total = ATTENTION.bytes + ENCODER.bytes;
  let fetched = 0;
  const graphOf = async (file: typeof ATTENTION): Promise<Uint8Array<ArrayBuffer>> => {
    const { graph } = await fetchModel(
      { ...file, weights: file.graph },
      (received) => {
        onProgress(Math.min(1, (fetched + received) / total));
      },
      host,
    );
    fetched += file.bytes;
    return graph;
  };

  const parameters: Parameters = await (await fetch(`${host}/parameters.json`)).json();
  const noMemory = parameters.parameters.no_memory_embedding;
  const temporal = Float32Array.from(parameters.parameters.memory_temporal_positional_encoding);
  const { sigmoid_scale_for_mem_enc: scale, sigmoid_bias_for_mem_enc: bias } = parameters.constants;

  const common = { executionProviders: ['webgpu' as const] };
  const attention: Session = await ort.InferenceSession.create(await graphOf(ATTENTION), common);
  const encoder: Session = await ort.InferenceSession.create(await graphOf(ENCODER), common);

  // The same on every frame of every clip, so it is built once rather than
  // served: four megabytes that a loop produces in a millisecond.
  const visionPositions = visionPositionEncoding(FEATURE, FEATURE, CHANNELS);

  const featuresOf = (scene: SceneEmbedding): Float32Array => {
    const tensors = embeddingTensors(scene);
    if (!tensors) throw new Error('EdgeTAM tracking: that embedding was not produced here');
    return floatsOf(tensors[TOP_EMBEDDING], TOP_EMBEDDING);
  };

  /** One memory entry, from this frame's raw features and this frame's answer. */
  const remember = async (
    raw: Float32Array,
    mask: Float32Array,
    fromPrompt: boolean,
  ): Promise<MemoryEntry> => {
    const outputs = await encoder.run({
      vision_features: new ort.Tensor('float32', toChannelMajor(raw), [1, CHANNELS, FEATURE, FEATURE]),
      mask_for_memory: new ort.Tensor(
        'float32',
        maskForMemory(atMemoryResolution(mask), fromPrompt, scale, bias),
        [1, 1, MEMORY_MASK, MEMORY_MASK],
      ),
    });
    return {
      features: floatsOf(outputs.memory_features, 'memory_features'),
      positions: floatsOf(outputs.memory_positions, 'memory_positions'),
    };
  };

  return {
    async begin(scene: SceneEmbedding, seed: CoverageMask): Promise<ObjectTrack> {
      const entries: MemoryEntry[] = [];
      // The seed is what the user already decided, so it goes into the bank
      // thresholded rather than softened, and the frame it came from is never
      // written back as a command: their own click is already there.
      entries.push(await remember(rawTokens(featuresOf(scene), noMemory), seedLogits(seed), true));

      return {
        async advance(next: SceneEmbedding): Promise<TrackedMask> {
          const raw = rawTokens(featuresOf(next), noMemory);
          const bank = layOutBank(entries, temporal);

          const conditioned = await attention.run({
            vision_features: new ort.Tensor('float32', raw, [TOKENS, 1, CHANNELS]),
            vision_position_embeddings: new ort.Tensor('float32', visionPositions, [TOKENS, 1, CHANNELS]),
            memory: new ort.Tensor('float32', bank.memory, [MEMORY_TOKENS, 1, MEMORY_DIM]),
            memory_position_embeddings: new ort.Tensor('float32', bank.positions, [
              MEMORY_TOKENS,
              1,
              MEMORY_DIM,
            ]),
            key_mask: new ort.Tensor('float32', bank.keyMask, [1, 1, 1, MEMORY_TOKENS]),
          });

          const tokens = floatsOf(conditioned.conditioned_features, 'conditioned_features');
          const decoded = await decodeFrom(next, toChannelMajor(tokens));

          // The model's own account of whether the object is in this frame,
          // rather than a count of pixels: an object behind something is not an
          // object that got smaller.
          const present = (decoded.objectScore ?? 0) > 0;
          entries.push(await remember(raw, decoded.logits, false));
          return { mask: decoded.mask, present };
        },
        dispose(): void {
          entries.length = 0;
        },
      };
    },

    dispose(): void {
      void attention.release();
      void encoder.release();
    },
  };

  /**
   * The mask decoder, run against conditioned features and no prompt at all.
   *
   * Asked of the embedding rather than held here: the decoder is the
   * segmentation engine's session, and two owners for one graph is how a
   * session gets released while the other one is still using it.
   */
  async function decodeFrom(
    scene: SceneEmbedding,
    top: Float32Array,
  ): Promise<{ mask: CoverageMask; logits: Float32Array; objectScore: number }> {
    const decode = conditionedDecoder(scene);
    if (!decode) throw new Error('EdgeTAM tracking: that embedding was not produced here');
    const { logits, objectScore } = await decode(top);
    return { mask: coverageFrom(logits, 0), logits, objectScore };
  }
}
