// Measurement helpers. Outside src/ deliberately: a measurement tool, not part
// of the product.
//
// Every GPU number here is fenced with queue.onSubmittedWorkDone(). rAF is not
// used anywhere: it throttles when the pane is hidden, which silently turns a
// 3 ms number into a 16 ms one.

export interface Stat {
  readonly n: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

export function stats(samples: readonly number[]): Stat {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    median: round(sorted[sorted.length >> 1] ?? 0),
    min: round(sorted[0] ?? 0),
    max: round(sorted.at(-1) ?? 0),
  };
}

export async function sample(
  n: number,
  warmup: number,
  fn: (iteration: number) => Promise<void> | void,
): Promise<Stat> {
  for (let i = 0; i < warmup; i++) await fn(-1 - i);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    out.push(performance.now() - t0);
  }
  return stats(out);
}

export async function device(): Promise<GPUDevice> {
  const gpu = navigator.gpu;
  if (!gpu) throw new Error('no WebGPU');
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no adapter');
  return adapter.requestDevice({
    requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
  });
}

export async function adapterInfo(): Promise<Record<string, unknown>> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  const info = adapter?.info;
  return {
    vendor: info?.vendor,
    architecture: info?.architecture,
    device: info?.device,
    description: info?.description,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
}

/** Served by the dev server from the project root; see the README. */
export const CLIPS = '/tools/video-bench/clips';
export const ONNX = '/tools/edgetam-export/onnx';

/** A source texture in Rotyl's colour contract, filled with real-ish detail. */
export function sourceTexture(dev: GPUDevice, width: number, height: number): GPUTexture {
  const texture = dev.createTexture({
    label: 'bench-source',
    size: { width, height },
    format: 'rgba8unorm',
    viewFormats: ['rgba8unorm-srgb'],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  // One row of noise, repeated. Enough that nothing downstream can constant-fold
  // and cheap enough not to dominate setup.
  const row = new Uint8Array(width * 4);
  for (let i = 0; i < row.length; i++) row[i] = (i * 37 + (i >> 5) * 91) & 0xff;
  const block = new Uint8Array(width * 4 * 64);
  for (let y = 0; y < 64; y++) block.set(row, y * width * 4);
  for (let y = 0; y < height; y += 64) {
    const rows = Math.min(64, height - y);
    dev.queue.writeTexture(
      { texture, origin: { x: 0, y } },
      block,
      { bytesPerRow: width * 4, rowsPerImage: rows },
      { width, height: rows },
    );
  }
  return texture;
}

/**
 * Decode exactly one frame, and give the decoder back.
 *
 * A VideoDecoder that is never closed holds a hardware decode session. Enough
 * of them and the next `configure` produces no output at all, with no error -
 * which is exactly the failure the WebCodecs spec warns about for frames, and
 * it looks like a hang rather than a leak. Every one-shot decode in this
 * harness goes through here.
 */
export async function decodeOne(config: VideoDecoderConfig, chunk: EncodedVideoChunk): Promise<VideoFrame> {
  let decoder: VideoDecoder | undefined;
  try {
    return await new Promise<VideoFrame>((resolve, reject) => {
      decoder = new VideoDecoder({ output: resolve, error: reject });
      decoder.configure({ ...config, optimizeForLatency: true });
      decoder.decode(chunk);
      void decoder.flush().catch(reject);
    });
  } finally {
    if (decoder && decoder.state !== 'closed') decoder.close();
  }
}

/**
 * The device the inference runtime made for itself.
 *
 * Typed as `Promise<GPUDevice>` by onnxruntime-common and returned as a plain
 * `GPUDevice` at runtime once a session exists - `createBuffer` is callable on
 * it and `limits.maxTextureDimension2D` reads 8192. Awaiting is correct for
 * both, and is also what makes the comparison against our own device a
 * comparison of two devices rather than of a device and a promise.
 */
export async function runtimeDevice(ort: {
  env: { webgpu: { device?: GPUDevice | Promise<GPUDevice> } };
}): Promise<GPUDevice | undefined> {
  return (await ort.env.webgpu.device) ?? undefined;
}
