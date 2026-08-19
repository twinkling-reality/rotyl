import type {
  MaskProposal,
  SceneEmbedding,
  SceneFrame,
  SegmentationEngine,
  SegmentPrompt,
} from '../../core/perception/segmentation-engine.ts';
import { FrameTensorEncoder } from '../../core/perception/frame-tensor.ts';
import { packCoverage } from '../../core/document/coverage-mask.ts';
import { edgetamVariant, fetchModel, variantBytes, type ModelVariant } from './model-store.ts';

// The wasm is imported for its URL only. ONNX Runtime resolves it relative to
// its own script otherwise, which is wrong under any bundler that hashes file
// names, and the failure is a runtime 404 rather than a build error.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
// Types only, so nothing from the runtime reaches the main bundle; the module
// itself arrives through the dynamic import below.
import type * as OrtNamespace from 'onnxruntime-web/webgpu';

/**
 * EdgeTAM, as a Rotyl segmentation engine.
 *
 * WHAT CROSSES BETWEEN CPU AND GPU, AND WHAT DOES NOT. The seventeen megabytes
 * of embeddings the encoder produces never leave the GPU: they are asked for as
 * buffers and handed straight to the decoder, which is why a click costs about
 * fifteen milliseconds rather than the round trip. The 256 px mask does come
 * back, because it has to. The command log holds it, and the command log is
 * what makes the selection undoable and replayable at export resolution.
 *
 * The input tensor also crosses, and that one is a concession. ONNX Runtime
 * creates its own WebGPU device whatever it is handed: the `device` execution
 * provider option and `env.webgpu.device` were both tried, and the first fails
 * session creation outright with "failed to wait for the operation" while the
 * second is ignored. So the tensor is built on our GPU, where the resize and
 * the colour conversion are nearly free, and read back as twelve megabytes,
 * once per image, not per click. The alternative is resizing a twenty-four
 * megapixel photograph in JavaScript, which is far worse.
 *
 * MEASURED, on an M3 Pro against a 1200x800 image: encode 19-23 ms, decode
 * 13-15 ms. Both are an order of magnitude better than the published figures
 * for this model, and the reason is entirely the second paragraph.
 *
 * WHICH RUNTIME BUILD IS NOT ARBITRARY. `onnxruntime-web/webgpu` is the native
 * WebGPU runtime; the default export is the older JSEP one. On JSEP the vision
 * encoder is correct and the mask decoder silently returns an all-zero
 * confidence and a mask of the wrong object, at both precisions, so it is the
 * graph and not the weights. There is no error, which is exactly why this is
 * pinned rather than left to whichever export looks tidier.
 *
 * The runtime and the weights are both loaded on demand. Together they are
 * about sixteen megabytes compressed, which is an absurd thing to put in front
 * of someone who only wants to paint a selection, so the import is dynamic and
 * the bundler emits it as a separate chunk.
 */

/** What the weights were trained to receive; see frame-tensor.wgsl. */
const INPUT_SIZE = 1024;
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

/** Resolution the mask decoder answers at, whatever the photograph is. */
const MASK_SIZE = 256;

type Ort = typeof OrtNamespace;
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;
type OrtTensor = InstanceType<Ort['Tensor']>;

const EMBEDDING_NAMES = ['image_embeddings.0', 'image_embeddings.1', 'image_embeddings.2'] as const;

/** What a tracked frame gets back from the mask decoder. */
export interface ConditionedDecode {
  /** Mask logits at MASK_SIZE square, best head first. */
  readonly logits: Float32Array;
  /** The model's own account of whether the object is in this frame at all. */
  readonly objectScore: number;
}

