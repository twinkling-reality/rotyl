import type { SelectionMask } from '../src/core/mask/selection-mask.ts';

/**
 * Reading a selection mask back, shared by the files that assert on one.
 *
 * Extracted rather than duplicated because the row-stride unpacking is the kind
 * of thing that gets fixed in one copy and not the other, and a mask test that
 * reads the wrong bytes fails in a way that looks like a shader bug.
 */

export const MASK_SIZE = 128;

/** Coverage bytes, one per texel, de-padded from the 256-byte row alignment. */
export async function readMask(
  device: GPUDevice,
  mask: SelectionMask,
  size = MASK_SIZE,
): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil(size / 256) * 256;
  const staging = device.createBuffer({
    size: bytesPerRow * (size - 1) + size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: mask.texture },
    { buffer: staging, bytesPerRow },
    { width: size, height: size },
  );
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(staging.getMappedRange()).slice();
  staging.unmap();
  staging.destroy();

  const packed = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    packed.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + size), y * size);
  }
  return packed;
}

export function at(coverage: Uint8Array, x: number, y: number, size = MASK_SIZE): number {
  return coverage[y * size + x] ?? 0;
}
