import { describe, expect, it } from 'vitest';
import { testDevice } from './gpu-harness.ts';
import { SelectionMask } from '../src/core/mask/selection-mask.ts';
import type { SelectionCommand } from '../src/core/document/selection-command.ts';

const SIZE = 128;

/** Read the mask back as coverage bytes, one per texel. */
async function readMask(device: GPUDevice, mask: SelectionMask): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil(SIZE / 256) * 256;
  const staging = device.createBuffer({
    size: bytesPerRow * (SIZE - 1) + SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: mask.texture },
    { buffer: staging, bytesPerRow },
    { width: SIZE, height: SIZE },
  );
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(staging.getMappedRange()).slice();
  staging.unmap();
  staging.destroy();

  const packed = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    packed.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + SIZE), y * SIZE);
  }
  return packed;
}

function at(coverage: Uint8Array, x: number, y: number): number {
  return coverage[y * SIZE + x] ?? 0;
}

async function replayed(commands: readonly SelectionCommand[]): Promise<Uint8Array> {
  const { device } = await testDevice();
  const mask = new SelectionMask(device, SIZE, SIZE);
  mask.beginFrame();
  const encoder = device.createCommandEncoder();
  mask.replay(encoder, commands);
  device.queue.submit([encoder.finish()]);
  const coverage = await readMask(device, mask);
  mask.dispose();
  return coverage;
}

const horizontalStroke = {
  points: [
    { x: 24, y: 64 },
    { x: 104, y: 64 },
  ],
  radius: 12,
  hardness: 1,
};

describe('brush stamping', () => {
  it('covers the stroke and leaves the rest untouched', async () => {
    const coverage = await replayed([{ kind: 'paint', stroke: horizontalStroke }]);

    expect(at(coverage, 64, 64)).toBeGreaterThan(250);
    expect(at(coverage, 24, 64)).toBeGreaterThan(250);
    expect(at(coverage, 104, 64)).toBeGreaterThan(250);
    // Well outside the capsule.
    expect(at(coverage, 64, 10)).toBe(0);
    expect(at(coverage, 5, 64)).toBe(0);
  });

  it('writes an antialiased edge rather than a binary one', async () => {
    const coverage = await replayed([{ kind: 'paint', stroke: horizontalStroke }]);
    // Walking down the stroke's edge must pass through intermediate values;
    // that gradient is what removes the need for any feathering stage.
    const column: number[] = [];
    for (let y = 64; y < 64 + 20; y++) column.push(at(coverage, 64, y));

    const partial = column.filter((value) => value > 8 && value < 247);
    expect(partial.length).toBeGreaterThan(0);
  });

  it('produces a soft radial falloff for a low-hardness brush', async () => {
    const coverage = await replayed([
      { kind: 'paint', stroke: { points: [{ x: 64, y: 64 }], radius: 30, hardness: 0 } },
    ]);
    expect(at(coverage, 64, 64)).toBeGreaterThan(250);
    // Halfway out the coverage should be meaningfully reduced, not still solid.
    expect(at(coverage, 64 + 15, 64)).toBeGreaterThan(60);
    expect(at(coverage, 64 + 15, 64)).toBeLessThan(200);
    expect(at(coverage, 64 + 29, 64)).toBeLessThan(40);
  });

  it('does not accumulate where a stroke overlaps itself', async () => {
    // The pointer doubling back must not darken the overlap; max blending is
    // what guarantees that, and additive blending is what would break it.
    const doubledBack = await replayed([
      {
        kind: 'paint',
        stroke: {
          points: [
            { x: 24, y: 64 },
            { x: 104, y: 64 },
            { x: 24, y: 64 },
          ],
          radius: 12,
          hardness: 0.5,
        },
      },
    ]);
    const single = await replayed([{ kind: 'paint', stroke: { ...horizontalStroke, hardness: 0.5 } }]);

    for (const [x, y] of [
      [64, 64],
      [64, 70],
      [40, 72],
    ] as const) {
      expect(Math.abs(at(doubledBack, x, y) - at(single, x, y))).toBeLessThanOrEqual(1);
    }
  });
});

describe('mask operations', () => {
  it('erases what was painted', async () => {
    const coverage = await replayed([
      { kind: 'paint', stroke: horizontalStroke },
      { kind: 'erase', stroke: { points: [{ x: 64, y: 64 }], radius: 10, hardness: 1 } },
    ]);
    expect(at(coverage, 64, 64)).toBeLessThan(5);
    expect(at(coverage, 100, 64)).toBeGreaterThan(250);
  });

  it('clears everything', async () => {
    const coverage = await replayed([{ kind: 'paint', stroke: horizontalStroke }, { kind: 'clear' }]);
    expect(coverage.every((value) => value === 0)).toBe(true);
  });

  it('inverts', async () => {
    const coverage = await replayed([{ kind: 'paint', stroke: horizontalStroke }, { kind: 'invert' }]);
    expect(at(coverage, 64, 64)).toBeLessThan(5);
    expect(at(coverage, 64, 10)).toBeGreaterThan(250);
  });

  it('applies an externally produced mask through the one permitted bridge', async () => {
    // Stands in for a segmentation engine: a small, low-resolution mask that
    // has to be magnified into the full-resolution render mask.
    const engineMask = { width: 4, height: 4, coverage: new Uint8Array(16).fill(0) };
    engineMask.coverage[5] = 255;
    engineMask.coverage[6] = 255;
    engineMask.coverage[9] = 255;
    engineMask.coverage[10] = 255;

    const coverage = await replayed([{ kind: 'applyMask', mask: engineMask, op: 'replace' }]);
    expect(at(coverage, 64, 64)).toBeGreaterThan(200);
    expect(at(coverage, 4, 4)).toBeLessThan(40);
  });
});

describe('replay', () => {
  it('is deterministic, which is what makes undo and device-loss recovery the same operation', async () => {
    const commands: SelectionCommand[] = [
      { kind: 'paint', stroke: horizontalStroke },
      { kind: 'erase', stroke: { points: [{ x: 50, y: 64 }], radius: 8, hardness: 0.7 } },
      { kind: 'invert' },
    ];

    const first = await replayed(commands);
    const second = await replayed(commands);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('reproduces a prefix exactly, so undo needs no snapshots', async () => {
    const prefix: SelectionCommand[] = [{ kind: 'paint', stroke: horizontalStroke }];
    const full: SelectionCommand[] = [...prefix, { kind: 'invert' }];

    const afterUndo = await replayed(prefix);
    const direct = await replayed(prefix);
    expect(Buffer.from(afterUndo).equals(Buffer.from(direct))).toBe(true);
    expect(Buffer.from(await replayed(full)).equals(Buffer.from(direct))).toBe(false);
  });
});
