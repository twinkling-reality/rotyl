import { OUTPUT_FORMAT, OUTPUT_VIEW_FORMAT, SOURCE_FORMAT, SOURCE_VIEW_FORMAT } from '../gpu/formats.ts';
import { ResourcePool } from '../gpu/resource-pool.ts';
import type { SelectionDocument } from '../document/selection-document.ts';
import {
  commandsForFrame,
  hasAnyCoverage,
  type BrushStroke,
  type StrokePoint,
} from '../document/selection-command.ts';
import { SelectionMask, type MaskReplayContext } from '../mask/selection-mask.ts';
import { packCoverage, type CoverageMask } from '../document/coverage-mask.ts';
import { MaskRefiner } from '../mask/mask-refiner.ts';
import {
  defaultControls,
  sameControls,
  type StyleControls,
  type StyleDefinition,
  type StyleQuality,
} from '../style/style.ts';
import { DEFAULT_STYLE } from '../style/styles.ts';
import { CompositeRenderer } from './composite-renderer.ts';
import { DisplayRenderer, OVERLAY_VISIBLE, type OverlayState } from './display-renderer.ts';
import { outputDimensions, type Dimensions } from './resolution.ts';
import { fitToCanvas, type Size, type ViewTransform } from '../view/view-transform.ts';
import type { SceneFrame } from '../perception/segmentation-engine.ts';
import type { SelectionCommand, SelectionRect } from '../document/selection-command.ts';

export type BrushMode = 'paint' | 'erase';

/**
 * The square a tracker is seeded at, which is the square the model answers at.
 *
 * `edgetam-engine.ts` and `edgetam-tracker.ts` both work here, and every mask
 * in the command log is this size, so a seed at any other resolution would only
 * be resampled again on its way in.
 */
const SEED_SIZE = 256;

/**
 * A mask at its own resolution, averaged down to a square.
 *
 * Its own function because it is arithmetic over bytes and belongs nowhere near
 * a GPU: what it does is answer "how much of this cell is selected", which is
 * exactly what coverage means, at whatever ratio the two sizes happen to be in.
 */
function boxDownsample(
  bytes: Uint8Array,
  stride: number,
  width: number,
  height: number,
  size: number,
): Uint8Array {
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const top = Math.floor((y * height) / size);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * height) / size));
    for (let x = 0; x < size; x++) {
      const left = Math.floor((x * width) / size);
      const right = Math.max(left + 1, Math.floor(((x + 1) * width) / size));
      let total = 0;
      for (let row = top; row < bottom; row++) {
        const at = row * stride;
        for (let column = left; column < right; column++) total += bytes[at + column] ?? 0;
      }
      out[y * size + x] = Math.round(total / ((bottom - top) * (right - left)));
    }
  }
  return out;
}

interface LiveStroke {
  readonly mode: BrushMode;
  readonly points: StrokePoint[];
  readonly radius: number;
  readonly hardness: number;
  /** How many points have already been stamped, so extension is incremental. */
  stamped: number;
}

interface Media {
  readonly sourceTexture: GPUTexture;
  /** Created once: every consumer wants linear light, and views are not free. */
  readonly sourceView: GPUTextureView;
  readonly sourceSize: Dimensions;
  readonly outputSize: Dimensions;
  readonly composite: GPUTexture;
  readonly mask: SelectionMask;
  readonly pool: ResourcePool;
}

/**
 * The editor engine: owns the loaded image, the selection, the style settings
 * and the render loop's dirty state.
 *
 * Framework-free and DOM-free by construction, so the same object drives the
 * browser UI and the Node test suite. The app layer observes it; it never
 * observes the app.
 *
 * Work is staged by how often it changes:
 *   style      re-runs only when the source or a style control changes
 *   composite  re-runs when the selection changes (one pass)
 *   display    re-runs when the view or overlay changes (one pass)
 *
 * THE DOCUMENT IS PASSED IN, NOT CREATED HERE, and that is what makes a lost
 * graphics device survivable. Everything this class owns belongs to one
 * GPUDevice and dies with it; the command log belongs to the work and does not.
 * Recovery is therefore a new engine on a new device around the same document,
 * rather than a special path through this one.
 */
export class RotylEngine {
  readonly document: SelectionDocument;

  readonly #device: GPUDevice;
  readonly #unsubscribe: () => void;
  readonly #maxTextureDimension: number;
  readonly #composite: CompositeRenderer;
  readonly #display: DisplayRenderer;
  readonly #refiner: MaskRefiner;

