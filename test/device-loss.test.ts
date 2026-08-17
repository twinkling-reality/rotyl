import { describe, expect, it } from 'vitest';
import { watchDevice } from '../src/core/gpu/render-device.ts';

/**
 * The one distinction the recovery path rests on: a device we gave up against a
 * device that went away.
 *
 * Getting it wrong is not a small bug in either direction. Treating our own
 * teardown as a loss puts disposal and recovery in a loop; treating a loss as
 * teardown leaves a dead canvas and a session that has to be reloaded, which is
 * exactly the behaviour this replaced.
 */

interface FakeDevice {
  readonly lost: Promise<GPUDeviceLostInfo>;
  // `@webgpu/types` declares this as returning undefined, not void.
  destroy(): undefined;
  destroyed: boolean;
}

function fakeDevice(): { device: FakeDevice; lose: (reason: GPUDeviceLostReason) => void } {
  let settled: ((info: GPUDeviceLostInfo) => void) | undefined;
  const lost = new Promise<GPUDeviceLostInfo>((settle) => {
    settled = settle;
  });
  const resolve = (reason: GPUDeviceLostReason): void => {
    settled?.({ reason, message: '', __brand: 'GPUDeviceLostInfo' });
  };
  const device: FakeDevice = {
    lost,
    destroyed: false,
    destroy() {
      device.destroyed = true;
      // A destroyed device resolves its own `lost`, which is precisely the case
      // that must not be reported back as a loss.
      resolve('destroyed');
      return undefined;
    },
  };
  return {
    device,
    lose: resolve,
  };
}

describe('watching a device', () => {
  it('reports a loss nobody asked for', async () => {
    const { device, lose } = fakeDevice();
    let reason: string | undefined;
    watchDevice(device, (lostReason) => {
      reason = lostReason;
    });

    lose('unknown');
    await device.lost;
    await Promise.resolve();

    expect(reason).toBe('unknown');
  });

  it('stays silent when we are the ones giving it up', async () => {
    const { device } = fakeDevice();
    let reported = false;
    const release = watchDevice(device, () => {
      reported = true;
    });

    release();
    await device.lost;
    await Promise.resolve();

    expect(device.destroyed).toBe(true);
    expect(reported).toBe(false);
  });

  it('treats a destroy it did not perform as a loss', async () => {
    // Not the same as the case above, and the difference is the whole point: a
    // device destroyed by something else is a device we have genuinely lost,
    // and reading the reason alone cannot tell the two apart.
    const { device } = fakeDevice();
    let reason: string | undefined;
    watchDevice(device, (lostReason) => {
      reason = lostReason;
    });

    device.destroy();
    await device.lost;
    await Promise.resolve();

    expect(reason).toBe('destroyed');
  });
});
