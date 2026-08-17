// Can the inference runtime be made to use OUR device after all?
//
// The comment in edgetam-engine.ts records that both routes were tried and
// both failed. Reading the shipped bundle says the EP `device` option is not
// dead code on this build: `onnxruntime-web/webgpu` compiles the branch that
// calls `webgpuRegisterDevice(customDevice)`, where the default build compiles
// the JSEP fallback instead. The runtime's own documentation adds a condition
// that a caller has no way to guess: it creates its device with a specific set
// of features and limits, and a device made with different ones is not
// guaranteed to work.
//
// So the question is narrower than "does it work": does it work when the
// device is created the way the runtime would have created it. That is worth
// settling, because a shared device deletes the readback for the image path as
// well as the video one.

import { runtimeDevice } from './util.ts';

import type * as OrtNamespace from 'onnxruntime-web/webgpu';

const CANDIDATE_FEATURES = ['shader-f16', 'subgroups', 'timestamp-query'] as const;

type Ort = typeof OrtNamespace;

/**
 * A fresh adapter each time: an adapter can only ever produce one device, which
 * render-device.ts already records as the reason a rebuild restarts from
 * requestAdapter.
 */
async function deviceLike(features: readonly string[]): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no adapter');
  const limits = adapter.limits;
  return adapter.requestDevice({
    label: 'rotyl-shared',
    requiredFeatures: features.filter((name): name is GPUFeatureName => adapter.features.has(name)),
    // The eight the runtime mirrors, plus the texture dimension Rotyl needs.
    requiredLimits: {
      maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
      maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      maxBufferSize: limits.maxBufferSize,
      maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
      maxComputeWorkgroupSizeY: limits.maxComputeWorkgroupSizeY,
      maxComputeWorkgroupSizeZ: limits.maxComputeWorkgroupSizeZ,
      maxTextureDimension2D: limits.maxTextureDimension2D,
    },
  });
}

export async function sharedDevice(modelUrl: string): Promise<unknown> {
  const ort: Ort = await import('onnxruntime-web/webgpu');
  const wasmUrl = (await import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url')).default;
  ort.env.wasm.wasmPaths = { wasm: wasmUrl };

  const probe = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!probe) return { error: 'no adapter' };
  const adapterFeatures = [...probe.features];
  const bytes = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());

  const attempts: Record<string, unknown> = {};

  const attempt = async (
    name: string,
    features: readonly string[],
    build: (device: GPUDevice) => Parameters<Ort['InferenceSession']['create']>[1],
  ): Promise<void> => {
    let device: GPUDevice;
    try {
      device = await deviceLike(features);
    } catch (error) {
      attempts[name] = { device_error: String(error) };
      return;
    }
    try {
      const session = await ort.InferenceSession.create(bytes, build(device));
      const theirs = await runtimeDevice(ort);
      // Prove it, rather than trusting that creation succeeding means it took
      // the device: run with an input buffer that only OUR device could have
      // made. A runtime on a different device rejects it.
      let crossDevice: unknown = 'not attempted';
      try {
        const ours = device.createBuffer({
          size: 1 * 256 * 64 * 64 * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        const mask = device.createBuffer({
          size: 1024 * 1024 * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        const outputs = await session.run({
          vision_features: ort.Tensor.fromGpuBuffer(ours, { dataType: 'float32', dims: [1, 256, 64, 64] }),
          mask_for_memory: ort.Tensor.fromGpuBuffer(mask, { dataType: 'float32', dims: [1, 1, 1024, 1024] }),
        });
        crossDevice = { ok: true, outputs: Object.keys(outputs) };
        ours.destroy();
        mask.destroy();
      } catch (error) {
        crossDevice = { ok: false, error: String(error) };
      }
      attempts[name] = {
        session: 'created',
        runtime_device_is_ours: theirs === device,
        our_buffer_as_input: crossDevice,
      };
      await session.release();
    } catch (error) {
      attempts[name] = { session_error: String(error) };
    }
    device.destroy();
  };

  await attempt('ep_option_features_matched', CANDIDATE_FEATURES, (device) => ({
    executionProviders: [{ name: 'webgpu', device }],
  }));
  await attempt('ep_option_no_features', [], (device) => ({
    executionProviders: [{ name: 'webgpu', device }],
  }));
  await attempt('env_device_features_matched', CANDIDATE_FEATURES, (device) => {
    ort.env.webgpu.device = device;
    return { executionProviders: ['webgpu'] };
  });

  return {
    what: 'whether onnxruntime-web 1.27 will run on a device it did not create',
    adapter_features: adapterFeatures,
    attempts,
  };
}
