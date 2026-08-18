// The video benchmarks, as one entry point.
//
// Driven either from the page console:
//
//   const bench = await import('/tools/video-bench/index.ts');
//   await bench.run(['decode']);
//
// or by run.mjs, which does the same thing in real Chrome and writes the JSON
// out. See the README for what each one answers and what it answered.

import { adapterInfo, CLIPS, device, ONNX } from './util.ts';
import { ortDevice, readback } from './readback.ts';
import { sharedDevice } from './shared-device.ts';
import { attention, bankRampUp } from './attention.ts';
import { halfPrecision } from './half-precision.ts';
import { video, type Clip } from './decode.ts';
import { colour, encodeColour } from './colour.ts';
import { encode } from './encode.ts';

const CLIP_SET: Clip[] = [
  { name: '1080p30-gop30', url: `${CLIPS}/1080p30-gop30.mp4` },
  { name: '1080p30-gop300', url: `${CLIPS}/1080p30-gop300.mp4` },
];

export const MEASUREMENTS = [
  'readback',
  'ort-device',
  'shared-device',
  'attention',
  'bank-rampup',
  'half-precision',
  'decode',
  'colour',
  'encode',
  'encode-colour',
] as const;

export type Measurement = (typeof MEASUREMENTS)[number];

export async function run(which: readonly string[]): Promise<unknown> {
  const dev = await device();
  const out: Record<string, unknown> = { adapter: await adapterInfo() };

  const step = async (name: Measurement, fn: () => Promise<unknown>): Promise<void> => {
    if (!which.includes(name)) return;
    const t0 = performance.now();
    try {
      out[name] = await fn();
    } catch (error) {
      // Reported rather than thrown: one measurement failing should not cost
      // the others, and the stack is the useful half.
      out[name] = { error: String(error), stack: error instanceof Error ? error.stack : undefined };
    }
    out[`${name}:wall-seconds`] = Math.round((performance.now() - t0) / 100) / 10;
  };

  await step('readback', () => readback(dev));
  await step('ort-device', () => ortDevice(dev, `${ONNX}/memory_encoder.onnx`));
  await step('attention', () => attention(ONNX));
  await step('bank-rampup', () => bankRampUp(ONNX));
  await step('half-precision', () => halfPrecision(ONNX));
  await step('decode', () => video(dev, CLIP_SET));
  await step('colour', () => colour(dev, CLIPS));
  await step('encode', () => encode(dev, CLIPS));
  await step('encode-colour', () => encodeColour(dev, CLIPS));
  // LAST, AND NOT BY ACCIDENT. It assigns to `ort.env.webgpu.device` and
  // destroys the devices it made, which leaves that global pointing at a dead
  // device. Anything creating a session afterwards hangs rather than failing.
  await step('shared-device', () => sharedDevice(`${ONNX}/memory_encoder.onnx`));

  dev.destroy();
  return out;
}
