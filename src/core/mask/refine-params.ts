/**
 * Parameters for turning a segmentation engine's coarse mask into coverage.
 *
 * SCALE IS EXPRESSED AS A FRACTION OF THE IMAGE, NEVER IN PIXELS, the same
 * rule the style chain follows, and for the same reason. A refinement whose
 * window were a pixel count would cover a different amount of the photograph in
 * the preview than in the export, and the two would disagree along every
 * boundary. Because the window is a fraction, the working resolution can be
 * *derived* to hold the window near a constant number of samples, which makes
 * the cost independent of how large the image is and the result identical at
 * both resolutions.
 *
 * The settings live in the command log rather than in a module-level default,
 * so replaying an old log reproduces the mask it produced at the time.
 */

export interface RefineSettings {
  /** Guided-filter window radius, as a fraction of the image's short edge. */
  readonly windowFraction: number;
  /**
   * Regularisation, in Oklab units squared.
   *
   * Small values let the matte follow faint colour edges and also faint noise;
   * large values ignore both and fall back towards the coarse mask. This is the
   * one knob that decides whether a boundary snaps to the object or to grain.
   */
  readonly epsilon: number;
  /**
   * Half-width of the final transition, in coverage units.
   *
   * The filter returns a soft matte. Zero would give a binary edge and
   * therefore a staircase, so the transition is narrowed rather than removed:
   * where the guide has a strong edge the matte crosses this band within a
   * pixel or two, and where it does not the edge stays soft.
   */
  readonly firmness: number;
}

export const DEFAULT_REFINE_SETTINGS: RefineSettings = {
  windowFraction: 0.024,
  epsilon: 4e-4,
  firmness: 0.15,
};

/**
 * Working-buffer window radius, in samples.
 *
 * The blur is O(radius) per axis per pixel, so this is the cost knob; 12 gives
 * a 25-tap box, which is enough for the local linear model to be stable
 * without the window swallowing small objects.
 */
const WINDOW_RADIUS = 12;

/**
 * Lower bound on the working resolution.
 *
 * Engine masks arrive at 256 px. Computing the filter's statistics below that
 * would throw away detail the engine already produced, which no amount of
 * edge-aware upsampling afterwards can recover.
 */
const MIN_WORKING_SHORT_EDGE = 256;

/** Working resolutions snap to this grid so buffers are not reallocated per edit. */
const RESOLUTION_STEP = 64;

export interface RefineParams {
  /** Short edge of the buffer the filter's statistics are computed in. */
  readonly workingShortEdge: number;
  /** Box radius in working-buffer pixels; recovered from the granted resolution. */
  readonly radius: number;
  readonly epsilon: number;
  readonly firmness: number;
}

/**
 * Derive the working resolution from the requested window fraction.
 *
 * Clamping happens before the radius is recovered, so when a bound binds it is
 * the radius that gives way rather than the fraction drifting, which is what
 * keeps preview and export identical. The same argument, and the same trap,
 * as `stageResolution` in the style layer.
 */
export function resolveRefineParams(settings: RefineSettings, outputShortEdge: number): RefineParams {
  const fraction = Math.max(1e-4, settings.windowFraction);
  const requested = WINDOW_RADIUS / fraction;
  const ceiling = Math.max(MIN_WORKING_SHORT_EDGE, outputShortEdge);

  const snapped = Math.round(requested / RESOLUTION_STEP) * RESOLUTION_STEP;
  const workingShortEdge = Math.max(MIN_WORKING_SHORT_EDGE, Math.min(ceiling, snapped));

  return {
    workingShortEdge,
    radius: workingShortEdge * fraction,
    epsilon: Math.max(1e-8, settings.epsilon),
    firmness: Math.max(1e-3, settings.firmness),
  };
}
