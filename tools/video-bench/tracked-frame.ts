// What a tracked frame actually costs, through the code that ships.
//
// The figure this project has quoted for tracking, and designed around, was
// summed from parts measured separately: a vision encoder here, a memory
// attention there, a mask decoder from the object-selection page. It came to
// about ninety milliseconds and it was published saying plainly that nothing
// had been run end to end, because until now there was no end to end to run.
//
// There is one. So this drives the real thing: `loadEdgeTamEngine`,
// `loadEdgeTamTracker`, `VideoScene` over a real `FrameProvider`, and
// `runTracking` writing into a real `SelectionDocument`. Nothing here
// reimplements any of it, which is the point: what is being timed has to be the
// thing that runs, or the number is about this file.
//
// NEEDS A TRACKING HOST, since the two graphs are in no published release. See
// tools/edgetam-export. With none configured it says so and measures nothing,
// rather than reporting a zero.
//
// The split comes from the two seams `runTracking` already has, so nothing in
// src/ grows a timer: the scene is wrapped to time `understand`, and the engine
// is wrapped to time `advance`. Everything else in a run is a command applied
// to a document, which the log measurement already puts at microseconds.
//
// THOSE TWO NUMBERS DO NOT SPLIT A FRAME, and reporting them as if they did
// would be wrong in a way nothing else here would catch. The segmentation
// engine asks for `gpu-buffer` outputs, so its `run` returns before the GPU has
// finished and `understand` looks nearly free; the cost lands in `advance`,
// whose first act is to ask for those outputs. So the split that is reported is
// the one that is free of it: a second tracked object is exactly one more
// `advance` and not one more read, so the difference between one object and two
// IS an advance, and what is left over IS the read.

import { packCoverage, type CoverageMask } from '../../src/core/document/coverage-mask.ts';
import {
  atMemoryResolution,
  FEATURE_DIM,
  FEATURE_TOKENS,
  MASK_SIZE,
  maskForMemory,
  toChannelMajor,
  toTokenMajor,
  visionPositionEncoding,
  FEATURE_GRID,
} from '../../src/core/perception/memory-bank.ts';
import { SelectionDocument } from '../../src/core/document/selection-document.ts';
import { runTracking, type TrackedScene } from '../../src/core/perception/tracking-job.ts';
import type { SceneEmbedding } from '../../src/core/perception/segmentation-engine.ts';
import type { ObjectTrack, TrackingEngine } from '../../src/core/perception/tracking-engine.ts';
import { loadEdgeTamEngine } from '../../src/platform/perception/edgetam-engine.ts';
import { loadEdgeTamTracker } from '../../src/platform/perception/edgetam-tracker.ts';
import { VideoScene } from '../../src/platform/perception/video-scene.ts';
import { FrameProvider } from '../../src/platform/video/frame-provider.ts';
import { sample, stats, type Stat } from './util.ts';

/** Where the seed sits, as a fraction of the frame. Nothing depends on it. */
const SEED = { x0: 0.35, y0: 0.35, x1: 0.65, y1: 0.65 };
const SEED_SIZE = 256;

/**
 * Frames per run.
 *
 * Enough that the first frame's session warm-up is a small part of the median
 * and few enough that four configurations are half a minute rather than five.
 * The median is what is reported, so a warm-up frame moves it by nothing.
 */
const FRAMES = 24;

function seedMask(offset: number): CoverageMask {
  const coverage = new Uint8Array(SEED_SIZE * SEED_SIZE);
  const x0 = Math.round((SEED.x0 + offset) * SEED_SIZE);
  const x1 = Math.round((SEED.x1 + offset) * SEED_SIZE);
  const y0 = Math.round(SEED.y0 * SEED_SIZE);
  const y1 = Math.round(SEED.y1 * SEED_SIZE);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < Math.min(SEED_SIZE, x1); x++) coverage[y * SEED_SIZE + x] = 255;
  }
  return packCoverage(SEED_SIZE, SEED_SIZE, coverage);
}

/** The scene, with a stopwatch on the one call that reads a frame. */
function timedScene(scene: TrackedScene & { dispose: () => void }, into: number[]): TrackedScene {
  return {
    frames: scene.frames,
    async understand(frame: number): Promise<SceneEmbedding> {
      const t0 = performance.now();
      const embedding = await scene.understand(frame);
      into.push(performance.now() - t0);
      return embedding;
    },
  };
}

/** The engine, with a stopwatch on the one call that advances a track. */
function timedEngine(engine: TrackingEngine, into: number[]): TrackingEngine {
  return {
    async begin(embedding: SceneEmbedding, seed: CoverageMask): Promise<ObjectTrack> {
      const track = await engine.begin(embedding, seed);
      return {
        async advance(next: SceneEmbedding) {
          const t0 = performance.now();
          const found = await track.advance(next);
          into.push(performance.now() - t0);
          return found;
        },
        dispose: () => {
          track.dispose();
        },
      };
    },
    dispose: () => {
      engine.dispose();
    },
  };
}

