import { OUTPUT_FORMAT, OUTPUT_VIEW_FORMAT, SOURCE_FORMAT, SOURCE_VIEW_FORMAT } from '../gpu/formats.ts';
import { ResourcePool } from '../gpu/resource-pool.ts';
import { SelectionDocument } from '../document/selection-document.ts';
import { hasAnyCoverage, type BrushStroke, type StrokePoint } from '../document/selection-command.ts';
import { SelectionMask, type MaskReplayContext } from '../mask/selection-mask.ts';
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

export type BrushMode = 'paint' | 'erase';

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
 */
export class RotylEngine {
  readonly document = new SelectionDocument();

  readonly #device: GPUDevice;
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

  #styleDirty = true;
  #compositeDirty = true;
  #displayDirty = true;
  /** Document revision the mask currently reflects; -1 forces a rebuild. */
  #maskRevision = -1;

  constructor(
    device: GPUDevice,
    maxTextureDimension: number,
    canvasFormat: GPUTextureFormat,
    background: readonly [number, number, number],
  ) {
    this.#device = device;
    this.#maxTextureDimension = maxTextureDimension;
    this.#composite = new CompositeRenderer(device);
    this.#display = new DisplayRenderer(device, canvasFormat, background);
    this.#refiner = new MaskRefiner(device);

    this.document.subscribe(() => {
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
   * garbage collector — a full-resolution photograph is hundreds of megabytes,
   * and "load several images in a row" is the shortest path to exhausting a
   * tab's memory.
   */
  loadMedia(sourceSize: Dimensions): GPUTexture {
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

    this.document.reset();
    this.#live = undefined;
    this.#maskRevision = -1;
    this.#styleDirty = true;
    this.#compositeDirty = true;
    this.#displayDirty = true;
    return sourceTexture;
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
    this.document.apply(live.mode === 'paint' ? { kind: 'paint', stroke } : { kind: 'erase', stroke });
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
    return this.#styleDirty || this.#compositeDirty || this.#displayDirty || this.#maskRevision === -1;
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
    return media ? { view: media.sourceView, size: media.sourceSize } : undefined;
  }

  #updateMask(encoder: GPUCommandEncoder, media: Media): void {
    const revision = this.document.revision;
    if (this.#maskRevision !== revision) {
      media.mask.replay(encoder, this.document.appliedCommands, this.#replayContext(media));
      this.#maskRevision = revision;
      if (this.#live) this.#live.stamped = 0;
    }

    const live = this.#live;
    if (live && live.stamped < live.points.length) {
      // `max`/`min` blending is idempotent, so stamping only the samples added
      // since the last frame gives exactly the same mask as re-stamping all of
      // them — at a fraction of the cost on a long stroke.
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
      this.#composite.renderStyle(encoder, {
        sourceTexture: media.sourceTexture,
        sourceSize: media.sourceSize,
        outputSize: media.outputSize,
        style: this.#style,
        controls: this.#controls,
        quality: this.#quality,
      });
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
      const showsSelection = this.#live !== undefined || hasAnyCoverage(this.document.appliedCommands);
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
    this.#media?.mask.dispose();
    this.#media?.pool.dispose();
    this.#media = undefined;
    this.#composite.dispose();
    this.#display.dispose();
    this.#refiner.dispose();
  }
}
