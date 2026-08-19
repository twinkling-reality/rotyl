import { packCoverage, type CoverageMask } from '../../core/document/coverage-mask.ts';
import { expandCoverage } from '../../core/document/coverage-mask.ts';
import {
  atMemoryResolution,
  FEATURE_DIM,
  FEATURE_GRID,
  FEATURE_TOKENS,
  layOutBank,
  MASK_SIZE,
  maskForMemory,
  MEMORY_DIM,
  MEMORY_MASK,
  MEMORY_TOKENS,
  RECENT_ENTRIES,
  toChannelMajor,
  toTokenMajor,
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
 * WHAT IS ARITHMETIC IS NOT HERE. The transposes between the four sessions,
 * the bank's layout, the resampling into the memory encoder and the vision
 * position encoding are all in `src/core/perception/memory-bank.ts`, because
 * none of them needs a GPU or a runtime and every one of them can be wrong
 * silently. `tools/edgetam-export/host.py` drives the reference and this same
 * arithmetic over one clip and puts every stage of it against what the
 * reference hands the same graphs; the fixture it writes is what
 * `test/memory-bank.test.ts` asserts against.
 *
 * WHAT IS LEFT HERE IS THE FOUR SESSIONS AND THE ORDER THEY RUN IN, plus the
 * two ends nobody else owns: a seed arriving as a coverage mask, and a mask
 * leaving as one.
 */

type Ort = typeof OrtNamespace;
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;

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

/**
 * The reference's placeholder for a frame the object is not in.
 *
 * Large and negative rather than merely negative: it passes through a sigmoid
 * on its way into the memory encoder, and what the bank has to be told is
 * "nothing here" rather than "probably not".
 */
const NO_OBJECT = -1024;

/** An empty mask, for a frame the model says the object is not in. */
function absent(): Float32Array {
  return new Float32Array(MASK_SIZE * MASK_SIZE).fill(NO_OBJECT);
}

/** The same thing as coverage, which is what a run writes into the log. */
function emptyMask(): CoverageMask {
  return packCoverage(MASK_SIZE, MASK_SIZE, new Uint8Array(MASK_SIZE * MASK_SIZE));
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
  const visionPositions = visionPositionEncoding(FEATURE_GRID, FEATURE_GRID, FEATURE_DIM);

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
      vision_features: new ort.Tensor('float32', toChannelMajor(raw), [
        1,
        FEATURE_DIM,
        FEATURE_GRID,
        FEATURE_GRID,
      ]),
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
      // The seed is what the user already decided, so it goes into the bank
      // thresholded rather than softened, and the frame it came from is never
      // written back as a command: their own click is already there.
      let anchor: MemoryEntry | undefined = await remember(
        toTokenMajor(featuresOf(scene), noMemory),
        seedLogits(seed),
        true,
      );
      // Bounded, and that is what the anchor being separate buys as well as
      // correctness: a run holds seven entries at a quarter of a megabyte each
      // however long the clip is.
      const recent: MemoryEntry[] = [];

      return {
        async advance(next: SceneEmbedding): Promise<TrackedMask> {
          if (!anchor) throw new Error('EdgeTAM tracking: this track has been disposed');
          const raw = toTokenMajor(featuresOf(next), noMemory);
          const bank = layOutBank(anchor, recent, temporal);

          const conditioned = await attention.run({
            vision_features: new ort.Tensor('float32', raw, [FEATURE_TOKENS, 1, FEATURE_DIM]),
            vision_position_embeddings: new ort.Tensor('float32', visionPositions, [
              FEATURE_TOKENS,
              1,
              FEATURE_DIM,
            ]),
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
          // AND SAYING SO REACHES THE MASK, not just the flag. A decoder told
          // there is nothing there still draws something, and a run that wrote
          // it would replace the held-forward selection with a shape belonging
          // to whatever the model half-recognised behind the occluder. The
          // reference replaces that mask outright, before it upsamples it and
          // before it encodes a memory from it, which is also what stops an
          // occlusion teaching the tracker the wrong appearance.
          const logits = present ? decoded.logits : absent();
          recent.push(await remember(raw, logits, false));
          if (recent.length > RECENT_ENTRIES) recent.shift();
          return { mask: present ? decoded.mask : emptyMask(), present };
        },
        dispose(): void {
          anchor = undefined;
          recent.length = 0;
        },
      };
    },

    dispose(): void {
      void attention.release();
      void encoder.release();
    },
  };

  /**
   * The mask decoder, run against conditioned features and no click.
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
