import type { CompositeRenderer } from './composite-renderer.ts';
import { SelectionMask } from '../mask/selection-mask.ts';
import type { MaskRefiner } from '../mask/mask-refiner.ts';
import { commandsForFrame } from '../document/selection-command.ts';
import { outputDimensions, type Dimensions } from './resolution.ts';
import { OUTPUT_VIEW_FORMAT, SOURCE_VIEW_FORMAT } from '../gpu/formats.ts';
import type { SelectionCommand } from '../document/selection-command.ts';
import type { StyleControls, StyleDefinition } from '../style/style.ts';

export interface ExportRendererOptions {
  readonly device: GPUDevice;
  /**
   * The same renderer the preview uses.
   *
   * Reused rather than built fresh: a second pipeline set is a duplicate of
   * every shader and pipeline in the application for the duration of one save,
   * and building one per export churned Dawn hard enough to destabilise it.
   * The only cost of sharing is that the export's stage textures replace the
   * preview's, so the next interactive frame reallocates once.
   */
  readonly renderer: CompositeRenderer;
  /** Borrowed for the same reason, and used only if the log holds engine masks. */
  readonly refiner: MaskRefiner;
  /** Full-resolution source, refilled by the caller before each frame. */
  readonly sourceTexture: GPUTexture;
  readonly sourceSize: Dimensions;
  /** Where the composite runs. Every frame of one export shares it. */
  readonly outputSize: Dimensions;
}

/** Dimensions the exported image will have, given a source and this device. */
export function exportDimensions(source: Dimensions, maxTextureDimension: number): Dimensions {
  return outputDimensions(source, 'export', maxTextureDimension);
}

/**
 * The export renderer: the preview's renderer at the preview's parameters,
 * stopping at the same pass, run once per frame being written.
 *
 * What lands in the file is what the composite produced on screen, at full
 * resolution and without the selection overlay, which lives in a later pass
 * this never reaches.
 *
 * The selection is rebuilt by replaying the command log at export resolution
 * rather than by upscaling the preview mask. Stroke coordinates and radii are
 * in source pixels, so the replay is exact: a brush edge exported at 6000 px is
 * the shape the user drew, not a magnified approximation of it.
 *
 * IT IS AN OBJECT BECAUSE THE MASK IS PER EXPORT, NOT PER FRAME. This was a
 * function that allocated a mask, rendered, and released it, which was right
 * while an export was one frame and becomes eight hundred allocations of a
 * full-resolution texture pair on a clip. Everything else about the shape is
 * unchanged: a still image is a one-frame document and exports through exactly
 * this loop, once.
 */
export class ExportRenderer {
  readonly #device: GPUDevice;
  readonly #renderer: CompositeRenderer;
  readonly #refiner: MaskRefiner;
  readonly #sourceTexture: GPUTexture;
  readonly #sourceSize: Dimensions;
  readonly #outputSize: Dimensions;
  readonly #mask: SelectionMask;
  /**
   * Created once rather than per frame.
   *
   * The texture is refilled between frames and a view does not care: it names
   * the texture and the format, and both are fixed for the life of an export.
   */
  readonly #guideView: GPUTextureView;

  constructor(options: ExportRendererOptions) {
    const { device, renderer, refiner, sourceTexture, sourceSize, outputSize } = options;
    this.#device = device;
    this.#renderer = renderer;
    this.#refiner = refiner;
    this.#sourceTexture = sourceTexture;
    this.#sourceSize = sourceSize;
    this.#outputSize = outputSize;
    this.#mask = new SelectionMask(
      device,
      outputSize.width,
      outputSize.height,
      sourceSize.width,
      sourceSize.height,
    );
    this.#guideView = sourceTexture.createView({ format: SOURCE_VIEW_FORMAT });
  }

  /**
   * Render one frame of the document into `target`.
   *
   * The caller has already put that frame's pixels in the source texture. The
   * whole command log is passed rather than one frame's, because which commands
   * are in effect on a frame is a question core already answers and the export
   * path has no business answering differently.
   *
   * Resolves only once the GPU has finished. That fence is load-bearing rather
   * than politeness: what happens next is that somebody reads the target, and
   * the resources this frame referenced are reused by the next one.
   */
  async render(
    target: GPUTexture,
    commands: readonly SelectionCommand[],
    frame: number,
    style: StyleDefinition,
    controls: StyleControls,
    illustrated?: GPUTexture,
  ): Promise<void> {
    const encoder = this.#device.createCommandEncoder({ label: 'export' });
    this.#mask.beginFrame();
    this.#refiner.beginFrame();

    // Engine masks are refined against the full-resolution source at export
    // resolution, not magnified from the preview's matte, the same argument
    // that makes a brush stroke replay exactly rather than being upscaled.
    this.#mask.replay(encoder, commandsForFrame(commands, frame), {
      refiner: this.#refiner,
      guideView: this.#guideView,
      guideSize: this.#sourceSize,
    });

    if (illustrated) this.#renderer.adoptLayer(illustrated, 1);
    else {
      this.#renderer.renderStyle(encoder, {
        sourceTexture: this.#sourceTexture,
        sourceSize: this.#sourceSize,
        outputSize: this.#outputSize,
        style,
        controls,
        quality: 'export',
      });
    }
    // Written through an sRGB view, so the hardware performs the encode and the
    // stored bytes match the source exactly wherever coverage is zero. The one
    // place that rule is applied on the way out, so a target cannot arrive
    // having had it applied twice.
    this.#renderer.composite(
      encoder,
      this.#sourceTexture,
      this.#mask.texture,
      target.createView({ format: OUTPUT_VIEW_FORMAT }),
    );

    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
  }

  /**
   * Releasing a texture that submitted-but-unfinished commands still reference
   * is a use-after-free that presents as an intermittent hard crash, which is
   * why every `render` above fences before it resolves.
   */
  dispose(): void {
    this.#mask.dispose();
  }
}
