// Memory attention at half precision.
//
// 61 ms per tracked frame is the single largest item in the tracking budget, so
// what fp16 buys is worth knowing before anything is designed around the fp32
// number. It is also the same question as the download: the graph halves.
//
// Converted with onnxconverter-common's float16 pass, keep_io_types=True, so
// the graph's inputs and outputs stay fp32 and only the interior is halved.
// That keeps the caller unchanged and isolates the measurement to compute.
//
// Agreement is checked against the fp32 graph on the same inputs, because the
// only interesting answer is one that is both faster AND right.

import { runtimeDevice, stats, type Stat } from './util.ts';
import type * as OrtNamespace from 'onnxruntime-web/webgpu';

type Ort = typeof OrtNamespace;
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;
type Feeds = Parameters<Session['run']>[0];

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

function filled(count: number, seed: number): Float32Array {
  const out = new Float32Array(count);
  let state = seed >>> 0;
  for (let i = 0; i < count; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = ((state >>> 8) / 8388608 - 1) * 0.5;
  }
  return out;
}

function feeds(ort: Ort, spec: Record<string, readonly number[]>): Feeds {
  const out: Record<string, InstanceType<Ort['Tensor']>> = {};
  let seed = 1;
  for (const [name, dims] of Object.entries(spec)) {
    const count = dims.reduce((a, b) => a * b, 1);
    // key_mask is additive and -1e30 in fp16 is -inf, which is exactly the
    // thing verify.py warns against. A full bank has no masked slot, so this
    // measures the shape that always runs.
    const data = name === 'key_mask' ? new Float32Array(count) : filled(count, seed++);
    out[name] = new ort.Tensor('float32', data, [...dims]);
  }
  return out;
}

async function timeRuns(ort: Ort, session: Session, inputs: Feeds, n: number): Promise<Stat> {
  const device = await runtimeDevice(ort);
  for (let i = 0; i < 3; i++) {
    const warm = await session.run(inputs);
    await device?.queue.onSubmittedWorkDone();
    for (const tensor of Object.values(warm)) tensor.dispose();
  }
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const outputs = await session.run(inputs);
    await device?.queue.onSubmittedWorkDone();
    samples.push(performance.now() - t0);
    for (const tensor of Object.values(outputs)) tensor.dispose();
  }
  return stats(samples);
}

async function compare(
  ort: Ort,
  base: string,
  name: string,
  spec: Record<string, readonly number[]>,
): Promise<unknown> {
  const out: Record<string, unknown> = {};
  const inputs = feeds(ort, spec);

  const truth: Record<string, Float32Array> = {};
  // FOUR VARIANTS OF ONE GRAPH, as a list rather than as four code paths, which
  // is what made adding the last two a line. `_shared` is the same graph with
  // the tracer's duplicated rotary tables hoisted out of Constant nodes and
  // shared; it must agree to the bit, and the interesting question about it is
  // whether a tensor read from six places costs anything on this backend.
  for (const [suffix, label] of [
    ['', 'fp32'],
    ['_fp16', 'fp16'],
    ['_shared', 'shared'],
    ['_shared_fp16', 'shared fp16'],
  ] as const) {
    const url = `${base}/${name}${suffix}.onnx`;
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const tCreate = performance.now();
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['webgpu'],
      preferredOutputLocation: 'gpu-buffer',
    });
    const createMs = Math.round(performance.now() - tCreate);
    const timing = await timeRuns(ort, session, inputs, 15);
    await session.release();

    // Again with CPU outputs, only to read the values back for the comparison.
    const check = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
    const results = await check.run(inputs);
    const agreement: Record<string, unknown> = {};
    for (const [key, tensor] of Object.entries(results)) {
      const values = tensor.data;
      if (!(values instanceof Float32Array)) continue;
      if (label === 'fp32') {
        truth[key] = values;
        continue;
      }
      // Every variant is compared against the fp32 graph rather than against
      // the one before it, so "shared" is a claim about the export and not
      // about the conversion that happens to precede it in this list.
      const reference = truth[key];
      if (!reference) continue;
      let worst = 0;
      let magnitude = 0;
      let sum = 0;
      for (let i = 0; i < values.length; i++) {
        const delta = Math.abs((values[i] ?? 0) - (reference[i] ?? 0));
        worst = Math.max(worst, delta);
        sum += delta;
        magnitude = Math.max(magnitude, Math.abs(reference[i] ?? 0));
      }
      agreement[key] = {
        max_abs_diff: Math.round(worst * 1e5) / 1e5,
        mean_abs_diff: Math.round((sum / values.length) * 1e6) / 1e6,
        max_abs_value: Math.round(magnitude * 1e3) / 1e3,
      };
    }
    await check.release();

    out[label] = {
      model_mb: Math.round(bytes.byteLength / 1e5) / 10,
      session_create_ms: createMs,
      run_ms: timing,
      ...(label === 'fp32' ? {} : { agreement_vs_fp32: agreement }),
    };
  }
  return out;
}

export async function halfPrecision(base: string): Promise<unknown> {
  const ort: Ort = await import('onnxruntime-web/webgpu');
  const wasmUrl = (await import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url')).default;
  ort.env.wasm.wasmPaths = { wasm: wasmUrl };
  return {
    what: 'the tracking graphs at half precision, against the same inputs',
    memory_attention: await compare(ort, base, 'memory_attention', ATTENTION_INPUTS),
    memory_encoder: await compare(ort, base, 'memory_encoder', ENCODER_INPUTS),
  };
}