  #media: Media | undefined;
  #style: StyleDefinition = DEFAULT_STYLE;
  #controls: StyleControls = defaultControls(DEFAULT_STYLE);
  #quality: StyleQuality = 'full';
  #view: ViewTransform = { zoom: 1, center: { x: 0, y: 0 } };
  #overlay: OverlayState = OVERLAY_VISIBLE;
  #live: LiveStroke | undefined;

  /**
   * The frame the document is being edited and drawn at.
   *
   * Zero for a photograph, which is a one-frame document. Core knows a frame is
   * an integer and nothing else: what it indexes, how it is decoded and what it
   * costs to reach are all the platform layer's business.
   */
  #frame = 0;

  /**
   * A hosted illustrated still, or nothing.
   *
   * Not a style. When this is set the style chain is skipped and the
   * compositor blends this texture through the mask. Destroyed with the
   * device and with the file, because it is pixels of this photograph on
   * this GPU.
   */
  #illustrated: GPUTexture | undefined;
  #styleDirty = true;
  #compositeDirty = true;
  #displayDirty = true;
  /** Document revision the mask currently reflects; -1 forces a rebuild. */
  #maskRevision = -1;
  /**
   * Frame the mask currently reflects.
   *
   * Tracked SEPARATELY from the revision because scrubbing changes which
   * commands apply without changing the log at all. Keying the rebuild on the
   * revision alone would leave the previous frame's selection on screen, and it
   * would look like a caching bug rather than a missing frame.
   *
   * Covered end to end rather than by a unit test, deliberately. Draining the
   * dirty flags means a real `render`, which builds a whole style chain's
   * pipelines, and doing that in a Node test aborted the Dawn worker in three
   * runs out of twelve however it was arranged. The Playwright suite scrubs a
   * clip and compares the pixels that came back, in a browser with no such
   * limit, which is the stronger test of this anyway.
   */
  #maskFrame = 0;

