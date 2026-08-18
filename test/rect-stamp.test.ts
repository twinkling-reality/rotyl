import { beforeAll, describe, expect, it } from 'vitest';
import { disposeWithTestDevice, testDevice } from './gpu-harness.ts';
import { at, MASK_SIZE, readMask } from './mask-harness.ts';
import { SelectionMask } from '../src/core/mask/selection-mask.ts';
import type { SelectionCommand } from '../src/core/document/selection-command.ts';

/**
 * A rectangle means the rectangle.
 *
 * The tool this backs exists because the Box tool does not do this: that one is
 * a prompt asking a model what object lies inside a region, and it answers with
 * the object. Someone who wants a panel of stylisation over a scene wants the
 * region itself, with an edge where they put it.
 *
 * ITS OWN FILE, AND ONE MASK FOR ALL OF IT. The rectangle pipelines are built
 * on first use, and building then discarding them once per case churns Dawn
 * hard enough to abort the worker after every assertion has already passed.
 * measured at four runs in six against a baseline of none. So the whole file
 * shares one device and one SelectionMask, replays into it three times, and
 * asserts many times against what came back.
 */

const RECT = { x0: 30, y0: 40, x1: 90, y1: 100 };

describe('rectangle stamping', () => {
  let forward: Uint8Array;
  let backward: Uint8Array;
  let cutOut: Uint8Array;

  beforeAll(async () => {
    const { device } = await testDevice();
    const mask = new SelectionMask(device, MASK_SIZE, MASK_SIZE);
    disposeWithTestDevice(() => {
      mask.dispose();
    });

    // Each replay begins with a clear, so one mask serves all three.
    const replay = async (commands: readonly SelectionCommand[]): Promise<Uint8Array> => {
      mask.beginFrame();
      const encoder = device.createCommandEncoder();
      mask.replay(encoder, commands);
      device.queue.submit([encoder.finish()]);
      return readMask(device, mask);
    };

    forward = await replay([{ kind: 'rect', rect: RECT, mode: 'paint', frame: 0 }]);
    backward = await replay([
      { kind: 'rect', rect: { x0: 90, y0: 100, x1: 30, y1: 40 }, mode: 'paint', frame: 0 },
    ]);
    cutOut = await replay([
      {
        kind: 'paint',
        stroke: {
          points: [
            { x: 24, y: 64 },
            { x: 104, y: 64 },
          ],
          radius: 12,
          hardness: 1,
        },
        frame: 0,
      },
      { kind: 'rect', rect: { x0: 50, y0: 40, x1: 70, y1: 100 }, mode: 'erase', frame: 0 },
    ]);
  });

  it('covers the rectangle and nothing outside it', () => {
    expect(at(forward, 60, 70)).toBe(255);
    expect(at(forward, 32, 42)).toBe(255);
    expect(at(forward, 88, 98)).toBe(255);

    expect(at(forward, 60, 20)).toBe(0);
    expect(at(forward, 60, 120)).toBe(0);
    expect(at(forward, 10, 70)).toBe(0);
    expect(at(forward, 110, 70)).toBe(0);
  });

  it('puts the edge where it was dragged, within a pixel', () => {
    // The edge is antialiased over about a pixel rather than staircased, so what
    // is asserted is that the transition happens AT the boundary and is over
    // within a pixel of it, not that a given texel holds a given value.
    expect(at(forward, 60, 38)).toBe(0);
    expect(at(forward, 60, 42)).toBe(255);
    expect(at(forward, 28, 70)).toBe(0);
    expect(at(forward, 32, 70)).toBe(255);
  });

  it('is the same rectangle dragged backwards', () => {
    expect(Buffer.compare(Buffer.from(backward), Buffer.from(forward))).toBe(0);
  });

  it('cuts a rectangle back out of a stroke', () => {
    // The stroke runs along y = 64 from x = 24 to x = 104.
    expect(at(cutOut, 40, 64)).toBe(255);
    expect(at(cutOut, 60, 64)).toBe(0);
    expect(at(cutOut, 90, 64)).toBe(255);
  });
});
