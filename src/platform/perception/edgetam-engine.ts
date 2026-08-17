import type {
  MaskProposal,
  SceneEmbedding,
  SceneFrame,
  SegmentationEngine,
  SegmentPrompt,
} from '../../core/perception/segmentation-engine.ts';
import { FrameTensorEncoder } from '../../core/perception/frame-tensor.ts';
import { EDGETAM_FILES, EDGETAM_TOTAL_BYTES, fetchModel } from './model-store.ts';

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
 * NOTHING STAYS ON THE CPU THAT DOES NOT HAVE TO. The frame is already a GPU
 * texture, so the model's input tensor is built on the GPU and handed over as a
 * buffer; the three embeddings the encoder produces are seventeen megabytes and
 * are never read back, because the decoder wants them and the decoder is on the
 * same device. What does come back is the mask itself, 256 px square, which has
 * to reach the CPU regardless — the command log holds it, and the command log
 * is what makes the selection undoable and replayable at export resolution.
 *
 * The runtime and the weights are both loaded on demand. Together they are
 * about twenty-six megabytes, which would be an absurd thing to put in front of
 * someone who only wants to paint a selection, so the import is dynamic and the
 * bundler emits it as a separate chunk.
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

interface EmbeddingState {
  readonly tensors: Record<string, OrtTensor>;
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
 * Two sessions, sharing Rotyl's own GPU device.
 *
 * Letting the runtime create its own device would mean the embeddings could not
 * be passed between our textures and its buffers without a round trip through
 * system memory, which is the entire cost this design exists to avoid.
 */
async function createSessions(
  ort: Ort,
  device: GPUDevice,
  onProgress: (received: number) => void,
): Promise<{ encoder: Session; decoder: Session }> {
  let encoderBytes = 0;
  const encoderModel = await fetchModel(EDGETAM_FILES.encoder, (received) => {
    encoderBytes = received;
    onProgress(received);
  });
  const decoderModel = await fetchModel(EDGETAM_FILES.decoder, (received) => {
    onProgress(encoderBytes + received);
  });

  const common = { executionProviders: [{ name: 'webgpu' as const, device }] };

  const encoder = await ort.InferenceSession.create(encoderModel.graph, {
    ...common,
    externalData: [{ data: encoderModel.weights, path: EDGETAM_FILES.encoder.weights }],
    // The one setting that makes the split worthwhile: the embeddings stay
    // where they were produced instead of being copied out and back in.
    preferredOutputLocation: 'gpu-buffer',
  });

  const decoder = await ort.InferenceSession.create(decoderModel.graph, {
    ...common,
    externalData: [{ data: decoderModel.weights, path: EDGETAM_FILES.decoder.weights }],
  });

  return { encoder, decoder };
}

/** A model output, checked rather than assumed to be float data. */
function floatsOf(tensor: OrtTensor | undefined, name: string): Float32Array {
  const data = tensor?.data;
  if (!(data instanceof Float32Array)) throw new Error(`EdgeTAM: ${name} was not float data`);
  return data;
}

/** Logits to 8-bit coverage. */
function coverageFrom(logits: Float32Array, offset: number): Uint8Array {
  const coverage = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (let i = 0; i < coverage.length; i++) {
    // The refinement bridge wants a soft field, not a threshold: the ramp
    // either side of the boundary is what the guided filter fits its local
    // model to, and a binarised mask gives it nothing to work with.
    coverage[i] = Math.round(255 / (1 + Math.exp(-(logits[offset + i] ?? 0))));
  }
  return coverage;
}

export async function loadEdgeTamEngine(
  device: GPUDevice,
  onProgress: (progress: number) => void,
): Promise<SegmentationEngine> {
  const ort = await import('onnxruntime-web/webgpu');
  ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };

  const { encoder, decoder } = await createSessions(ort, device, (received) => {
    onProgress(Math.min(1, received / EDGETAM_TOTAL_BYTES));
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

      const pixelValues = ort.Tensor.fromGpuBuffer(tensors.buffer, {
        dataType: 'float32',
        dims: [...tensors.dimensions],
      });
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
      embeddingState.set(embedding, { tensors: held, frameSize: frame.size });
      return embedding;
    },

    async decode(scene: SceneEmbedding, prompt: SegmentPrompt): Promise<readonly MaskProposal[]> {
      const state = embeddingState.get(scene);
      if (!state) throw new Error('EdgeTAM: that embedding was not produced here, or has been released');
      const { tensors: embeddings, frameSize } = state;
      const points = prompt.points;
      if (points.length === 0) return [];

      // The model resizes to a square without preserving aspect, so prompts are
      // scaled per axis to match. Preserving aspect here instead would put every
      // click somewhere the model does not think it is.
      const coordinates = new Float32Array(points.length * 2);
      const labels = new BigInt64Array(points.length);
      points.forEach((point, index) => {
        coordinates[index * 2] = (point.x * INPUT_SIZE) / Math.max(1, frameSize.width);
        coordinates[index * 2 + 1] = (point.y * INPUT_SIZE) / Math.max(1, frameSize.height);
        labels[index] = point.include ? 1n : 0n;
      });

      const outputs = await decoder.run({
        ...embeddings,
        input_points: new ort.Tensor('float32', coordinates, [1, 1, points.length, 2]),
        input_labels: new ort.Tensor('int64', labels, [1, 1, points.length]),
        // Required by the graph even when unused; an empty tensor is how the
        // export expects "no box".
        input_boxes: new ort.Tensor('float32', new Float32Array(0), [1, 0, 4]),
      });

      const masks = floatsOf(outputs.pred_masks, 'pred_masks');
      const scores = floatsOf(outputs.iou_scores, 'iou_scores');

      const stride = MASK_SIZE * MASK_SIZE;
      const proposals: MaskProposal[] = [];
      for (let head = 0; head < scores.length; head++) {
        proposals.push({
          mask: {
            width: MASK_SIZE,
            height: MASK_SIZE,
            coverage: coverageFrom(masks, head * stride),
          },
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
