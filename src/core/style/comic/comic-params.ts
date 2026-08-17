/**
 * The comic style's two user controls, and every internal constant they drive.
 *
 * SCALE IS EXPRESSED AS A FRACTION OF THE IMAGE, NEVER IN PIXELS.
 *
 * Both expensive stages — the anisotropic Kuwahara flatten and the flow-based
 * DoG ink — have a characteristic radius. Written the obvious way, that radius
 * is a pixel count that must grow with resolution to keep the look constant,
 * and cost then grows with the *fourth* power of resolution: pixel count times
 * radius squared. A 1536 px flatten costs roughly five times a 1024 px one.
 *
 * So the relationship is inverted. Each stage declares the apparent scale it
 * wants as a fraction of the image's short edge, and the resolution of its own
 * buffer is *derived* from that fraction to hold the radius near a constant.
 * Cost then grows linearly with pixel count, and "more detail" spends its
 * budget on resolution rather than on kernel width.
 *
 * Two consequences worth stating, because they look like bugs otherwise:
 *
 *   - The flatten buffer is genuinely small (a few hundred pixels at low
 *     detail). It is magnified back to output resolution before quantisation,
 *     and quantising a soft ramp re-sharpens it into a clean cel band, so the
 *     magnification does not read as blur.
 *   - The ink buffer is likewise capped. The tanh threshold that turns the DoG
 *     response into a line is applied *after* magnification, at output
 *     resolution, so lines come out crisp at full size from a cheap detection.
 *
 * PREVIEW MATCHES EXPORT because every quantity below is a function of the two
 * slider values alone — never of the output resolution. Raising the quality
 * tier scales a stage's resolution and its radius by the same factor, which
 * leaves the fraction, and therefore the composition, identical.
 *
 * Fractions are calibrated against a 512 px reference (hence the /512 terms).
 */

export interface ComicControls {
  /** Scale of abstraction. 0 = broad flat shapes, 1 = fine detail preserved. */
  readonly detail: number;
  /** Amount of stylisation. 0 = untouched, 1 = fully graphic. */
  readonly strength: number;
}

export const DEFAULT_COMIC_CONTROLS: ComicControls = { detail: 0.5, strength: 0.7 };

/** Quality tiers scale resolution and radius together, so the look is unchanged. */
export const QUALITY_SCALE = {
  /** While a slider is being dragged. */
  draft: 0.6,
  /** Settled, and what the user judges the result by. */
  full: 1,
  /** Export: no longer competing with input latency. */
  export: 1.4,
} as const;

export type StyleQuality = keyof typeof QUALITY_SCALE;

/**
 * Target radii at quality 1.0, in pixels of each stage's own buffer.
 *
 * These are the cost knobs. The flatten loop is O(radius²) per pixel, so 8 is
 * chosen to keep the ellipse near 200 samples; the WGSL bound constant must
 * cover `2 * FLATTEN_RADIUS * max(QUALITY_SCALE)`.
 */
const FLATTEN_RADIUS = 8;
const EDGE_SIGMA = 4;

/** Ink detection above this short edge buys precision the threshold pass discards. */
const INK_RESOLUTION_CAP = 2048;

export interface ComicParams {
  /** Short edge of the flatten buffer; its long edge follows the image aspect. */
  readonly flattenShortEdge: number;
  /** Short edge of the ink buffer. */
  readonly inkShortEdge: number;

  // Flatten, in flatten-buffer pixels.
  readonly radius: number;
  readonly sigmaTensor: number;
  /** Smoothing of the orientation field the ink follows; wider than sigmaTensor. */
  readonly sigmaFlow: number;
  readonly sharpness: number;

  // Ink, in ink-buffer pixels.
  readonly sigmaEdge: number;
  readonly sigmaStreamline: number;
  readonly tau: number;

