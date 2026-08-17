// MEASUREMENT 2: memory attention on WebGPU.
//
// 226 ms on the CPU execution provider says memory attention is the expensive
// half of tracking and says nothing about the real number. It is 4096 queries
// against 3648 keys on every tracked frame, and the bank is fixed at that size
// on purpose so the graph has one shape.
//
// Graph signatures, read from the files rather than assumed:
//   memory_attention   vision_features            f32 [4096, 1, 256]   4.19 MB
//                      vision_position_embeddings f32 [4096, 1, 256]   4.19 MB
//                      memory                     f32 [3648, 1, 64]    0.93 MB
//                      memory_position_embeddings f32 [3648, 1, 64]    0.93 MB
//                      key_mask                   f32 [1, 1, 1, 3648]  additive
//                   -> conditioned_features       f32 [1, 1, 4096, 256]
//   memory_encoder     vision_features            f32 [1, 256, 64, 64]
//                      mask_for_memory            f32 [1, 1, 1024, 1024]
//                   -> memory_features            f32 [1, 512, 64]
//                      memory_positions           f32 [1, 512, 64]

import { runtimeDevice, stats, type Stat } from './util.ts';
import type * as OrtNamespace from 'onnxruntime-web/webgpu';

type Ort = typeof OrtNamespace;
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;
type Feeds = Parameters<Session['run']>[0];
type Provider = 'webgpu' | 'wasm';

async function runtime(): Promise<Ort> {
  const ort = await import('onnxruntime-web/webgpu');
  const wasmUrl = (await import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url')).default;
  ort.env.wasm.wasmPaths = { wasm: wasmUrl };
  return ort;
}

const ATTENTION_INPUTS: Record<string, readonly number[]> = {
  vision_features: [4096, 1, 256],
  vision_position_embeddings: [4096, 1, 256],
  memory: [3648, 1, 64],
  memory_position_embeddings: [3648, 1, 64],
  key_mask: [1, 1, 1, 3648],
};

const ENCODER_INPUTS: Record<string, readonly number[]> = {
  vision_features: [1, 256, 64, 64],
  mask_for_memory: [1, 1, 1024, 1024],
};

const elements = (dims: readonly number[]): number => dims.reduce((a, b) => a * b, 1);

/**
 * Plausible values, not zeros.
 *
 * A tensor of zeros can be several times faster than real data on hardware that
 * skips denormals or compresses uniform pages, and the point is to measure the
 * frame that will actually be run.
 */
function filled(count: number, seed: number): Float32Array {
  const out = new Float32Array(count);
  let state = seed >>> 0;
  for (let i = 0; i < count; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = ((state >>> 8) / 8388608 - 1) * 0.5;
  }
  return out;
}

/** The bank holds `valid` real slots; the rest are masked out of the softmax. */
function keyMask(valid: number, total: number): Float32Array {
  const mask = new Float32Array(total);
  for (let i = valid; i < total; i++) mask[i] = -1e9;
  return mask;
}

function feeds(
  ort: Ort,
  spec: Record<string, readonly number[]>,
  validKeys?: number,
): Record<string, InstanceType<Ort['Tensor']>> {
  const out: Record<string, InstanceType<Ort['Tensor']>> = {};
  let seed = 1;
  for (const [name, dims] of Object.entries(spec)) {
    const data =
      name === 'key_mask' && validKeys !== undefined
        ? keyMask(validKeys, elements(dims))
        : filled(elements(dims), seed++);
    out[name] = new ort.Tensor('float32', data, [...dims]);
  }
  return out;
}

/**
 * Time N runs.
 *
 * WITH THE OUTPUTS LEFT ON THE GPU, `run` IS NOT A FENCE. It returns once the
 * work is submitted, and the readback that would otherwise have forced a wait
 * is exactly what was removed. Measured without the fence the first sample
 * reads 10 ms and every later one reads 58 ms, because the queue is doing the
 * waiting instead. So the runtime's own device is fenced explicitly here, the
 * same way every other number in this project is taken.
 */
async function timeRuns(
  ort: Ort,
  session: Session,
  inputs: Feeds,
  n: number,
  disposeOutputs: boolean,
): Promise<Stat> {
  const device = await runtimeDevice(ort);
  const fence = async (): Promise<void> => {
    if (disposeOutputs) await device?.queue.onSubmittedWorkDone();
  };

  // Two warm-ups: the first run compiles every pipeline the graph needs.
  for (let i = 0; i < 2; i++) {
    const warm = await session.run(inputs);
    await fence();
    if (disposeOutputs) for (const tensor of Object.values(warm)) tensor.dispose();
  }
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const outputs = await session.run(inputs);
    await fence();
    samples.push(performance.now() - t0);
    if (disposeOutputs) for (const tensor of Object.values(outputs)) tensor.dispose();
  }
  return stats(samples);
}