/**
 * The arithmetic between the graphs, on its own.
 *
 * Not a curiosity. A tracked frame turned out to cost half again what summing
 * the four graphs predicted, and the graphs are not where the difference is:
 * five of these run per frame, each of them a pass over a million elements of
 * JavaScript, and none of them appeared in the sum because none of them is a
 * model. Measured with the real functions at the real sizes.
 */
async function arithmetic(): Promise<Record<string, Stat>> {
  const features = new Float32Array(FEATURE_TOKENS * FEATURE_DIM);
  for (let i = 0; i < features.length; i++) features[i] = Math.sin(i * 0.001);
  const bias = Array.from({ length: FEATURE_DIM }, (_, i) => i * 0.001);
  const mask = new Float32Array(MASK_SIZE * MASK_SIZE);
  for (let i = 0; i < mask.length; i++) mask[i] = Math.sin(i * 0.01) * 4;
  // Timed separately, so the row below is what the sigmoid and the scaling cost
  // and not what they cost plus the resampling they are always given.
  const field = atMemoryResolution(mask);

  return {
    // Once a frame, over four megabytes.
    to_token_major: await sample(11, 3, () => {
      toTokenMajor(features, bias);
    }),
    // TWICE a frame: once for the memory encoder's input and once for the mask
    // decoder's, since attention answers token-major and both of those want the
    // other way round.
    to_channel_major: await sample(11, 3, () => {
      toChannelMajor(features);
    }),
    // Once a frame, 256 px in and 1024 px out, which is a million bilinear taps.
    at_memory_resolution: await sample(11, 3, () => {
      atMemoryResolution(mask);
    }),
    // Once a frame, over the million that came out of the row above.
    mask_for_memory: await sample(11, 3, (i) => {
      maskForMemory(field, i % 2 === 0, 20, -10);
    }),
    // ONCE A SESSION, not once a frame, and here to say so: four megabytes of
    // sine that would otherwise be four megabytes of download.
    vision_position_encoding: await sample(5, 1, () => {
      visionPositionEncoding(FEATURE_GRID, FEATURE_GRID, FEATURE_DIM);
    }),
  };
}

interface Run {
  readonly clip: string;
  readonly objects: number;
  readonly frames: number;
  readonly unfenced_read_ms: Stat;
  readonly advance_ms: Stat;
  readonly frame_ms: Stat;
  readonly frames_per_second: number;
  /**
   * Frames the model said an object was not in, summed over the objects.
   *
   * A sanity field rather than a measurement: these clips have nothing going
   * behind anything, so a run that is working reports zero and one that is not
   * reports a number worth chasing before the timings are read at all.
   *
   * SUMMED, because `TrackingResult.absent` is one count per object now and
   * this file's results are committed. Folding it here keeps the number that
   * has always been in that file the number that is in it, rather than
   * re-taking four medians six documents quote in order to change the shape of
   * a field nothing reads.
   */
  readonly absent: number;
}

export async function trackedFrame(
  dev: GPUDevice,
  clips: string,
  host: string | undefined,
): Promise<unknown> {
  if (!host) {
    return {
      error:
        'no VITE_TRACKING_HOST: the two graphs are in no published release, so there is nowhere to fetch them from. See tools/edgetam-export.',
    };
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const supportsF16 = adapter?.features.has('shader-f16') ?? false;

  const engine = await loadEdgeTamEngine({ device: dev, supportsF16, onProgress: () => undefined });
  const tracker = await loadEdgeTamTracker({ host, onProgress: () => undefined });

  const runs: Run[] = [];
  try {
    for (const name of ['720p30-gop30', '1080p30-gop30']) {
      for (const objects of [1, 2]) {
        const file = await (await fetch(`${clips}/${name}.mp4`)).blob();
        const opened = await FrameProvider.open(file, dev.limits.maxTextureDimension2D);
        if (!opened.ok) throw new Error(`could not open ${name}: ${opened.error.kind}`);

        const scene = new VideoScene({
          device: dev,
          engine,
          provider: opened.value,
          from: 0,
          through: FRAMES,
        });
        const read: number[] = [];
        const advance: number[] = [];
        const wall: number[] = [];
        let last = 0;

        try {
          const result = await runTracking({
            scene: timedScene(scene, read),
            engine: timedEngine(tracker, advance),
            document: new SelectionDocument(),
            seeds: Array.from({ length: objects }, (_, index) => seedMask(index * 0.08)),
            onProgress: () => {
              const now = performance.now();
              // The first tick times from the anchor's own read, which pays for
              // a decoder starting up and for both sessions' first dispatch.
              if (last > 0) wall.push(now - last);
              last = now;
            },
          });
          runs.push({
            clip: name,
            objects,
            frames: result.tracked,
            // Kept, and not to be read as half a frame: see the note at the
            // top of this file about where the encoder's cost lands.
            unfenced_read_ms: stats(read.slice(1)),
            advance_ms: stats(advance),
            frame_ms: stats(wall),
            frames_per_second: Math.round(1000 / Math.max(1e-6, stats(wall).median)),
            absent: result.absent.reduce((total, count) => total + count, 0),
          });
        } finally {
          scene.dispose();
        }
      }
    }
  } finally {
    tracker.dispose();
    engine.dispose();
  }

  return { runs, frames_per_run: FRAMES, arithmetic: await arithmetic() };
}
