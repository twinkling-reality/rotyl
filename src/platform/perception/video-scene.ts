import { SOURCE_FORMAT, SOURCE_VIEW_FORMAT } from '../../core/gpu/formats.ts';
import type { SceneEmbedding, SegmentationEngine } from '../../core/perception/segmentation-engine.ts';
import type { TrackedScene } from '../../core/perception/tracking-job.ts';
import type { UseFrame, VideoInfo } from '../video/frame-provider.ts';
import { uploadFrameToTexture } from '../texture-upload.ts';

/**
 * The frames a tracking run walks, and how one is read.
 *
 * `runTracking` drives the loop and never learns what a video is; this is the
 * whole of what a video is to it. Everything platform-shaped lives here:
 * decoding, uploading, and the encoder that turns a frame into something a
 * track can advance against.
 *
 * A SECOND DECODER OVER THE SAME FILE, and that is the decision this file
 * exists to make. `FrameProvider` serialises requests and lets a newer one
 * supersede whatever is in flight, which is exactly right for a pointer being
 * dragged along a timeline and exactly wrong for two readers: a run sharing the
 * playhead's provider would cancel every scrub the user made, and every scrub
 * would cancel the run, each of them seeing `readFrame` return false and
 * neither of them wrong. The document already says the playhead and the tracker
 * are two independent cursors. Two cursors need two decoders.
 *
 * It is also what makes the reads cheap. This one only ever moves forward, so
 * it never re-seeks after the first frame: measured on 1080p30, the next frame
 * costs 0.47 ms where a seek costs 15. A shared decoder would seek on every
 * alternation between the two cursors, which is the whole cost of tracking
 * again on top of the model.
 *
 * ITS OWN TEXTURE, for the same reason. The frame being tracked is not the
 * frame on screen, and encoding into the texture the compositor reads would put
 * some frame from the middle of the run behind whatever the user was looking
 * at. One full-resolution RGBA texture for the length of the run.
 */

/**
 * The part of `FrameProvider` a run uses, named rather than taken whole.
 *
 * A real provider satisfies it, and so does a fake: checking which frames get
 * asked for, and what happens when the file cannot give one up, should not need
 * a container, a demuxer and a hardware decode session to set up.
 */
export interface TrackedFrames {
  readonly info: VideoInfo;
  readFrame(index: number, use: UseFrame): Promise<boolean>;
  dispose(): void;
}

export interface VideoSceneOptions {
  readonly device: GPUDevice;
  /** Reads the frame; a run never asks it for anything else. */
  readonly engine: SegmentationEngine;
  /**
   * A provider of this run's own, opened over the same file as the playhead's
   * and disposed with this scene.
   */
  readonly provider: TrackedFrames;
  /** The frame the selection was made on, which is where a run starts. */
  readonly from: number;
  /** One past the last frame to follow. The end of the clip by default. */
  readonly through?: number;
}

/**
 * The frames a run follows: ascending, contiguous, and starting on the anchor.
 *
 * Its own function because it is the one thing here that is arithmetic, and a
 * test of it should not need a GPU. Everything else in this file is a decoder,
 * a texture or a model.
 */
export function framesToFollow(from: number, through: number | undefined, frameCount: number): number[] {
  const last = Math.min(through ?? frameCount, frameCount);
  return Array.from({ length: Math.max(0, last - from) }, (_, index) => from + index);
}

export class VideoScene implements TrackedScene {
  readonly frames: readonly number[];

  readonly #device: GPUDevice;
  readonly #engine: SegmentationEngine;
  readonly #provider: TrackedFrames;
  readonly #texture: GPUTexture;
  readonly #view: GPUTextureView;
  readonly #size: { readonly width: number; readonly height: number };
  #disposed = false;

  constructor(options: VideoSceneOptions) {
    const { device, engine, provider, from } = options;
    const { width, height, timeline } = provider.info;

    this.#device = device;
    this.#engine = engine;
    this.#provider = provider;
    this.#size = { width, height };

    this.frames = framesToFollow(from, options.through, timeline.frameCount);

    this.#texture = device.createTexture({
      label: 'tracking-source',
      size: { width, height },
      format: SOURCE_FORMAT,
      viewFormats: [SOURCE_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Through an sRGB view, so the hardware does the decode and this frame
    // arrives in the same colour the encoder was given for a photograph.
    this.#view = this.#texture.createView({ format: SOURCE_VIEW_FORMAT });
  }

  /**
   * Read one frame and understand it.
   *
   * The upload happens inside `readFrame`'s callback because that is the only
   * moment the `VideoFrame` is alive: a frame held past it is part of the
   * decoder's pool and leaking one stops decoding with no error. A queue
   * operation is what the callback is for, and the encode that follows reads
   * the texture on the same queue, so the ordering needs nothing said about it.
   */
  async understand(frame: number): Promise<SceneEmbedding> {
    if (this.#disposed) throw new Error('VideoScene: this run has been disposed');

    let uploaded = false;
    const shown = await this.#provider.readFrame(frame, (decoded) => {
      uploadFrameToTexture(this.#device, decoded, this.#texture);
      uploaded = true;
    });
    // Superseded is not a case here the way it is on the playhead: this
    // provider serves one reader, so a false means the file could not give up
    // the frame, and a run that quietly skipped it would leave a gap in the
    // masks that nothing downstream could see.
    if (!shown || !uploaded) throw new Error(`VideoScene: could not read frame ${String(frame)}`);

    return this.#engine.encode({ view: this.#view, size: this.#size, frame });
  }

  /** Releases the texture and the decoder this run held open. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#texture.destroy();
    this.#provider.dispose();
  }
}