interface GraphCase {
  readonly name: string;
  readonly url: string;
  readonly spec: Record<string, readonly number[]>;
  readonly validKeys?: number;
}

async function measure(ort: Ort, graph: GraphCase, providers: readonly Provider[]): Promise<unknown> {
  const out: Record<string, unknown> = {};

  const t0 = performance.now();
  const bytes = await (await fetch(graph.url)).arrayBuffer();
  out.fetch_ms = Math.round(performance.now() - t0);
  out.model_mb = Math.round(bytes.byteLength / 1e5) / 10;

  for (const provider of providers) {
    const label = provider;
    try {
      const tCreate = performance.now();
      const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
        executionProviders: [provider],
      });
      const createMs = Math.round(performance.now() - tCreate);

      const cpuFeeds = feeds(ort, graph.spec, graph.validKeys);
      const cpuOut = await timeRuns(ort, session, cpuFeeds, 15, false);
      await session.release();

      // Again with the outputs left on the GPU, which is what the real pipeline
      // wants: conditioned_features feeds the mask decoder and never needs to
      // be seen by JavaScript.
      let gpuOut: Stat | string = 'skipped';
      let gpuCreateMs = 0;
      if (provider === 'webgpu') {
        const tGpu = performance.now();
        const gpuSession = await ort.InferenceSession.create(new Uint8Array(bytes), {
          executionProviders: ['webgpu'],
          preferredOutputLocation: 'gpu-buffer',
        });
        gpuCreateMs = Math.round(performance.now() - tGpu);
        gpuOut = await timeRuns(ort, gpuSession, feeds(ort, graph.spec, graph.validKeys), 15, true);
        await gpuSession.release();
      }

      out[label] = {
        session_create_ms: createMs,
        run_ms_cpu_outputs: cpuOut,
        session_create_ms_gpu_outputs: gpuCreateMs,
        run_ms_gpu_outputs: gpuOut,
      };
    } catch (error) {
      out[label] = { error: String(error) };
    }
  }
  return out;
}

export async function attention(onnxBase: string): Promise<unknown> {
  const ort = await runtime();
  return {
    what: 'the two graphs tracking needs, run on the runtime Rotyl already ships',
    ort_version: ort.env.versions?.web ?? 'unknown',
    memory_attention: await measure(
      ort,
      {
        name: 'memory_attention',
        url: `${onnxBase}/memory_attention.onnx`,
        spec: ATTENTION_INPUTS,
        validKeys: 3648,
      },
      ['webgpu', 'wasm'],
    ),
    memory_encoder: await measure(
      ort,
      { name: 'memory_encoder', url: `${onnxBase}/memory_encoder.onnx`, spec: ENCODER_INPUTS },
      ['webgpu', 'wasm'],
    ),
  };
}

/** Does masking most of the bank buy anything? It should not, and that is worth knowing. */
export async function bankRampUp(onnxBase: string): Promise<unknown> {
  const ort = await runtime();
  const bytes = await (await fetch(`${onnxBase}/memory_attention.onnx`)).arrayBuffer();
  const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ['webgpu'],
    preferredOutputLocation: 'gpu-buffer',
  });
  const out: Record<string, Stat> = {};
  for (const valid of [64, 576, 1600, 3648]) {
    out[`valid_${String(valid)}`] = await timeRuns(
      ort,
      session,
      feeds(ort, ATTENTION_INPUTS, valid),
      10,
      true,
    );
  }
  await session.release();
  return out;
}
