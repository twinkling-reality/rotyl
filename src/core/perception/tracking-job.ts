import { DEFAULT_REFINE_SETTINGS } from '../mask/refine-params.ts';
import type { CoverageMask } from '../document/coverage-mask.ts';
import type { RefineSettings } from '../mask/refine-params.ts';
import type { SelectionDocument } from '../document/selection-document.ts';
import type { SceneEmbedding } from './segmentation-engine.ts';
import type { ObjectTrack, TrackingEngine } from './tracking-engine.ts';

/**
 * Following a selection through a clip, as a job.
 *
 * WHERE IT RUNS RELATIVE TO THE PLAYHEAD: nowhere. It does not follow the
 * playhead at all, and that is the decision rather than an omission.
 *
 * Three measurements force it. A tracked frame measures 135 ms against
 * playback's thirty-three, so it cannot keep up with a playhead that is
 * moving. A memory bank is causal, so frame N's answer is built from frame
 * N-1's and there is no meaning to running it backwards. And the frame provider
 * costs 0.47 ms to step forward and fifteen to seek back, so a tracker that
 * chased a scrubbing playhead would spend its time seeking.
 *
 * What is left is the honest shape: a job that starts at the frame the
 * selection was made on and walks forward at its own pace. The playhead and the
 * tracker become two independent cursors over one document. The user can scrub
 * anywhere while it runs; frames the tracker has reached show what it found,
 * frames it has not show the held-forward selection they showed before, which
 * is exactly the behaviour the fold has always had.
 *
 * "BEHIND THE PLAYHEAD" AND "AHEAD OF IT" WERE BOTH ON THE TABLE and are worse
 * for the same reason. Both make the work depend on where somebody happens to
 * be looking, so the set of frames that end up tracked is a function of how the
 * user scrubbed rather than of what they asked for. A command log whose
 * contents depend on where the playhead wandered is not a document anybody can
 * reason about.
 *
 * ONE GESTURE, ONE UNDO. Every command a run produces carries the same group,
 * so undo takes the whole run back and lands the playhead on the frame the
 * selection was made on. Without that, following an object through three
 * hundred frames would cost three hundred presses.
 */

/**
 * The frames to follow the object through, and how to read one.
 *
 * THE ONLY SEAM. Everything platform-shaped is behind it: decoding, uploading,
 * and the vision encoder that turns a frame into something a track can advance
 * against. Core drives the loop and never learns what a video is.
 */
export interface TrackedScene {
  /**
   * Ascending, and starting with the frame the selection was made on.
   *
   * The first entry is the anchor. It is where the memory bank is seeded from
   * and it is the one frame this job does not write a command for, because the
   * user's own command is already there and replacing it with the tracker's
   * opinion of their own click would be the product disagreeing with a decision
   * it just watched somebody make.
   */
  readonly frames: readonly number[];
  /**
   * Read one frame. Expensive, 44 ms measured, and once per frame however many
   * objects are being followed, which is what makes a second tracked object 91
   * rather than another 135.
   *
   * The caller disposes what it gets back; an embedding is tens of megabytes on
   * the GPU and a clip has hundreds of frames.
   */
  understand(frame: number): Promise<SceneEmbedding>;
}

/**
 * Whether the caller has asked for this to stop.
 *
 * A SHAPE RATHER THAN `AbortSignal`, which is a DOM type and therefore not
 * something core is allowed to name. Every real caller passes an
 * `AbortController`'s signal, which satisfies this structurally, so the seam
 * costs nothing at the call site and keeps this file compiling under a config
 * with no `dom` lib. That config is what stops the engine growing a dependency
 * on the browser by accident, and it caught this exact line.
 */
export interface StopSignal {
  readonly aborted: boolean;
}

export interface TrackingRequest {
  readonly scene: TrackedScene;
  readonly engine: TrackingEngine;
  readonly document: SelectionDocument;
  /**
   * What to follow. One mask is one object; several is several.
   *
   * THIS IS WHERE "TRACKING A SECOND OBJECT" LIVES, and it is a list rather
   * than a second entry point because everything downstream of it already
   * composes: N tracks advance against one embedding, and their commands fold
   * on each frame in the order they are listed.
   */
  readonly seeds: readonly CoverageMask[];
  /** Carried into every command, so replaying an old log rebuilds these masks. */
  readonly refine?: RefineSettings;
  /** Called after each frame, so a long run can say how far along it is. */
  readonly onProgress?: (tracked: number, total: number) => void;
  readonly signal?: StopSignal;
}

export interface TrackingResult {
  /** Frames a command was written for, which excludes the anchor. */
  readonly tracked: number;
  /** Of those, how many the model said the object was not in. */
  readonly absent: number;
  /** Where it got to, which is the last frame it wrote. */
  readonly lastFrame: number;
}

/** Thrown when a run was stopped on purpose, so a caller can stay quiet about it. */
export class TrackingCancelled extends Error {
  constructor() {
    super('Tracking stopped.');
    this.name = 'TrackingCancelled';
  }
}

/**
 * Follow every seed forward through the scene, writing what it finds.
 *
 * COMMANDS ARE APPLIED AS IT GOES rather than collected and applied at the end.
 * That is what lets somebody watch it happen, and it is the reason the group
 * exists: a run that wrote nothing until it finished would need no grouping and
 * would also be twenty-seven seconds of a progress bar and no picture.
 */
export async function runTracking(request: TrackingRequest): Promise<TrackingResult> {
  const { scene, engine, document, seeds, onProgress, signal } = request;
  const refine = request.refine ?? DEFAULT_REFINE_SETTINGS;
  const [anchor, ...rest] = scene.frames;
  if (anchor === undefined) throw new Error('Tracking: no frames to follow.');
  if (seeds.length === 0) throw new Error('Tracking: nothing to follow.');

  const group = document.beginGroup();
  const tracks: ObjectTrack[] = [];
  let tracked = 0;
  let absent = 0;
  let lastFrame = anchor;

  try {
    const first = await scene.understand(anchor);
    try {
      for (const seed of seeds) tracks.push(await engine.begin(first, seed));
    } finally {
      first.dispose();
    }

    for (const frame of rest) {
      if (signal?.aborted) throw new TrackingCancelled();

      const embedding = await scene.understand(frame);
      try {
        for (const [index, track] of tracks.entries()) {
          const found = await track.advance(embedding);
          if (!found.present) absent++;
          document.apply({
            kind: 'applyMask',
            mask: found.mask,
            // THE FIRST TRACK REPLACES AND THE REST ADD. Replacing is the point
            // of tracking: what was held forward onto this frame is the
            // selection at the coordinates it had several frames ago, which is
            // the drift this exists to remove. The tracks after it add, so two
            // objects are two regions rather than a race.
            //
            // Brushwork applied afterwards still survives, because the fold is
            // stable and a stroke made later on the same frame sorts after
            // this.
            op: index === 0 ? 'replace' : 'add',
            refine,
            frame,
            group,
          });
        }
      } finally {
        embedding.dispose();
      }

      tracked++;
      lastFrame = frame;
      onProgress?.(tracked, rest.length);
    }

    return { tracked, absent, lastFrame };
  } finally {
    // Stopping keeps what it found. A run abandoned half way has followed the
    // object as far as it got and that work is worth exactly as much as it
    // would have been had the clip ended there; throwing it away would make
    // Stop mean undo, and there is already a button for undo.
    for (const track of tracks) track.dispose();
  }
}
