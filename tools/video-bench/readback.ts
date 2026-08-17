// MEASUREMENT 1: the 12 MB per-frame tensor readback.
//
// ONNX Runtime creates its own GPUDevice whatever it is handed, so the model's
// input tensor is built on Rotyl's GPU and read back across the PCIe boundary:
// 12 MB, once per image today. At 30 fps that is 360 MB/s, and it is the thing
// most likely to bind a video tracker.
//
// Three questions, in order of how much they change the architecture:
//   A  what does the readback actually cost, serial and pipelined
//   B  what does the memcpy out of the mapped range cost, separately
//   C  is the readback avoidable at all - can ORT's own device be reached, and
//      will it take an input tensor that is already a GPUBuffer

import { FrameTensorEncoder } from '../../src/core/perception/frame-tensor.ts';
import { CLIPS, decodeOne, runtimeDevice, sample, sourceTexture, stats, type Stat } from './util.ts';
import type * as OrtNamespace from 'onnxruntime-web/webgpu';

const INPUT_SIZE = 1024;
const PLANE_BYTES = INPUT_SIZE * INPUT_SIZE * 4;
const TENSOR_BYTES = 3 * PLANE_BYTES;

type Ort = typeof OrtNamespace;

const LAYOUT = {
  size: INPUT_SIZE,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
} as const;

/** The three r32float planes the real encoder copies from, without the shader. */
function planes(dev: GPUDevice): GPUTexture[] {
  return [0, 1, 2].map((i) =>
    dev.createTexture({
      label: `bench-plane-${String(i)}`,
      size: { width: INPUT_SIZE, height: INPUT_SIZE },
      format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    }),
  );
}

function recordCopies(dev: GPUDevice, src: readonly GPUTexture[], dst: GPUBuffer): GPUCommandBuffer {
  const encoder = dev.createCommandEncoder();
  src.forEach((texture, index) => {
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: dst, offset: index * PLANE_BYTES, bytesPerRow: INPUT_SIZE * 4, rowsPerImage: INPUT_SIZE },
      { width: INPUT_SIZE, height: INPUT_SIZE },
    );
  });
  return encoder.finish();
}

