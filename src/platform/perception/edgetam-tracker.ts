import { packCoverage, type CoverageMask } from '../../core/document/coverage-mask.ts';
import { expandCoverage } from '../../core/document/coverage-mask.ts';
import {
  atMemoryResolution,
  FEATURE_DIM,
  MAX_POINTERS,
  POINTER_DIM,
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
import { embeddingTensors, type EdgeTamTensor } from './edgetam-engine.ts';
import { modelAsset, type ModelAssetName } from './model-assets.ts';
import { fetchGraph } from './model-store.ts';
import type * as OrtNamespace from 'onnxruntime-web/webgpu';

/**
 * EdgeTAM, as a Rotyl tracking engine.
 *
 * `SegmentationEngine` answers "what is under this click" and this answers
 * "where did it go". They share the expensive half and nothing else: one read
 * of a frame serves every track advancing against it, which is why a second
 * object costs a mask decode and a memory bank rather than a second encode.
 *
 * FIVE SESSIONS MAKE A TRACKED FRAME and one of them is already open. The
 * vision encoder belongs to the segmentation engine and reads the frame for
 * both of them; the three here are memory attention, which conditions this
 * frame's features on what the bank remembers, the memory encoder, which turns
 * this frame's answer into the next entry in it, and a mask decoder of this
 * file's own. The graphs are produced by `tools/edgetam-export`, published in
 * Rotyl's immutable model release, and emitted into every deployment. The
 * build and this fetch path check the same manifest before a session receives
 * them.
 *
 * FIVE SESSIONS MAKE A TRACKED FRAME, and the fifth is the reason this file
 * fetches a mask decoder of its own. The published one does not expose
 * `object_pointer`, the token carrying an object's identity between frames,
 * without which the bank's pointer block stays empty and the tracker comes back
 * from an occlusion late and with no mask at all on the frames it was late by.
 * `tools/edgetam-export` re-exports that decoder with the pointer on it, and
 * with the prompt a tracked frame never varies baked in, so this graph cannot
 * be handed the nearly-right prompt the published one accepts.
 *
 * The other output a tracked frame needs, `object_score_logits`, the published
 * decoder DOES have; this comment used to say it does not. Which decoder
 * arrived is still asked of the graph at load, because serving the published
 * one is an ordinary mistake and the check names what is missing rather than
 * recognising a file. See `loadEdgeTamTracker`.
 *
 * A TRACKED FRAME IS 135 MS, of which 44 is reading it and 91 is advancing one
 * track against what was read. Two objects is 226 rather than 270, because the
 * reading is shared, which is what makes a second track a second `ObjectTrack`
 * rather than a second run. Measured end to end through this file by
 * `tools/video-bench/run.mjs tracked-frame`.
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
    readonly no_object_pointer: readonly number[];
  };
  readonly constants: {
    readonly sigmoid_scale_for_mem_enc: number;
    readonly sigmoid_bias_for_mem_enc: number;
  };
}

function property(value: unknown, name: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  return Object.getOwnPropertyDescriptor(value, name)?.value;
}

function numbers(value: unknown, name: string): readonly number[] {
  if (!Array.isArray(value)) throw new Error(`EdgeTAM tracking: ${name} was not an array`);
  return value.map((entry: unknown) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new Error(`EdgeTAM tracking: ${name} contained something other than a number`);
    }
    return entry;
  });
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`EdgeTAM tracking: ${name} was not a number`);
  }
  return value;
}

function parametersFrom(bytes: Uint8Array<ArrayBuffer>): Parameters {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const parameters = property(parsed, 'parameters');
  const constants = property(parsed, 'constants');
  return {
    parameters: {
      no_memory_embedding: numbers(property(parameters, 'no_memory_embedding'), 'no_memory_embedding'),
      memory_temporal_positional_encoding: numbers(
        property(parameters, 'memory_temporal_positional_encoding'),
        'memory_temporal_positional_encoding',
      ),
      no_object_pointer: numbers(property(parameters, 'no_object_pointer'), 'no_object_pointer'),
    },
    constants: {
      sigmoid_scale_for_mem_enc: finite(
        property(constants, 'sigmoid_scale_for_mem_enc'),
        'sigmoid_scale_for_mem_enc',
      ),
      sigmoid_bias_for_mem_enc: finite(
        property(constants, 'sigmoid_bias_for_mem_enc'),
        'sigmoid_bias_for_mem_enc',
      ),
    },
  };
}

export interface EdgeTamTrackerOptions {
  readonly onProgress: (progress: number) => void;
}

/**
 * The two graphs, and what they weigh, for the progress figure that has to
 * exist before the first byte arrives.
 *
 * Attention ships at half precision with its rotary tables shared, which is
 * 12 MB against the 69.6 it exports at; the encoder ships whole, because half
 * precision moves its worst output element by half the signal and that output
 * conditions every later frame. Both carry their weights inside them, so each
 * is one request.
 */
interface TrackerAsset {
  readonly graph: ModelAssetName;
  readonly bytes: number;
}

const trackerAsset = (graph: ModelAssetName): TrackerAsset => ({ graph, bytes: modelAsset(graph).bytes });

const ATTENTION = trackerAsset('memory_attention_shared_fp16.onnx');
const ENCODER = trackerAsset('memory_encoder.onnx');
/**
 * The mask decoder a tracked frame uses, which is not the published one.
 *
 * It is the published decoder plus `object_pointer`, and it takes no prompt at
 * all: what a tracked frame sends is the same two "not a point" tokens every
 * time, so the whole prompt encoder folds to constants and this graph cannot be
 * handed a prompt that is nearly right. Half precision, which moves its worst
 * output by 0.27% and its pointer, the one that enters the bank, by 0.07%. That
 * changes one frame on one clip, and it is the frame the object comes back on,
 * where the model's own score sits within a tenth of a per cent of zero: at
 * half precision this lands on time and at full precision it lands a frame
 * late, agreeing with the reference. Neither earns that frame. Eleven megabytes
 * against twenty-two decides it.
 */
const DECODER = trackerAsset('tracked_mask_decoder_fp16.onnx');
const PARAMETERS = trackerAsset('parameters.json');

/**
 * The two outputs this file fetches a decoder of its own to get.
 *
 * `object_pointer` carries an object's identity between frames, and
 * `object_score_logits` is the model's own account of whether the object is in
 * this frame at all. The pointer is the one the published decoder lacks and the
 * entire reason `tools/edgetam-export` re-exports one; the score is asked for
 * as well because a graph without it cannot say an object is absent, and this
 * check names whichever is missing rather than recognising a particular file.
 */
const DECODER_OWES = ['object_pointer', 'object_score_logits'] as const;

/**
 * Which of them a graph does not have, so a host that served the wrong file can
 * be told which one.
 *
 * Exported because it is the whole of a check that would otherwise only run
 * against the large tracked decoder in the owned model release.
 */
export function decoderIsMissing(outputs: readonly string[]): readonly string[] {
  return DECODER_OWES.filter((name) => !outputs.includes(name));
}

/** A model output, checked rather than assumed to be float data. */
function floatsOf(tensor: EdgeTamTensor | undefined, name: string): Float32Array {
  const data = tensor?.data;
  if (!(data instanceof Float32Array)) throw new Error(`EdgeTAM tracking: ${name} was not float data`);
  return data;
}

/**
 * The same, for a tensor that may still be on the GPU.
 *
 * The segmentation engine asks for `gpu-buffer` outputs, which is what keeps a
 * click at fifteen milliseconds: seventeen megabytes of embeddings pass from
 * the encoder to the decoder without crossing back. A tracked frame is the one
 * consumer that has to read one of them, because the transposes and the
 * subtraction happen here rather than in a graph, so this asks for it rather
 * than reading `.data` and being told it is not on the CPU.
 *
 * Four megabytes a frame, measured at about 2 ms and not the bottleneck against
 * ninety. `releaseData` is deliberately not set: the same embedding is handed
 * back to the mask decoder afterwards.
 */
async function floatsFrom(tensor: EdgeTamTensor | undefined, name: string): Promise<Float32Array> {
  if (!tensor) throw new Error(`EdgeTAM tracking: there was no ${name}`);
  const data = tensor.location === 'cpu' ? tensor.data : await tensor.getData();
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

declare global {
  /** Set by `tools/shots/track-confidence.mjs`. Undefined in a normal run. */
  // eslint-disable-next-line no-var
  var rotylTrackLog: number[][] | undefined;
  /** Frames whose mask bitmap to keep, set by the same tool. */
  // eslint-disable-next-line no-var
  var rotylTrackMaskAt: number[] | undefined;
  // eslint-disable-next-line no-var
  var rotylTrackMasks: Array<{ frame: number; bitmap: number[] }> | undefined;
}

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

/**
 * A seed's coverage read back as the logits the rest of this works in.
 *
 * ONLY THE SIGN OF THIS IS EVER READ: `maskForMemory` is told the mask came
 * from a prompt, so it thresholds rather than softening. So the whole of what
 * this decides is where a seed stops being the object, and it puts that at half
 * coverage.
 *
 * WHICH IS NOT WHERE THE MODEL PUTS IT, and that is the one place this
 * deliberately differs from the reference. The coverage ramp runs from the
 * decision boundary to clearly-decided, so a logit of zero is coverage zero and
 * half coverage is a logit of one: a model-derived seed therefore arrives very
 * slightly eroded. Measured on four clips, that is the only difference left
 * between this tracker and the PyTorch one, which it otherwise reproduces frame
 * for frame; it costs between one and nine points of worst-frame agreement and
 * buys a shade of IoU back against ground truth. It is kept because by the time
 * a run starts the seed genuinely is a coverage mask, brushwork and all, and
 * half coverage is what half coverage means.
 */
function seedLogits(seed: CoverageMask): Float32Array {
  const coverage = expandCoverage(seed);
  const out = new Float32Array(MASK_SIZE * MASK_SIZE);
  const scaleX = seed.width / MASK_SIZE;
  const scaleY = seed.height / MASK_SIZE;
  for (let y = 0; y < MASK_SIZE; y++) {
    const row = Math.min(seed.height - 1, Math.floor(y * scaleY)) * seed.width;
    for (let x = 0; x < MASK_SIZE; x++) {
      const at = row + Math.min(seed.width - 1, Math.floor(x * scaleX));
      out[y * MASK_SIZE + x] = ((coverage[at] ?? 0) - 127.5) / 127.5;
    }
  }
  return out;
}

export async function loadEdgeTamTracker(options: EdgeTamTrackerOptions): Promise<TrackingEngine> {
  const { onProgress } = options;
  const ort = await import('onnxruntime-web/webgpu');

  const total = ATTENTION.bytes + ENCODER.bytes + DECODER.bytes + PARAMETERS.bytes;
  let fetched = 0;
  const graphOf = async (file: TrackerAsset): Promise<Uint8Array<ArrayBuffer>> => {
    const graph = await fetchGraph(file.graph, (received) => {
      onProgress(Math.min(1, (fetched + received) / total));
    });
    fetched += file.bytes;
    return graph;
  };

  const parameters = parametersFrom(await graphOf(PARAMETERS));
  const noMemory = parameters.parameters.no_memory_embedding;
  const temporal = Float32Array.from(parameters.parameters.memory_temporal_positional_encoding);
  const { sigmoid_scale_for_mem_enc: scale, sigmoid_bias_for_mem_enc: bias } = parameters.constants;
  // What stands in for an object that is not there. The graph hands back the
  // projection and this is the other half of the reference's blend, kept out of
  // it for the reason the memory encoder's sigmoid is.
  const noObjectPointer = Float32Array.from(parameters.parameters.no_object_pointer);

  const common = { executionProviders: ['webgpu' as const] };
  const attention: Session = await ort.InferenceSession.create(await graphOf(ATTENTION), common);
  const encoder: Session = await ort.InferenceSession.create(await graphOf(ENCODER), common);
  const decoder: Session = await ort.InferenceSession.create(await graphOf(DECODER), common);

  // AND IT IS THE RIGHT DECODER, asked of the graph rather than assumed.
  //
  // Pointing a build at the published decoder is an ordinary mistake: it is the
  // file every EdgeTAM release contains and the only one anybody who has not
  // read `tools/edgetam-export` would think to serve.
  //
  // WHAT IT IS MISSING IS ONE OF THE TWO, NOT BOTH, which this comment used to
  // say and which asking the file settles: at the revision `model-store.ts`
  // pins, `prompt_encoder_mask_decoder.onnx` declares `iou_scores`,
  // `pred_masks` and `object_score_logits`. So serving it has always failed,
  // and failed loudly, on `object_pointer`, which is read the way every other
  // output is and throws on the first tracked frame.
  //
  // The silent case is real and is not that file. A graph carrying the pointer
  // and no object score used to fall back to the best head's predicted IoU,
  // which is a different quantity compared against the same zero and is
  // essentially always positive, so it would have tracked and reported the
  // object present on every frame of every clip. No release contains such a
  // graph, so that was a wrong answer waiting for a file rather than a bug
  // anybody had hit, and it is unreachable now either way.
  //
  // What the check buys for the case that does happen is a sentence before
  // anything starts instead of an exception on the first frame: it is a fact
  // about the graph rather than about a frame, and failing during a run is a
  // sentence plus a half-written gesture in the log.
  const missing = decoderIsMissing(decoder.outputNames);
  if (missing.length > 0) {
    await Promise.all([attention.release(), encoder.release(), decoder.release()]);
    throw new Error(
      `That mask decoder has no ${missing.join(' and no ')}, so it is not the one tools/edgetam-export re-exports. The published decoder is missing object_pointer; a graph missing object_score_logits cannot say an object is absent at all. Tracking needs both.`,
    );
  }

  // The same on every frame of every clip, so it is built once rather than
  // served: four megabytes that a loop produces in a millisecond.
  const visionPositions = visionPositionEncoding(FEATURE_GRID, FEATURE_GRID, FEATURE_DIM);

  const featuresOf = async (scene: SceneEmbedding): Promise<Float32Array> => {
    const tensors = embeddingTensors(scene);
    if (!tensors) throw new Error('EdgeTAM tracking: that embedding was not produced here');
    return floatsFrom(tensors[TOP_EMBEDDING], TOP_EMBEDDING);
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
      const seeded = toTokenMajor(await featuresOf(scene), noMemory);
      let anchor: MemoryEntry | undefined = await remember(seeded, seedLogits(seed), true);
      // Bounded, and that is what the anchor being separate buys as well as
      // correctness: a run holds seven entries at a quarter of a megabyte each
      // however long the clip is.
      const recent: MemoryEntry[] = [];

      // THE POINTER BLOCK KEEPS A LONGER MEMORY THAN THE SPATIAL ONE, sixteen
      // against seven, because a pointer is a kilobyte where an entry is a
      // quarter of a megabyte. The anchor's is the one the user's own frame
      // produced, so it is held apart and never dropped, exactly as its entry
      // is. The seed frame has no decode of its own here, so the anchor's
      // pointer arrives on the first tracked frame instead.
      let anchorPointer: Float32Array | undefined;
      const recentPointers: Float32Array[] = [];

      return {
        async advance(next: SceneEmbedding): Promise<TrackedMask> {
          if (!anchor) throw new Error('EdgeTAM tracking: this track has been disposed');
          const raw = toTokenMajor(await featuresOf(next), noMemory);
          // The anchor's pointer first and the rest newest-first, which is the
          // order the reference concatenates them in. Nothing depends on it,
          // since the block carries no position and is excluded from the rotary
          // so attention over it is a sum over a set, but matching the
          // reference makes `host.py`'s comparison exact rather than merely
          // equivalent.
          const pointers = anchorPointer ? [anchorPointer, ...recentPointers.toReversed()] : [];
          const bank = layOutBank(anchor, recent, temporal, pointers);

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
          const present = decoded.objectScore > 0;
          // A drifting track looks like a working one from outside: the mask is
          // the right shape and the model's own scores stay high all the way
          // through. So that it can be measured rather than guessed at,
          // `tools/shots/track-confidence.mjs` sets this and reads back what the
          // decoder said per frame. Undefined in a normal run, which is one
          // comparison per tracked frame.
          if (globalThis.rotylTrackLog !== undefined) {
            let covered = 0;
            let sumX = 0;
            let sumY = 0;
            let minX = MASK_SIZE;
            let maxX = -1;
            let minY = MASK_SIZE;
            let maxY = -1;
            for (let at = 0; at < decoded.logits.length; at++) {
              if ((decoded.logits[at] ?? -1) > 0) {
                const x = at % MASK_SIZE;
                const y = Math.floor(at / MASK_SIZE);
                covered++;
                sumX += x;
                sumY += y;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
            // The scalars above say how big the mask is and where its middle is.
            // Neither says what shape it is or what it is sitting on, and that
            // turned out to be the whole question, so the frames named in
            // `rotylTrackMaskAt` keep their mask as a flat 0/1 grid.
            const frame = globalThis.rotylTrackLog.length;
            if (globalThis.rotylTrackMaskAt?.includes(frame) === true) {
              const bitmap: number[] = Array.from({ length: decoded.logits.length }, () => 0);
              for (let at = 0; at < decoded.logits.length; at++) {
                bitmap[at] = (decoded.logits[at] ?? -1) > 0 ? 1 : 0;
              }
              globalThis.rotylTrackMasks ??= [];
              globalThis.rotylTrackMasks.push({ frame, bitmap });
            }
            globalThis.rotylTrackLog.push([
              decoded.objectScore,
              decoded.quality,
              covered,
              covered > 0 ? sumX / covered : -1,
              covered > 0 ? sumY / covered : -1,
              minX,
              maxX,
              minY,
              maxY,
            ]);
          }
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

          // And the pointer, which is what the object IS rather than where it
          // was. A frame the object is not in contributes the checkpoint's
          // stand-in rather than the projection of a token that describes
          // nothing, which is the reference's blend written as the choice it
          // is.
          const pointer = present ? decoded.pointer : noObjectPointer;
          if (anchorPointer === undefined) anchorPointer = pointer;
          else {
            recentPointers.push(pointer);
            if (recentPointers.length > MAX_POINTERS - 1) recentPointers.shift();
          }
          return { mask: present ? decoded.mask : emptyMask(), present };
        },
        dispose(): void {
          anchor = undefined;
          anchorPointer = undefined;
          recent.length = 0;
          recentPointers.length = 0;
        },
      };
    },

    dispose(): void {
      void attention.release();
      void encoder.release();
      void decoder.release();
    },
  };

  /**
   * The mask decoder, run against conditioned features and no prompt.
   *
   * HELD HERE NOW RATHER THAN ASKED OF THE SEGMENTATION ENGINE, because it is
   * no longer the same graph. The published decoder answers a click and does
   * not expose `object_pointer`; this one answers a tracked frame and does.
   * What they share is the two finer feature maps, which arrive as the
   * runtime's own GPU buffers and are handed straight across: the two sessions
   * live on one device, so nothing crosses back through system memory.
   */
  async function decodeFrom(
    scene: SceneEmbedding,
    top: Float32Array,
  ): Promise<{
    mask: CoverageMask;
    logits: Float32Array;
    objectScore: number;
    /** The model's predicted IoU for the head it picked. Its own quality estimate. */
    quality: number;
    pointer: Float32Array;
  }> {
    const tensors = embeddingTensors(scene);
    if (!tensors) throw new Error('EdgeTAM tracking: that embedding was not produced here');
    const finer = (name: string): EdgeTamTensor => {
      const tensor = tensors[name];
      if (!tensor) throw new Error(`EdgeTAM tracking: the encoder produced no ${name}`);
      return tensor;
    };
    const outputs = await decoder.run({
      'image_embeddings.0': finer('image_embeddings.0'),
      'image_embeddings.1': finer('image_embeddings.1'),
      // The conditioned map replaces the top embedding and nothing else: the
      // two finer levels are the same picture either way.
      'image_embeddings.2': new ort.Tensor('float32', top, [1, FEATURE_DIM, FEATURE_GRID, FEATURE_GRID]),
    });

    const masks = floatsOf(outputs.pred_masks, 'pred_masks');
    const scores = floatsOf(outputs.iou_scores, 'iou_scores');
    const pointers = floatsOf(outputs.object_pointer, 'object_pointer');
    // The best of the three heads by the model's own estimate, which is the
    // right axis here: unlike a click, nobody is being offered a choice between
    // a part, an object and a group. The pointer for that pick is the one at
    // the same index, which is the whole reason the graph returns three.
    let best = 0;
    for (let head = 1; head < scores.length; head++) {
      if ((scores[head] ?? 0) > (scores[best] ?? 0)) best = head;
    }
    const stride = MASK_SIZE * MASK_SIZE;
    // Read the same way as the two outputs above it, which is the point: this
    // used to fall back to `scores[best]` when the graph had no such output,
    // and a predicted IoU compared against zero is a tracker that never sees an
    // occlusion. `loadEdgeTamTracker` refuses a graph without it, so reaching
    // here without one is a graph that changed shape between load and frame.
    return {
      mask: coverageFrom(masks, best * stride),
      logits: masks.slice(best * stride, (best + 1) * stride),
      objectScore: floatsOf(outputs.object_score_logits, 'object_score_logits')[0] ?? 0,
      quality: scores[best] ?? 0,
      pointer: pointers.slice(best * POINTER_DIM, (best + 1) * POINTER_DIM),
    };
  }
}