interface EmbeddingState {
  readonly tensors: Record<string, OrtTensor>;
  /**
   * The mask decoder, run against features memory attention has conditioned
   * and against no prompt at all.
   *
   * Here rather than on the engine because the embedding is what knows which
   * sessions produced it, and here rather than in the tracker because the
   * decoder is this engine's: a tracker reaching into another module's session
   * would be two owners for one graph.
   */
  readonly decodeConditioned: (top: Float32Array) => Promise<ConditionedDecode>;
  /**
   * The frame this describes.
   *
   * Held here rather than passed with each prompt because it is a property of
   * what was encoded, not of the click: a prompt scaled against a different
   * image than the one the embedding came from would land somewhere arbitrary,
   * and nothing downstream could tell.
   */
  readonly frameSize: { readonly width: number; readonly height: number };
}

/**
 * The state behind an opaque `SceneEmbedding`, keyed by the handle itself.
 *
 * The interface promises the handle is opaque, and a side table is how that
 * promise is kept rather than asserted: an embedding from some other engine
 * simply is not in the map, which is a clear error rather than a cast that
 * reads whatever happens to be there.
 */
const embeddingState = new WeakMap<SceneEmbedding, EmbeddingState>();

/**
 * The tensors behind an embedding, for the tracker that shares them.
 *
 * The handle stays opaque to everything above `src/platform`: this is how the
 * one other module that legitimately needs what is inside gets at it, rather
 * than by a cast that reads whatever happens to be there. An embedding from
 * somewhere else is simply not in the map.
 */
export function embeddingTensors(scene: SceneEmbedding): Record<string, OrtTensor> | undefined {
  return embeddingState.get(scene)?.tensors;
}

/** The conditioned decode this embedding's engine offers, for the tracker. */
export function conditionedDecoder(
  scene: SceneEmbedding,
): ((top: Float32Array) => Promise<ConditionedDecode>) | undefined {
  return embeddingState.get(scene)?.decodeConditioned;
}

/** The runtime's tensor type, so a sibling can name what it was handed. */
export type EdgeTamTensor = OrtTensor;

/**
 * Two sessions on the runtime's own device.
 *
 * They share it with each other, which is what matters: the embeddings pass
 * from one to the other as GPU buffers and are never read back.
 */
async function createSessions(
  ort: Ort,
  variant: ModelVariant,
  onProgress: (received: number) => void,
): Promise<{ encoder: Session; decoder: Session }> {
  let encoderBytes = 0;
  const encoderModel = await fetchModel(variant.encoder, (received) => {
    encoderBytes = received;
    onProgress(received);
  });
  const decoderModel = await fetchModel(variant.decoder, (received) => {
    onProgress(encoderBytes + received);
  });

  const common = { executionProviders: ['webgpu' as const] };

  const encoder = await ort.InferenceSession.create(encoderModel.graph, {
    ...common,
    externalData: [{ data: encoderModel.weights, path: variant.encoder.weights }],
    // The one setting that makes the encode/decode split worth having: the
    // embeddings stay where they were produced instead of being copied out and
    // back in for every click.
    preferredOutputLocation: 'gpu-buffer',
  });

  const decoder = await ort.InferenceSession.create(decoderModel.graph, {
    ...common,
    externalData: [{ data: decoderModel.weights, path: variant.decoder.weights }],
  });

  return { encoder, decoder };
}

/** A model output, checked rather than assumed to be float data. */
function floatsOf(tensor: OrtTensor | undefined, name: string): Float32Array {
  const data = tensor?.data;
  if (!(data instanceof Float32Array)) throw new Error(`EdgeTAM: ${name} was not float data`);
  return data;
}

/**
 * Where the mask's coverage ramp is placed, in logits.
 *
 * Zero is the model's own decision boundary, and putting the ramp's midpoint
 * there is the obvious choice and a visibly bad one: a logit of +0.3 means
 * "marginally more likely than not", and rendering it as half coverage paints a
 * haze of stylisation over every region the model is merely unsure about. A
 * prompt spanning two objects produced exactly that, as a translucent wash over
 * a third object nobody had asked for.
 *
 * So the ramp runs from the decision boundary to clearly-decided instead. A
 * real boundary crosses the whole range within a texel, because the model is
 * confident on both sides of one; an ambiguous region never leaves it.
 */
const DECIDED_LOGIT = 2;

