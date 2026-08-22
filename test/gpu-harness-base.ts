import { acquireRenderDevice, type RenderDevice } from '../src/core/gpu/render-device.ts';

/** Shared GPU fixture; only acquiring the platform GPU differs between Node and Chrome. */
export function gpuHarness(platformGpu: () => GPU | undefined) {
  let cached: Promise<RenderDevice> | undefined;
  const cleanups: (() => void)[] = [];

  const testDevice = (): Promise<RenderDevice> => {
    cached ??= (async () => {
      const result = await acquireRenderDevice(platformGpu());
      if (!result.ok) throw new Error(`no GPU in test environment: ${result.reason}`);
      return result.value;
    })();
    return cached;
  };

  const disposeWithTestDevice = (dispose: () => void): void => {
    cleanups.push(dispose);
  };

  const disposeTestGpu = async (): Promise<void> => {
    const pending = cached;
    cached = undefined;
    if (!pending) return;

    const { device } = await pending;
    await device.queue.onSubmittedWorkDone();
    for (const dispose of cleanups.splice(0)) dispose();
    device.destroy();
  };

  return { testDevice, disposeWithTestDevice, disposeTestGpu };
}

/** Read a texture back as tightly-packed RGBA bytes. */
export async function readTextureRgba(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const unpaddedBytesPerRow = width * 4;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const size = Math.ceil((bytesPerRow * (height - 1) + unpaddedBytesPerRow) / 4) * 4;

  const staging = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, { width, height });
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(staging.getMappedRange()).slice();
  staging.unmap();
  staging.destroy();

  const packed = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    packed.set(
      padded.subarray(y * bytesPerRow, y * bytesPerRow + unpaddedBytesPerRow),
      y * unpaddedBytesPerRow,
    );
  }
  return packed;
}

/** Upload tightly-packed RGBA bytes into a texture. */
export function writeTextureRgba(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  pixels: Uint8Array,
): void {
  device.queue.writeTexture(
    { texture },
    pixels,
    { bytesPerRow: width * 4, rowsPerImage: height },
    { width, height },
  );
}
