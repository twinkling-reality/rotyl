import type { CompositeRenderer } from './composite-renderer.ts';
import { SelectionMask } from '../mask/selection-mask.ts';
import type { MaskRefiner } from '../mask/mask-refiner.ts';
import { outputDimensions, type Dimensions } from './resolution.ts';
import { OUTPUT_VIEW_FORMAT, SOURCE_VIEW_FORMAT } from '../gpu/formats.ts';
import type { SelectionCommand } from '../document/selection-command.ts';
import type { StyleControls, StyleDefinition } from '../style/style.ts';

export interface ExportRequest {
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
  /** Full-resolution source, re-decoded from the original file. */
  readonly sourceTexture: GPUTexture;
  readonly sourceSize: Dimensions;
  readonly commands: readonly SelectionCommand[];
  readonly style: StyleDefinition;
  readonly controls: StyleControls;
  /** Where the result is written; must accept an OUTPUT_VIEW_FORMAT view. */
  readonly target: GPUTexture;
}

/** Dimensions the exported image will have, given a source and this device. */
export function exportDimensions(source: Dimensions, maxTextureDimension: number): Dimensions {
  return outputDimensions(source, 'export', maxTextureDimension);
}

/**
 * Render the exported image.
 *
 * The same renderer, the same controls, and the same final pass as the preview,
 * so what lands in the file is what the composite produced on screen, at full
 * resolution and without the selection overlay, which lives in a later pass the
 * export path never reaches.
 *
 * The selection is rebuilt by replaying the command log at export resolution
 * rather than by upscaling the preview mask. Stroke coordinates and radii are in
 * source pixels, so the replay is exact: a brush edge exported at 6000 px is the
 * shape the user drew, not a magnified approximation of it.
 *
 * Resolves only once the GPU has finished. That fence is load-bearing, not
 * politeness: the mask below is released in the `finally`, and releasing a
 * texture that submitted-but-unfinished commands still reference is a
 * use-after-free that presents as an intermittent hard crash.
 */
export async function renderExport(request: ExportRequest): Promise<void> {
  const { device, renderer, refiner, sourceTexture, sourceSize, commands, style, controls, target } = request;

  const outputSize = { width: target.width, height: target.height };
  const mask = new SelectionMask(
    device,
    outputSize.width,
    outputSize.height,
    sourceSize.width,
    sourceSize.height,
  );

  try {
    const encoder = device.createCommandEncoder({ label: 'export' });
    mask.beginFrame();
    refiner.beginFrame();
    // Engine masks are refined against the full-resolution source at export
    // resolution, not magnified from the preview's matte, the same argument
    // that makes a brush stroke replay exactly rather than being upscaled.
    mask.replay(encoder, commands, {
      refiner,
      guideView: sourceTexture.createView({ format: SOURCE_VIEW_FORMAT }),
      guideSize: sourceSize,
    });

    renderer.renderStyle(encoder, {
      sourceTexture,
      sourceSize,
      outputSize,
      style,
      controls,
      quality: 'export',
    });
    renderer.composite(
      encoder,
      sourceTexture,
      mask.texture,
      target.createView({ format: OUTPUT_VIEW_FORMAT }),
    );
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
  } finally {
    mask.dispose();
  }
}