  // Applied at output resolution.
  readonly edgeThreshold: number;
  readonly edgeSharpness: number;
  readonly inkOpacity: number;
  readonly bins: number;
  readonly quantSharpness: number;
  readonly saturation: number;
  readonly styleMix: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Below this strength the effect fades out entirely, so 0 is a true no-op. */
const NO_OP_FADE = 0.15;

/** Stage resolutions snap to this grid so slider drags do not reallocate every frame. */
const RESOLUTION_STEP = 64;

/**
 * Snap a requested resolution to the grid, never exceeding `ceiling`.
 *
 * Clamping before snapping is not enough: rounding a clamped value can push it
 * back above the ceiling (480 snaps to 512), and the pipeline then allocates
 * the smaller buffer the source can actually supply while the radius is still
 * derived from the larger request. The apparent scale drifts, and since the
 * quality tier changes the request, preview and export drift by different
 * amounts — silently breaking the one invariant this module exists to hold.
 */
function quantise(value: number, ceiling: number): number {
  const snapped = Math.round(value / RESOLUTION_STEP) * RESOLUTION_STEP;
  return Math.max(RESOLUTION_STEP, Math.min(ceiling, snapped));
}

export function resolveComicParams(
  controls: ComicControls,
  outputShortEdge: number,
  quality: StyleQuality,
): ComicParams {
  const detail = clamp(controls.detail, 0, 1);
  const strength = clamp(controls.strength, 0, 1);
  const q = QUALITY_SCALE[quality];

  // Apparent radii, as fractions of the image's short edge.
  const flattenFraction = lerp(0.0176, 0.0059, detail);
  const edgeFraction = lerp(0.0035, 0.0012, detail);

  // Derive each buffer's resolution to hold its radius near the target, then
  // recover the radius from the resolution actually granted. When a clamp
  // binds, the radius shrinks rather than the fraction drifting — which is
  // what keeps composition identical across quality tiers and output sizes.
  //
  // Resolutions are quantised so that dragging a slider crosses a handful of
  // sizes rather than requesting a new one every frame, which would reallocate
  // every intermediate texture per frame. Quantisation is free: the radius is
  // recovered from the granted resolution, so the apparent scale is exactly
  // preserved and only sample density steps.
  const flattenShortEdge = quantise((FLATTEN_RADIUS * q) / flattenFraction, outputShortEdge);
  const inkShortEdge = quantise(
    (EDGE_SIGMA * q) / edgeFraction,
    Math.min(outputShortEdge, Math.round(INK_RESOLUTION_CAP * q)),
  );

  const radius = flattenShortEdge * flattenFraction;
  const sigmaTensor = Math.max(1, 0.33 * radius);
  // The ink follows a more heavily smoothed orientation field than the flatten
  // stage uses. Smoothing the tensor is what makes strokes continuous: it lets
  // a strong contour dictate the direction of its weakly-structured neighbours
  // instead of each pixel following its own noisy gradient.
  const sigmaFlow = 2 * sigmaTensor;

  const sigmaEdge = inkShortEdge * edgeFraction;
  const bins = Math.round(lerp(14, 4, strength));

  return {
    flattenShortEdge,
    inkShortEdge,

    radius,
    sigmaTensor,
    sigmaFlow,
    sharpness: lerp(6, 10, strength),

    sigmaEdge,
    sigmaStreamline: 3 * sigmaEdge,
    // Below ~0.96 the ink breaks into dots; at 1.0 it starts inking sensor
    // noise and out-of-focus texture.
    tau: lerp(0.98, 0.996, detail),

    edgeThreshold: 0,
    edgeSharpness: 200,
    inkOpacity: lerp(0.25, 1, strength),

    bins,
    // The soft-step transition width in L is about 2/sharpness, so it must sit
    // well above the 2*bins that would merely span one band — otherwise
    // quantisation smooths itself back into a no-op.
    quantSharpness: 8 * bins,
    saturation: lerp(1, 1.45, strength),

    styleMix: strength < NO_OP_FADE ? strength / NO_OP_FADE : 1,
  };
}
