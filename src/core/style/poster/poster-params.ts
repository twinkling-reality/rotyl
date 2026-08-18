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
 * The poster style's controls, and the flatten they describe.
 *
 * This style exists because of what the other two measured. The comic chain
 * costs 120 ms a frame and essentially all of it is one stage: an anisotropic
 * Kuwahara, which is O(radius squared) per pixel. The print chain costs half a
 * millisecond. Between those two numbers is the observation that a style does
 * not have to be expensive to be flat - it has to make a DECISION, and a
 * decision is cheap. So the flatten here is a separable bilateral, which is
 * O(radius), and everything that defines the look is one pass at output
 * resolution.
 *
 * SCALE IS A FRACTION OF THE IMAGE, as everywhere in the style layer. The
 * bilateral's sigma is expressed as a fraction of the short edge and its
 * buffer's resolution is DERIVED to hold that fraction, so cost is linear in
 * pixels and "more detail" buys resolution rather than kernel width. The line's
 * width is a fraction of the image too, which is what makes a preview and a
 * 6000 px export the same drawing rather than the same drawing with a hairline.
 */

export const DEFAULT_POSTER_CONTROLS = {
  /** Amount of stylisation. 0 = untouched, 1 = fully graphic. */
  strength: 0.7,
  /** Scale of the flatten. 0 = few large areas, 1 = smaller ones. */
  detail: 0.5,
  /** Index into PALETTES. 0 is no palette: the picture's own colour, flattened. */
  palette: 0,
  /** How far toward the palette. */
  colour: 0.9,
  /** Outlines: how heavy, and how faint a boundary still gets one. */
  line: 0.55,
} as const;

export const POSTER_CONTROLS: readonly StyleControlSpec[] = [
  { kind: 'scalar', key: 'strength', label: 'Strength', initial: DEFAULT_POSTER_CONTROLS.strength },
  { kind: 'scalar', key: 'detail', label: 'Detail', initial: DEFAULT_POSTER_CONTROLS.detail },
  {
    kind: 'choice',
    key: 'palette',
    label: 'Palette',
    initial: DEFAULT_POSTER_CONTROLS.palette,
    options: PALETTE_NAMES,
  },
  { kind: 'scalar', key: 'colour', label: 'Colour', initial: DEFAULT_POSTER_CONTROLS.colour },
  { kind: 'scalar', key: 'line', label: 'Line', initial: DEFAULT_POSTER_CONTROLS.line },
];

/**
 * Passes of the bilateral, and the sigma each one runs at.
 *
 * Three, because a single wide pass blurs and three narrow ones FLATTEN: each
 * pulls a region toward its own mean, so the sequence converges on
 * piecewise-constant. Six is a per-pass sigma large enough that the buffer
 * holding a given apparent scale is a few hundred pixels rather than a few
 * dozen - the same trade the comic style makes with its Kuwahara radius, at a
 * quarter of the exponent.
 */
const ITERATIONS = 3;
const SIGMA = 6;

/** Independent passes of sigma s compose to sigma s*sqrt(n). */
const EFFECTIVE = Math.sqrt(ITERATIONS);

/** The line's width, as a fraction of the image's short edge. */
const LINE_FRACTION = 0.0022;

export interface PosterParams {
  /** Short edge of the flatten buffer; its long edge follows the image aspect. */
  readonly flattenShortEdge: number;
  readonly iterations: number;
  /** Spatial sigma of one pass, in flatten-buffer texels. */
  readonly sigmaSpatial: number;
  /** Range sigma, in square-root-of-linear units. */
  readonly sigmaRange: number;

  // Applied at output resolution.
  readonly levels: number;
  readonly chromaStep: number;
  readonly saturation: number;
  readonly paletteAmount: number;
  readonly paletteStops: readonly number[];
  /** Where the palette's own lightness sits, so the picture can be fitted to it. */
  readonly paletteMeanLightness: number;
  readonly paletteLightnessSpread: number;
  readonly paletteChroma: number;
  /** Half-width of an outline, as a fraction of the image's short edge. */
  readonly lineFraction: number;
  readonly lineWeight: number;
  /** How far apart two flat colours must be, in Oklab, before a line is drawn. */
  readonly lineThreshold: number;
  readonly lineSoftness: number;

  readonly styleMix: number;
}

export function resolvePosterParams(
  controls: StyleControls,
  outputShortEdge: number,
  quality: StyleQuality,
): PosterParams {
  const strength = control(controls, 'strength', DEFAULT_POSTER_CONTROLS.strength);
  const detail = control(controls, 'detail', DEFAULT_POSTER_CONTROLS.detail);
  const line = control(controls, 'line', DEFAULT_POSTER_CONTROLS.line);
  const palette = choice(controls, 'palette', PALETTES.length, DEFAULT_POSTER_CONTROLS.palette);
  const q = QUALITY_SCALE[quality];

  // The apparent radius of the whole flatten, as a fraction of the short edge -
  // deliberately larger than the comic style's, because the point of this one
  // is fewer and larger areas rather than painterly patches.
  const flattenFraction = lerp(0.036, 0.012, detail);
  const sigmaFraction = flattenFraction / EFFECTIVE;

  // Derive the buffer to hold that fraction, then recover the sigma from the
  // resolution actually granted. When a clamp binds, the sigma shrinks rather
  // than the fraction drifting, which is what keeps composition identical
  // across quality tiers and output sizes.
  const flattenShortEdge = stageResolution((SIGMA * q) / sigmaFraction, outputShortEdge);
  const sigmaSpatial = flattenShortEdge * sigmaFraction;

  const levels = Math.round(lerp(12, 5, strength));
  const fit = paletteLightness(palette);

  return {
    flattenShortEdge,
    iterations: ITERATIONS,
    sigmaSpatial,
    // Wider as strength rises: a bigger range sigma merges more of what the
    // picture calls separate, which is the same move as fewer levels and is
    // what stops the two fighting each other.
    sigmaRange: lerp(0.028, 0.08, strength),

    levels,
    // One step of chroma per two of lightness, roughly: colour carries less of
    // the form than lightness does, so quantising it as hard reads as a fault.
    chromaStep: lerp(0.018, 0.042, strength),
    saturation: lerp(1, 1.45, strength),

    // Index zero is no palette, so it costs nothing rather than mapping the
    // image onto a grey ramp that would merely desaturate it.
    paletteAmount: palette === 0 ? 0 : control(controls, 'colour', DEFAULT_POSTER_CONTROLS.colour),
    paletteStops: paletteUniform(palette),
    paletteMeanLightness: fit.mean,
    paletteLightnessSpread: fit.spread,
    paletteChroma: fit.chroma,

    lineFraction: LINE_FRACTION,
    lineWeight: line,
    // THE THRESHOLD IS THE WHOLE POINT OF THE LINE. It is the distance in Oklab
    // at which two flat areas count as different things, so raising the control
    // does not only darken the lines - it draws more of them, reaching further
    // into boundaries the flatten found faint.
    lineThreshold: lerp(0.2, 0.045, line),
    // HALF the width of that threshold's transition: the decision is resolved
    // around the threshold rather than displaced past it. The shader floors it.
    lineSoftness: 0.02,

    styleMix: fadeToNothing(strength),
  };
}
