import { PALETTE_NAMES, PALETTES, paletteLightness, paletteUniform } from '../palette.ts';
import {
  choice,
  control,
  fadeToNothing,
  lerp,
  QUALITY_SCALE,
  stageResolution,
  type StyleControlSpec,
  type StyleControls,
  type StyleQuality,
} from '../style.ts';

/**
 * The comic style's two user controls, and every internal constant they drive.
 *
 * SCALE IS EXPRESSED AS A FRACTION OF THE IMAGE, NEVER IN PIXELS.
 *
 * Both expensive stages, the anisotropic Kuwahara flatten and the flow-based
 * DoG ink, have a characteristic radius. Written the obvious way, that radius
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
 * slider values alone. Never of the output resolution. Raising the quality
 * tier scales a stage's resolution and its radius by the same factor, which
 * leaves the fraction, and therefore the composition, identical.
 *
 * Fractions are calibrated against a 512 px reference (hence the /512 terms).
 */

export const DEFAULT_COMIC_CONTROLS = {
  /** Amount of stylisation. 0 = untouched, 1 = fully graphic. */
  strength: 0.7,
  /** Scale of abstraction. 0 = broad flat shapes, 1 = fine detail preserved. */
  detail: 0.5,
  /** Index into PALETTES. 0 is no palette. */
  palette: 0,
  /** How far toward the palette. 0 = the photograph's own colour. */
  colour: 0.85,
} as const;

export const COMIC_CONTROLS: readonly StyleControlSpec[] = [
  { kind: 'scalar', key: 'strength', label: 'Strength', initial: DEFAULT_COMIC_CONTROLS.strength },
  { kind: 'scalar', key: 'detail', label: 'Detail', initial: DEFAULT_COMIC_CONTROLS.detail },
  {
    kind: 'choice',
    key: 'palette',
    label: 'Palette',
    initial: DEFAULT_COMIC_CONTROLS.palette,
    options: PALETTE_NAMES,
  },
  { kind: 'scalar', key: 'colour', label: 'Colour', initial: DEFAULT_COMIC_CONTROLS.colour },
];

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
  /** How far toward the palette, already zeroed when the palette is None. */
  readonly paletteAmount: number;
  /** Five Oklab stops, padded to vec4, ready for the uniform. */
  readonly paletteStops: readonly number[];
  /** Where the palette's own lightness sits, so the picture can be fitted to it. */
  readonly paletteMeanLightness: number;
  readonly paletteLightnessSpread: number;
}

export function resolveComicParams(
  controls: StyleControls,
  outputShortEdge: number,
  quality: StyleQuality,
): ComicParams {
  const detail = control(controls, 'detail', DEFAULT_COMIC_CONTROLS.detail);
  const strength = control(controls, 'strength', DEFAULT_COMIC_CONTROLS.strength);
  const palette = choice(controls, 'palette', PALETTES.length, DEFAULT_COMIC_CONTROLS.palette);
  const q = QUALITY_SCALE[quality];

  // Apparent radii, as fractions of the image's short edge.
  const flattenFraction = lerp(0.0176, 0.0059, detail);
  const edgeFraction = lerp(0.0035, 0.0012, detail);

  // Derive each buffer's resolution to hold its radius near the target, then
  // recover the radius from the resolution actually granted. When a clamp
  // binds, the radius shrinks rather than the fraction drifting, which is
  // what keeps composition identical across quality tiers and output sizes.
  //
  // Resolutions are quantised so that dragging a slider crosses a handful of
  // sizes rather than requesting a new one every frame, which would reallocate
  // every intermediate texture per frame. Quantisation is free: the radius is
  // recovered from the granted resolution, so the apparent scale is exactly
  // preserved and only sample density steps.
  const flattenShortEdge = stageResolution((FLATTEN_RADIUS * q) / flattenFraction, outputShortEdge);
  const inkShortEdge = stageResolution(
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
  const fit = paletteLightness(palette);

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
    // well above the 2*bins that would merely span one band. Otherwise
    // quantisation smooths itself back into a no-op.
    quantSharpness: 8 * bins,
    saturation: lerp(1, 1.45, strength),

    // Index zero is no palette, so it costs nothing rather than mapping the
    // image onto a grey ramp that would merely desaturate it.
    paletteAmount: palette === 0 ? 0 : control(controls, 'colour', DEFAULT_COMIC_CONTROLS.colour),
    paletteStops: paletteUniform(palette),
    paletteMeanLightness: fit.mean,
    paletteLightnessSpread: fit.spread,

    styleMix: fadeToNothing(strength),
  };
}