/**
 * Logits to 8-bit coverage.
 *
 * Soft rather than thresholded, because the refinement bridge fits a local
 * linear model to this field and a binarised mask gives it nothing to fit.
 */
function coverageFrom(logits: Float32Array, offset: number): Uint8Array {
  const coverage = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (let i = 0; i < coverage.length; i++) {
    const t = Math.min(1, Math.max(0, (logits[offset + i] ?? 0) / DECIDED_LOGIT));
    coverage[i] = Math.round(255 * t * t * (3 - 2 * t));
  }
  return coverage;
}

export interface EdgeTamOptions {
  /** Rotyl's device, which builds the input tensor. The runtime uses its own. */
  readonly device: GPUDevice;
  /** Decides which build of the weights is worth downloading. */
  readonly supportsF16: boolean;
  readonly onProgress: (progress: number) => void;
}

export async function loadEdgeTamEngine(options: EdgeTamOptions): Promise<SegmentationEngine> {
  const { device, supportsF16, onProgress } = options;
  const ort = await import('onnxruntime-web/webgpu');
  ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };

  // Decided from the adapter rather than from the runtime, and before anything
  // is downloaded. The native build does expose its device once the module is
  // imported, so asking it would be possible, but the answer would then depend
  // on the runtime having started, which is an ordering dependency this
  // decision does not need and which the JSEP build cannot satisfy at all.
  // Shader-f16 is a property of the hardware; ask the hardware.
  const variant = edgetamVariant(supportsF16);
  const total = variantBytes(variant);
  const { encoder, decoder } = await createSessions(ort, variant, (received) => {
    onProgress(Math.min(1, received / total));
  });

  const tensors = new FrameTensorEncoder(device, {
    size: INPUT_SIZE,
    mean: IMAGENET_MEAN,
    std: IMAGENET_STD,
  });

  return {
    async encode(frame: SceneFrame): Promise<SceneEmbedding> {
      const commands = device.createCommandEncoder({ label: 'frame-tensor' });
      tensors.encode(commands, frame.view, frame.size);
      device.queue.submit([commands.finish()]);

      const pixelValues = new ort.Tensor('float32', await tensors.read(), [...tensors.dimensions]);
      const outputs = await encoder.run({ pixel_values: pixelValues });

      const held: Record<string, OrtTensor> = {};
      for (const name of EMBEDDING_NAMES) {
        const tensor = outputs[name];
        if (!tensor) throw new Error(`EdgeTAM: the encoder produced no ${name}`);
        held[name] = tensor;
      }

      const embedding: SceneEmbedding = {
        dispose(): void {
          embeddingState.delete(embedding);
          for (const tensor of Object.values(held)) tensor.dispose();
        },
      };
      embeddingState.set(embedding, {
        tensors: held,
        frameSize: frame.size,
        async decodeConditioned(top: Float32Array): Promise<ConditionedDecode> {
          const tracked = await decoder.run({
            ...held,
            // The conditioned map replaces the top embedding and nothing else:
            // the two finer levels are the same picture either way.
            'image_embeddings.2': new ort.Tensor('float32', top, [1, 256, 64, 64]),
            // ONE POINT LABELLED -1, NOT NONE AT ALL, and the difference is
            // silent. A label of -1 means "not a point": the coordinates are
            // discarded and the embedding is replaced wholesale, so what this
            // sends is a prompt made of nothing, which is what a tracked frame
            // has instead of a click. Sending zero points is not the same
            // thing, because the published graph was traced with the
            // reference's trailing pad baked in, so it appends one of these
            // itself and the reference ends up with two where an empty prompt
            // gives one. It answers either way. Measured against the
            // reference's own decoder on a conditioned map, one point labelled
            // -1 is right to 4e-5 and no points at all is out by 1.5 on mask
            // logits and 0.39 on the object score, which is enough to move a
            // boundary and to flip whether the object is there at all. See
            // tools/edgetam-export/host.py.
            input_points: new ort.Tensor('float32', new Float32Array(2), [1, 1, 1, 2]),
            input_labels: new ort.Tensor('int64', BigInt64Array.from([-1n]), [1, 1, 1]),
            input_boxes: new ort.Tensor('float32', new Float32Array(0), [1, 0, 4]),
          });

          const masks = floatsOf(tracked.pred_masks, 'pred_masks');
          const scores = floatsOf(tracked.iou_scores, 'iou_scores');
          // The best of the three heads by the model's own estimate, which is
          // the right axis here: unlike a click, nobody is being offered a
          // choice between a part, an object and a group.
          let best = 0;
          for (let head = 1; head < scores.length; head++) {
            if ((scores[head] ?? 0) > (scores[best] ?? 0)) best = head;
          }
          const stride = MASK_SIZE * MASK_SIZE;
          const objectLogits = tracked.object_score_logits?.data;
          return {
            logits: masks.slice(best * stride, (best + 1) * stride),
            objectScore: objectLogits instanceof Float32Array ? (objectLogits[0] ?? 0) : (scores[best] ?? 0),
          };
        },
      });
      return embedding;
    },

    async decode(scene: SceneEmbedding, prompt: SegmentPrompt): Promise<readonly MaskProposal[]> {
      const state = embeddingState.get(scene);
      if (!state) throw new Error('EdgeTAM: that embedding was not produced here, or has been released');
      const { tensors: embeddings, frameSize } = state;
      const { points, box } = prompt;
      if (points.length === 0 && !box) return [];

      // The model resizes to a square without preserving aspect, so prompts are
      // scaled per axis to match. Preserving aspect here instead would put every
      // click somewhere the model does not think it is.
      const scaleX = INPUT_SIZE / Math.max(1, frameSize.width);
      const scaleY = INPUT_SIZE / Math.max(1, frameSize.height);

      const coordinates = new Float32Array(points.length * 2);
      const labels = new BigInt64Array(points.length);
      points.forEach((point, index) => {
        coordinates[index * 2] = point.x * scaleX;
        coordinates[index * 2 + 1] = point.y * scaleY;
        labels[index] = point.include ? 1n : 0n;
      });

      // Both prompt inputs are required by the graph whether or not they carry
      // anything, and an empty tensor is how the export expects "none of these",
      // for points as well as for boxes, which is what makes a box-only
      // prompt expressible at all.
      const outputs = await decoder.run({
        ...embeddings,
        input_points: new ort.Tensor('float32', coordinates, [1, 1, points.length, 2]),
        input_labels: new ort.Tensor('int64', labels, [1, 1, points.length]),
        input_boxes: box
          ? new ort.Tensor(
              'float32',
              // Normalised to top-left, bottom-right: a box dragged upward or
              // leftward is the same box, and the decoder is not asked to know
              // that.
              new Float32Array([
                Math.min(box.x0, box.x1) * scaleX,
                Math.min(box.y0, box.y1) * scaleY,
                Math.max(box.x0, box.x1) * scaleX,
                Math.max(box.y0, box.y1) * scaleY,
              ]),
              [1, 1, 4],
            )
          : new ort.Tensor('float32', new Float32Array(0), [1, 0, 4]),
      });

      const masks = floatsOf(outputs.pred_masks, 'pred_masks');
      const scores = floatsOf(outputs.iou_scores, 'iou_scores');

      const stride = MASK_SIZE * MASK_SIZE;
      const proposals: MaskProposal[] = [];
      for (let head = 0; head < scores.length; head++) {
        proposals.push({
          mask: packCoverage(MASK_SIZE, MASK_SIZE, coverageFrom(masks, head * stride)),
          confidence: scores[head] ?? 0,
        });
      }
      // Best first. The model's own IoU estimate picks correctly between "this
      // part", "this object" and "this group" in every case measured, including
      // prompts carrying negative points.
      return proposals.toSorted((a, b) => b.confidence - a.confidence);
    },

    dispose(): void {
      tensors.dispose();
      void encoder.release();
      void decoder.release();
    },
  };
}