  constructor(
    document: SelectionDocument,
    device: GPUDevice,
    maxTextureDimension: number,
    canvasFormat: GPUTextureFormat,
    background: readonly [number, number, number],
  ) {
    this.document = document;
    this.#device = device;
    this.#maxTextureDimension = maxTextureDimension;
    this.#composite = new CompositeRenderer(device);
    this.#display = new DisplayRenderer(device, canvasFormat, background);
    this.#refiner = new MaskRefiner(device);

    // Released on dispose. The document outlives any one engine, so a
    // subscription left behind would keep a dead engine reachable and marking
    // itself dirty for the rest of the session.
    this.#unsubscribe = this.document.subscribe(() => {
      this.#maskRevision = -1;
      this.#compositeDirty = true;
    });
  }

  get hasMedia(): boolean {
    return this.#media !== undefined;
  }

  get sourceSize(): Dimensions | undefined {
    return this.#media?.sourceSize;
  }

  get outputSize(): Dimensions | undefined {
    return this.#media?.outputSize;
  }

  get view(): ViewTransform {
    return this.#view;
  }

  /** Which tier the style chain last ran at. Read by the dev console. */
  get quality(): StyleQuality {
    return this.#quality;
  }

  get frame(): number {
    return this.#frame;
  }

  /** Which frame's edits are in effect. Everything else about a frame is the host's. */
  setFrame(frame: number): void {
    if (frame === this.#frame) return;
    this.#frame = frame;
    this.#compositeDirty = true;
  }

  /** The commands in effect right now: this frame's, and no others. */
  get frameCommands(): readonly SelectionCommand[] {
    return commandsForFrame(this.document.appliedCommands, this.#frame);
  }

  get style(): StyleDefinition {
    return this.#style;
  }

  get controls(): StyleControls {
    return this.#controls;
  }

  /**
   * Allocate buffers for a newly decoded image and return the texture the host
   * should upload pixels into.
   *
   * Any previously loaded image is destroyed here rather than left to the
   * garbage collector. A full-resolution photograph is hundreds of megabytes,
   * and "load several images in a row" is the shortest path to exhausting a
   * tab's memory.
   *
   * `selection` is required rather than defaulted because both answers are
   * right somewhere and the wrong one is silent: a different photograph must
   * not inherit the last one's selection, and the same photograph arriving
   * again after a lost device must not lose it.
   */
  loadMedia(sourceSize: Dimensions, selection: 'clear' | 'keep'): GPUTexture {
    this.#media?.mask.dispose();
    this.#media?.pool.dispose();

    const outputSize = outputDimensions(sourceSize, 'preview', this.#maxTextureDimension);
    const pool = new ResourcePool();

    const sourceTexture = pool.texture(this.#device, {
      label: 'source',
      size: { width: sourceSize.width, height: sourceSize.height },
      format: SOURCE_FORMAT,
      viewFormats: [SOURCE_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const composite = pool.texture(this.#device, {
      label: 'composite',
      size: { width: outputSize.width, height: outputSize.height },
      format: OUTPUT_FORMAT,
      viewFormats: [OUTPUT_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    this.#media = {
      sourceTexture,
      sourceView: sourceTexture.createView({ label: 'source-srgb', format: SOURCE_VIEW_FORMAT }),
      sourceSize,
      outputSize,
      composite,
      mask: new SelectionMask(
        this.#device,
        outputSize.width,
        outputSize.height,
        sourceSize.width,
        sourceSize.height,
      ),
      pool,
    };

    if (selection === 'clear') {
      this.document.reset();
      // Paired with the reset, not with the allocation: a new document starts
      // at its first frame, and a rebuild after a lost device must not.
      this.#frame = 0;
    }
    this.#live = undefined;
    this.#maskRevision = -1;
    this.#styleDirty = true;
    this.#compositeDirty = true;
    this.#displayDirty = true;
    // A new file, or a new device. The illustrated texture belonged to the
    // previous source or the previous GPU and cannot be shown on this one.
    this.clearIllustratedLayer();
    return sourceTexture;
  }

  /**
   * Show a hosted illustrated still through the existing compositor.
   *
   * The engine takes the texture. The caller must not destroy it.
   */
  setIllustratedLayer(texture: GPUTexture): void {
    this.clearIllustratedLayer();
    this.#illustrated = texture;
    this.#styleDirty = true;
    this.#compositeDirty = true;
  }

  clearIllustratedLayer(): void {
    this.#illustrated?.destroy();
    this.#illustrated = undefined;
    this.#styleDirty = true;
    this.#compositeDirty = true;
  }

  get illustratedLayer(): GPUTexture | undefined {
    return this.#illustrated;
  }

  /**
   * Release the loaded media and go back to having none.
   *
   * A full-resolution photograph and its mask are hundreds of megabytes, so
   * closing one has to give them back rather than wait for the next open to
   * displace them. The engine itself survives: its pipelines, its refiner and
   * its display pass are per-device, not per-file, and rebuilding them to show
   * a drop zone would be work done to look tidy.
   *
   * The document is reset with it. A command log describes strokes on a
   * particular picture, and carrying one across to the next file would apply
   * somebody's careful selection to an image it was never drawn on.
   */
  unloadMedia(): void {
    if (!this.#media) return;
    this.clearIllustratedLayer();
    this.#media.mask.dispose();
    this.#media.pool.dispose();
    this.#media = undefined;
    this.#live = undefined;
    this.document.reset();
    this.#frame = 0;
    this.#maskRevision = -1;
    this.#maskFrame = 0;
    this.#styleDirty = true;
    this.#compositeDirty = true;
    this.#displayDirty = true;
  }

  /** Reset the view so the whole image is visible. */
  fitView(canvasSize: Size, padding = 0): void {
    const media = this.#media;
    if (!media) return;
    // Fitted against SOURCE dimensions: zoom is defined as canvas device
    // pixels per source pixel, so a zoom of 1 means one image pixel per device
    // pixel regardless of whether the preview buffer was capped.
    this.setView(fitToCanvas(media.sourceSize, canvasSize, padding));
  }

  setView(view: ViewTransform): void {
    this.#view = view;
    this.#displayDirty = true;
  }

  setOverlay(overlay: OverlayState): void {
    this.#overlay = overlay;
    this.#displayDirty = true;
  }

  setStyle(style: StyleDefinition): void {
    if (style.id === this.#style.id) return;
    this.#style = style;
    this.#styleDirty = true;
  }

  setControls(controls: StyleControls): void {
    if (sameControls(controls, this.#controls)) return;
    this.#controls = controls;
    this.#styleDirty = true;
  }

  setQuality(quality: StyleQuality): void {
    if (quality === this.#quality) return;
    this.#quality = quality;
    this.#styleDirty = true;
  }

  /** Call after the host has uploaded pixels into the texture from `loadMedia`. */
  markSourceUploaded(): void {
    this.#styleDirty = true;
  }

  // --- stroke lifecycle ---

  beginStroke(mode: BrushMode, radius: number, hardness: number, point: StrokePoint): void {
    this.#live = { mode, points: [point], radius, hardness, stamped: 0 };
    this.#compositeDirty = true;
  }

  /**
   * Extend the live stroke.
   *
   * Takes an array because pointer events arrive coalesced: a 120 Hz pointer
   * delivers several samples per frame, and dropping the intermediate ones
   * turns a curve into a polyline.
   */
  extendStroke(points: readonly StrokePoint[]): void {
    if (!this.#live || points.length === 0) return;
    this.#live.points.push(...points);
    this.#compositeDirty = true;
  }

  /** Commit the live stroke to the document, making it undoable. */
  commitStroke(): void {
    const live = this.#live;
    this.#live = undefined;
    if (!live || live.points.length === 0) return;

    const stroke: BrushStroke = {
      points: live.points,
      radius: live.radius,
      hardness: live.hardness,
    };
    const frame = this.#frame;
    this.document.apply(
      live.mode === 'paint' ? { kind: 'paint', stroke, frame } : { kind: 'erase', stroke, frame },
    );
  }

  /**
   * Commit a dragged rectangle, stamped with the frame it was drawn on.
   *
   * A rectangle needs no live preview on the GPU: the pointer is dragging a
   * shape whose outline the host is already drawing, and unlike a stroke there
   * is nothing accumulated along the way that would be lost by waiting for the
   * release.
   */
  commitRect(rect: SelectionRect, mode: BrushMode): void {
    this.document.apply({ kind: 'rect', rect, mode, frame: this.#frame });
  }

  cancelStroke(): void {
    if (!this.#live) return;
    this.#live = undefined;
    this.#maskRevision = -1;
    this.#compositeDirty = true;
  }

  get isStroking(): boolean {
    return this.#live !== undefined;
  }

  get needsRender(): boolean {
    return (
      this.#styleDirty ||
      this.#compositeDirty ||
      this.#displayDirty ||
      this.#maskRevision === -1 ||
      this.#maskFrame !== this.#frame
    );
  }

  #replayContext(media: Media): MaskReplayContext {
    return { refiner: this.#refiner, guideView: media.sourceView, guideSize: media.sourceSize };
  }

  /**
   * The loaded frame, as something that can be perceived rather than drawn.
   *
   * Handing out the view rather than the texture is deliberate: a segmentation
   * engine reads the photograph and must never be in a position to write it.
   */
  get sceneFrame(): SceneFrame | undefined {
    const media = this.#media;
    return media ? { view: media.sourceView, size: media.sourceSize, frame: this.#frame } : undefined;
  }

  #updateMask(encoder: GPUCommandEncoder, media: Media): void {
    const revision = this.document.revision;
    if (this.#maskRevision !== revision || this.#maskFrame !== this.#frame) {
      // Only this frame's commands. The guide is the frame on screen, which is
      // the frame they were made on, so the boundary is reconstructed against
      // the pixels it was drawn against. That stops being automatic when a
      // tracker starts producing commands for frames it was not prompted on.
      media.mask.replay(encoder, this.frameCommands, this.#replayContext(media));
      this.#maskRevision = revision;
      this.#maskFrame = this.#frame;
      if (this.#live) this.#live.stamped = 0;
    }

    const live = this.#live;
    if (live && live.stamped < live.points.length) {
      // `max`/`min` blending is idempotent, so stamping only the samples added
      // since the last frame gives exactly the same mask as re-stamping all of
      // them, at a fraction of the cost on a long stroke.
      media.mask.stamp(
        encoder,
        { points: live.points, radius: live.radius, hardness: live.hardness },
        live.mode,
        live.stamped,
      );
      live.stamped = live.points.length;
      this.#compositeDirty = true;
    }
  }

  /** Render one frame into the canvas view. Returns false if there is nothing loaded. */
  render(targetView: GPUTextureView, canvasSize: Size): boolean {
    const media = this.#media;
    if (!media) return false;

    const encoder = this.#device.createCommandEncoder({ label: 'frame' });
    media.mask.beginFrame();
    this.#refiner.beginFrame();

    if (this.#styleDirty) {
      if (this.#illustrated) {
        this.#composite.adoptLayer(this.#illustrated, 1);
      } else {
        this.#composite.renderStyle(encoder, {
          sourceTexture: media.sourceTexture,
          sourceSize: media.sourceSize,
          outputSize: media.outputSize,
          style: this.#style,
          controls: this.#controls,
          quality: this.#quality,
        });
      }
      this.#styleDirty = false;
      this.#compositeDirty = true;
    }

    this.#updateMask(encoder, media);

    if (this.#compositeDirty) {
      this.#composite.composite(
        encoder,
        media.sourceTexture,
        media.mask.texture,
        media.composite.createView({ format: OUTPUT_VIEW_FORMAT }),
      );
      this.#compositeDirty = false;
      this.#displayDirty = true;
    }

    if (this.#displayDirty) {
      // With nothing selected there is no "unselected region" to distinguish,
      // so the overlay is suppressed entirely rather than lifting the whole
      // image toward paper the moment it loads.
      const showsSelection = this.#live !== undefined || hasAnyCoverage(this.frameCommands);
      const overlay = showsSelection ? this.#overlay : { lift: 0, contour: 0 };

      this.#display.render(
        encoder,
        targetView,
        media.composite,
        media.mask.texture,
        media.sourceSize,
        canvasSize,
        this.#view,
        overlay,
      );
      this.#displayDirty = false;
    }

    this.#device.queue.submit([encoder.finish()]);
    return true;
  }

  /** Force the next frame to redraw the canvas, after a resize or a context reconfigure. */
  invalidateDisplay(): void {
    this.#displayDirty = true;
  }

  /**
   * The selection as it stands on this frame, as something a tracker can be
   * seeded from.
   *
   * READ BACK RATHER THAN REBUILT, and that is the point. What gets followed is
   * the answer and not the question: by the time anybody presses Track they
   * have clicked, chosen between the three readings of that click, and possibly
   * brushed the result. Only the mask knows all of that. Rebuilding it from the
   * command log here would be a second implementation of the one thing the log
   * exists to have exactly one of.
   *
   * AT THE ENGINE'S OWN 256 PX, because the model answers there and a seed is
   * on its way to a memory encoder rather than to a screen. Averaged down
   * rather than sampled, so a boundary that falls between two cells lands in
   * the right one; nearest at these ratios moves an edge by up to eight source
   * pixels on a large photograph.
   *
   * The mask is brought up to date first. A run can start on a frame whose last
   * command has not been rendered yet, and a seed one edit behind is a tracker
   * following what the user asked for a moment ago.
   */
  async readSelection(size = SEED_SIZE): Promise<CoverageMask | undefined> {
    const media = this.#media;
    if (!media) return undefined;

    const { width, height } = media.mask;
    // copyTextureToBuffer insists on 256-byte rows, so a mask of any width
    // arrives padded and has to be read a row at a time.
    const stride = Math.ceil(width / 256) * 256;
    const readback = this.#device.createBuffer({
      label: 'selection-readback',
      size: stride * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = this.#device.createCommandEncoder({ label: 'read-selection' });
    this.#updateMask(encoder, media);
    encoder.copyTextureToBuffer(
      { texture: media.mask.texture },
      { buffer: readback, bytesPerRow: stride },
      { width, height },
    );
    this.#device.queue.submit([encoder.finish()]);

    try {
      await readback.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(readback.getMappedRange());
      return packCoverage(size, size, boxDownsample(bytes, stride, width, height, size));
    } finally {
      readback.destroy();
    }
  }

  /**
   * The renderer export borrows, so a save does not duplicate every pipeline in
   * the application. Using it invalidates the cached styled layer, hence the
   * matching `invalidateStyle`.
   */
  get compositeRenderer(): CompositeRenderer {
    return this.#composite;
  }

  /** Borrowed by export for the same reason, and on the same terms. */
  get maskRefiner(): MaskRefiner {
    return this.#refiner;
  }

  invalidateStyle(): void {
    this.#styleDirty = true;
  }

  dispose(): void {
    this.#unsubscribe();
    this.clearIllustratedLayer();
    this.#media?.mask.dispose();
    this.#media?.pool.dispose();
    this.#media = undefined;
    this.#composite.dispose();
    this.#display.dispose();
    this.#refiner.dispose();
  }
}
