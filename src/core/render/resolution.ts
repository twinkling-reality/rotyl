/**
 * Source and output resolution.
 *
 *   SOURCE  the decoded image's native dimensions
 *   OUTPUT  where the mask lives, where the composite runs, and what export
 *           writes; the view transform maps it onto the canvas afterwards
 *
 * OUTPUT is the image's own size, capped only to bound memory, so for any
 * photograph up to the cap the preview *is* the export rather than a
 * resemblance of it. Because the view transform is applied after the composite,
 * panning and zooming never re-run the style chain.
 *
 * The intermediate resolutions the style chain uses are not decided here; each
 * stage derives its own from the requested apparent scale (see comic-params).
 */

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Long-edge cap for the preview's output buffer.
 *
 * At 4096 essentially every consumer photograph previews at its native size,
 * and the peak working set stays a few hundred megabytes. Above the cap the
 * preview is a downscale and export re-renders at full size.
 */
export const PREVIEW_OUTPUT_CAP = 4096;

function scaleToLongEdge(dimensions: Dimensions, cap: number): Dimensions {
  const current = Math.max(dimensions.width, dimensions.height);
  if (current <= cap) return dimensions;
  const scale = cap / current;
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  };
}

export function outputDimensions(
  source: Dimensions,
  mode: 'preview' | 'export',
  deviceMaxTextureDimension: number,
): Dimensions {
  const cap =
    mode === 'preview' ? Math.min(PREVIEW_OUTPUT_CAP, deviceMaxTextureDimension) : deviceMaxTextureDimension;
  return scaleToLongEdge(source, cap);
}

export function shortEdge({ width, height }: Dimensions): number {
  return Math.min(width, height);
}
