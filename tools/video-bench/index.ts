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
import { log } from './log.ts';
import { documentCost } from './document.ts';
import { recovery } from './recovery.ts';
import { occlusion } from './occlusion.ts';
import { objects } from './objects.ts';
import { range } from './range.ts';
import { trackedFrame } from './tracked-frame.ts';
import { longClip } from './long-clip.ts';
import { interleave } from './interleave.ts';

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
  // Its own command, and out of `all`, because it needs a tracking host: the
  // two graphs are in no published release, so a machine without one measures
  // nothing here and everything else in `all` still runs.
  'tracked-frame',
  // No GPU and no clip: a measurement about the command log, which is core
  // code and runs anywhere.
  'log',
  // The same class, and its own command for the same reason: what the log costs
  // once it has to become a file shares nothing with a decode or an encode
  // timing, and re-taking it should not re-date every figure beside it.
  'document',
  // And the same again for what it costs to write down on every edit, which is
  // a question about the origin private file system rather than about the log.
  'recovery',
  // And once more, for what ONE MORE optional field on a command costs. It is
  // the same class again and it is kept out of `document` for the reason that
  // file exists to serve: three documents quote measurement 12's ten-minute
  // write and read, and taken inside that run this moved both of them by noise
  // on a code path it does not touch.
  'occlusion',
  // And once more, for which of the figures about a tracked log are per RUN and
  // which are per OBJECT. Every one of the four it answers already has a home
  // in one of the three files above, which is precisely why it cannot go in
  // one: an objects dimension added to any of them re-takes that measurement
  // and moves figures this chapter did not change.
  'objects',
  // And once more, for whether a full-range clip needs a path of its own. It
  // shares its clips, its patches and its upload path with `colour`, which is
  // exactly why it cannot share that measurement's file: `colour` is inside
  // `all`, and `all` writes the results the decode ladder, the readback ladder
  // and two ONNX timings are read from.
  'range',
  // Its own command, and out of `all`, because one rung of it deliberately runs
  // the tab out of memory and because it is twenty minutes where `all` is
  // three. Neither belongs in the middle of a run with nine other measurements
  // still to take.
  'long-clip',
  // Its own command as well, and for the ordinary reason rather than a dramatic
  // one: it needs no GPU, it answers a question about byte layout that shares
  // nothing with decode or encode timings, and re-taking it should not re-date
  // every figure it would otherwise land beside.
  'interleave',
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

  await step('log', () => log());
  await step('document', () => documentCost());
  await step('recovery', () => recovery());
  await step('occlusion', () => occlusion());
  await step('objects', () => objects());
  await step('range', () => range(dev, CLIPS));
  await step('readback', () => readback(dev));
  await step('ort-device', () => ortDevice(dev, `${ONNX}/memory_encoder.onnx`));
  await step('attention', () => attention(ONNX));
  await step('bank-rampup', () => bankRampUp(ONNX));
  await step('half-precision', () => halfPrecision(ONNX));
  await step('decode', () => video(dev, CLIP_SET));
  await step('colour', () => colour(dev, CLIPS));
  await step('encode', () => encode(dev, CLIPS));
  await step('encode-colour', () => encodeColour(dev, CLIPS));
  await step('tracked-frame', () => trackedFrame(dev, CLIPS, import.meta.env.VITE_TRACKING_HOST));
  await step('long-clip', () => longClip(dev, CLIPS));
  await step('interleave', () => interleave(CLIPS));
  // LAST, AND NOT BY ACCIDENT. It assigns to `ort.env.webgpu.device` and
  // destroys the devices it made, which leaves that global pointing at a dead
  // device. Anything creating a session afterwards hangs rather than failing.
  await step('shared-device', () => sharedDevice(`${ONNX}/memory_encoder.onnx`));

  dev.destroy();
  return out;
}