function staging(dev: GPUDevice, label: string): GPUBuffer {
  return dev.createBuffer({
    label,
    size: TENSOR_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
}

/** A: the real FrameTensorEncoder, end to end, exactly as object selection uses it. */
async function realEncoder(dev: GPUDevice, width: number, height: number): Promise<Record<string, Stat>> {
  const source = sourceTexture(dev, width, height);
  const view = source.createView({ format: 'rgba8unorm-srgb' });
  const size = { width, height };
  const encoder = new FrameTensorEncoder(dev, LAYOUT);

  const gpu: number[] = [];
  const read: number[] = [];
  const whole: number[] = [];

  for (let i = 0; i < 25; i++) {
    const t0 = performance.now();
    const commands = dev.createCommandEncoder();
    encoder.encode(commands, view, size);
    dev.queue.submit([commands.finish()]);
    await dev.queue.onSubmittedWorkDone();
    const t1 = performance.now();
    await encoder.read();
    const t2 = performance.now();
    if (i >= 5) {
      gpu.push(t1 - t0);
      read.push(t2 - t1);
      whole.push(t2 - t0);
    }
  }

  encoder.dispose();
  source.destroy();
  return { pass_and_copy_fenced: stats(gpu), map_and_copy_out: stats(read), total: stats(whole) };
}

/** B: the readback alone, split into its parts. */
async function readbackParts(dev: GPUDevice): Promise<Record<string, Stat | number>> {
  const src = planes(dev);
  const buffer = staging(dev, 'bench-staging');

  const copyOnly = await sample(20, 5, async () => {
    dev.queue.submit([recordCopies(dev, src, buffer)]);
    await dev.queue.onSubmittedWorkDone();
  });

  const mapNoCopy = await sample(20, 5, async () => {
    dev.queue.submit([recordCopies(dev, src, buffer)]);
    await dev.queue.onSubmittedWorkDone();
    await buffer.mapAsync(GPUMapMode.READ);
    // Touch the range so the map cannot be elided, but do not copy out of it.
    const view = new Float32Array(buffer.getMappedRange(), 0, 4);
    if (view.length !== 4) throw new Error('impossible');
    buffer.unmap();
  });

  const mapAndCopy = await sample(20, 5, async () => {
    dev.queue.submit([recordCopies(dev, src, buffer)]);
    await dev.queue.onSubmittedWorkDone();
    await buffer.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(buffer.getMappedRange().slice(0));
    if (out.length !== TENSOR_BYTES / 4) throw new Error('short read');
    buffer.unmap();
  });

  // The memcpy on its own: 12 MB of ordinary host memory to host memory.
  const host = new ArrayBuffer(TENSOR_BYTES);
  const memcpy = await sample(20, 5, () => {
    const out = new Float32Array(host.slice(0));
    if (out.length !== TENSOR_BYTES / 4) throw new Error('short copy');
  });

  for (const texture of src) texture.destroy();
  buffer.destroy();
  return {
    copy_to_buffer_fenced: copyOnly,
    map_only: mapNoCopy,
    map_and_copy: mapAndCopy,
    host_memcpy: memcpy,
  };
}

/**
 * B2: sustained rate with a ring of staging buffers.
 *
 * Serial (depth 1) is what the code does today: submit, fence, map, copy, and
 * nothing overlaps. With a ring the map of frame N overlaps the GPU work of
 * frame N+1, which is the whole question for a 30 fps tracker.
 */
async function sustained(dev: GPUDevice, depth: number, frames: number): Promise<Record<string, number>> {
  const src = planes(dev);
  const buffers = Array.from({ length: depth }, (_, i) => staging(dev, `bench-ring-${String(i)}`));
  const pending: (Promise<void> | undefined)[] = Array.from({ length: depth });
  let bytes = 0;

  const run = async (count: number): Promise<number> => {
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      const slot = i % depth;
      await pending[slot];
      const buffer = buffers[slot];
      if (!buffer) throw new Error('no buffer');
      dev.queue.submit([recordCopies(dev, src, buffer)]);
      pending[slot] = (async () => {
        await buffer.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(buffer.getMappedRange().slice(0));
        bytes += out.byteLength;
        buffer.unmap();
      })();
    }
    await Promise.all(pending.filter((p) => p !== undefined));
    return performance.now() - t0;
  };

  await run(depth * 2);
  const elapsed = await run(frames);

  for (const texture of src) texture.destroy();
  for (const buffer of buffers) buffer.destroy();
  return {
    depth,
    frames,
    ms_per_frame: Math.round((elapsed / frames) * 1000) / 1000,
    fps: Math.round((frames / elapsed) * 1000),
    mb_per_s: Math.round((frames * TENSOR_BYTES) / elapsed / 1000),
  };
}

export async function readback(dev: GPUDevice): Promise<unknown> {
  return {
    what: '1024x1024x3 float32 = 12.58 MB, the EdgeTAM input tensor',
    fence: 'queue.onSubmittedWorkDone() before every read; mapAsync awaited',
    real_encoder_1920x1080: await realEncoder(dev, 1920, 1080),
    real_encoder_4032x3024: await realEncoder(dev, 4032, 3024),
    parts: await readbackParts(dev),
    sustained: [
      await sustained(dev, 1, 60),
      await sustained(dev, 2, 60),
      await sustained(dev, 3, 60),
      await sustained(dev, 4, 60),
    ],
  };
}

/**
 * C: can the readback be avoided.
 *
 * Two things have to be true. ORT has to expose the device it made, and it has
 * to accept an input tensor that is a GPUBuffer on that device. If both hold,
 * then for VIDEO the tensor never has to cross at all: a VideoFrame can be
 * imported by any device, so the encode runs on ORT's device and the 12 MB
 * stays put. The image path cannot use this - its source texture belongs to
 * Rotyl's device and textures are not shareable between devices - but video is
 * the case that needs it.
 */
export async function ortDevice(ourDevice: GPUDevice, modelUrl: string): Promise<unknown> {
  const ort = await import('onnxruntime-web/webgpu');
  const wasmUrl = (await import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url')).default;
  ort.env.wasm.wasmPaths = { wasm: wasmUrl };

  const out: Record<string, unknown> = { version: ort.env.versions?.web ?? 'unknown' };

  out.device_before_session = describeDevice(await runtimeDevice(ort));

  // Documented as ignored. Asked again, against this version, rather than
  // inherited as a belief.
  let setAccepted: unknown = false;
  try {
    ort.env.webgpu.device = ourDevice;
    setAccepted = (await runtimeDevice(ort)) === ourDevice;
  } catch (error) {
    setAccepted = `threw: ${String(error)}`;
  }
  out.assigning_our_device = setAccepted;

  let session: Awaited<ReturnType<typeof ort.InferenceSession.create>>;
  const t0 = performance.now();
  try {
    session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['webgpu'] });
  } catch (error) {
    out.session_error = String(error);
    return out;
  }
  out.session_create_ms = Math.round(performance.now() - t0);

  const theirs = await runtimeDevice(ort);
  out.device_after_session = describeDevice(theirs);
  out.device_is_ours = theirs === ourDevice;

  // Does a GPUBuffer input work at all, and does it give the SAME ANSWER?
  // "It ran" is not the question. This runtime has previous form for being
  // silently wrong on a path that raises no error.
  //
  // memory_encoder wants vision_features [1,256,64,64] and
  // mask_for_memory [1,1,1024,1024].
  if (theirs) {
    const dims: Record<string, readonly number[]> = {
      vision_features: [1, 256, 64, 64],
      mask_for_memory: [1, 1, 1024, 1024],
    };
    const data: Record<string, Float32Array> = {};
    let seed = 7;
    for (const [name, shape] of Object.entries(dims)) {
      const count = shape.reduce((a, b) => a * b, 1);
      const values = new Float32Array(count);
      let state = (seed = (seed * 2654435761) >>> 0);
      for (let i = 0; i < count; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        values[i] = ((state >>> 8) / 8388608 - 1) * 0.5;
      }
      data[name] = values;
    }

    const cpuFeeds: Record<string, InstanceType<Ort['Tensor']>> = {};
    for (const [name, shape] of Object.entries(dims)) {
      cpuFeeds[name] = new ort.Tensor('float32', data[name] ?? new Float32Array(0), [...shape]);
    }
    const cpuOut = await session.run(cpuFeeds);

    try {
      const gpuFeeds: Record<string, InstanceType<Ort['Tensor']>> = {};
      const owned: GPUBuffer[] = [];
      for (const [name, shape] of Object.entries(dims)) {
        const values = data[name] ?? new Float32Array(0);
        const buffer = theirs.createBuffer({
          label: `bench-${name}`,
          size: values.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        theirs.queue.writeBuffer(buffer, 0, values);
        owned.push(buffer);
        gpuFeeds[name] = ort.Tensor.fromGpuBuffer(buffer, { dataType: 'float32', dims: [...shape] });
      }
      await theirs.queue.onSubmittedWorkDone();
      const gpuOut = await session.run(gpuFeeds);

      const agreement: Record<string, unknown> = {};
      for (const name of Object.keys(cpuOut)) {
        const a = cpuOut[name]?.data;
        const b = gpuOut[name]?.data;
        if (!(a instanceof Float32Array) || !(b instanceof Float32Array)) {
          agreement[name] = 'not float data';
          continue;
        }
        let worst = 0;
        let magnitude = 0;
        for (let i = 0; i < a.length; i++) {
          worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
          magnitude = Math.max(magnitude, Math.abs(a[i] ?? 0));
        }
        agreement[name] = { max_abs_diff: worst, max_abs_value: magnitude, elements: a.length };
      }

      // What it saves: the same run with the input arriving as a CPU array.
      const timeIt = async (feeds: Record<string, InstanceType<Ort['Tensor']>>): Promise<number> => {
        for (let i = 0; i < 3; i++) await session.run(feeds);
        const samples: number[] = [];
        for (let i = 0; i < 10; i++) {
          const t = performance.now();
          await session.run(feeds);
          samples.push(performance.now() - t);
        }
        return Math.round(stats(samples).median * 100) / 100;
      };

      out.gpu_buffer_input = {
        ok: true,
        outputs: Object.keys(gpuOut),
        agreement,
        run_ms_cpu_input: await timeIt(cpuFeeds),
        run_ms_gpu_input: await timeIt(gpuFeeds),
      };
      for (const buffer of owned) buffer.destroy();
    } catch (error) {
      out.gpu_buffer_input = { ok: false, error: String(error) };
    }

    // The other half of the video path: can the runtime's device take a decoded
    // frame directly? If it can, the tensor never has to cross at all.
    out.ort_device_accepts_videoframe = await importsVideoFrame(theirs);
  }

  await session.release();
  return out;
}

/**
 * A VideoFrame is not owned by any device, which is the point. If ORT's device
 * can import one, the frame-tensor pass can run there and the 12 MB stays put.
 */
async function importsVideoFrame(target: GPUDevice): Promise<unknown> {
  try {
    const { BlobSource, EncodedPacketSink, Input, MP4 } = await import('mediabunny');
    const url = `${CLIPS}/1080p30-gop30.mp4`;
    const blob = await (await fetch(url)).blob();
    const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return 'no video track';
    const config = await track.getDecoderConfig();
    if (!config) return 'no decoder config';
    const packet = await new EncodedPacketSink(track).getFirstKeyPacket();
    if (!packet) return 'no key packet';

    const frame = await decodeOne(config, packet.toEncodedVideoChunk());
    input.dispose();

    const texture = target.createTexture({
      size: { width: frame.displayWidth, height: frame.displayHeight },
      format: 'rgba8unorm',
      viewFormats: ['rgba8unorm-srgb'],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    target.queue.copyExternalImageToTexture(
      { source: frame, flipY: false },
      { texture, premultipliedAlpha: false },
      { width: frame.displayWidth, height: frame.displayHeight },
    );
    await target.queue.onSubmittedWorkDone();
    texture.destroy();
    frame.close();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function describeDevice(device: GPUDevice | undefined): unknown {
  if (!device) return null;
  return {
    // Reported rather than assumed: the runtime's type for this says
    // Promise<GPUDevice> and the value is a device.
    isGPUDevice: typeof device.createBuffer === 'function',
    label: device.label,
    maxTextureDimension2D: device.limits.maxTextureDimension2D,
  };
}
