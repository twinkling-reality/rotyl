import {
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
 * The anime style's controls, and the character treatment they drive.
 *
 * This is not the comic chain with different numbers. Comic flattens, inks,
 * and optionally replaces hue with a five-stop palette. That is a graphic
 * treatment of a photograph. This style keeps the photograph's hue, which is
 * where identity lives, and rebuilds lighting, banding and line into a cel
 * illustration of the same person.
 *
 * SCALE IS A FRACTION OF THE IMAGE, as everywhere in the style layer. The
 * flatten and the ink derive their buffers from an apparent scale, recover
 * their radii from the resolution actually granted, and therefore compose
 * identically at every output size and quality tier. Preview matches export
 * because nothing below is a function of the output resolution except through
 * that shared derivation.
 *
 * Strength is a true crossfade to the photograph, the same promise every other
 * style makes. Line is ink weight. Colour is how far the split-tone, chroma
 * reshape and hair specular go; at zero the chain still flattens and inks, it
 * just stops choosing a lighting key.
 */

export const DEFAULT_ANIME_CONTROLS = {
  /** Amount of stylisation. 0 = the photograph, 1 = the full treatment. */
  strength: 0.88,
  /** Scale of abstraction. 0 = broad cel shapes, 1 = finer structure kept. */
  detail: 0.42,
  /** How far toward the illustrated lighting and chroma. */
  colour: 0.78,
  /** Contour weight. */
  line: 0.82,
} as const;

export const ANIME_CONTROLS: readonly StyleControlSpec[] = [
  { kind: 'scalar', key: 'strength', label: 'Strength', initial: DEFAULT_ANIME_CONTROLS.strength },
  { kind: 'scalar', key: 'detail', label: 'Detail', initial: DEFAULT_ANIME_CONTROLS.detail },
  { kind: 'scalar', key: 'colour', label: 'Colour', initial: DEFAULT_ANIME_CONTROLS.colour },
  { kind: 'scalar', key: 'line', label: 'Line', initial: DEFAULT_ANIME_CONTROLS.line },
];

const FLATTEN_RADIUS = 8;
const EDGE_SIGMA = 4;
const FLATTEN_DOWNSAMPLE = Math.SQRT2;
const INK_RESOLUTION_CAP = 2048;

export interface AnimeParams {
  readonly flattenShortEdge: number;
  readonly inkShortEdge: number;

  readonly radius: number;
  readonly sigmaTensor: number;
  readonly sigmaFlow: number;
  readonly sharpness: number;

  readonly sigmaEdge: number;
  readonly sigmaStreamline: number;
  readonly tau: number;

  readonly edgeThreshold: number;
  readonly edgeSharpness: number;
  readonly inkOpacity: number;
  readonly bins: number;
  readonly quantSharpness: number;
  readonly colour: number;
  readonly splitTone: number;
  readonly chromaLift: number;
  readonly skinHold: number;
  readonly specular: number;
  readonly styleMix: number;
}

export function resolveAnimeParams(
  controls: StyleControls,
  outputShortEdge: number,
  quality: StyleQuality,
): AnimeParams {
  const detail = control(controls, 'detail', DEFAULT_ANIME_CONTROLS.detail);
  const strength = control(controls, 'strength', DEFAULT_ANIME_CONTROLS.strength);
  const colour = control(controls, 'colour', DEFAULT_ANIME_CONTROLS.colour);
  const line = control(controls, 'line', DEFAULT_ANIME_CONTROLS.line);
  const q = QUALITY_SCALE[quality];

  // Slightly broader flatten than the comic default: cel illustration wants
  // larger regions, and the identity of a face is carried by hue and by the
  // ink, not by photographic pore texture.
  const flattenFraction = lerp(0.0195, 0.0066, detail);
  const edgeFraction = lerp(0.0038, 0.0013, detail);

  const flattenShortEdge = stageResolution(
    (FLATTEN_RADIUS * q) / flattenFraction,
    Math.round(outputShortEdge / FLATTEN_DOWNSAMPLE),
  );
  const inkShortEdge = stageResolution(
    (EDGE_SIGMA * q) / edgeFraction,
    Math.min(outputShortEdge, Math.round(INK_RESOLUTION_CAP * q)),
  );

  const radius = flattenShortEdge * flattenFraction;
  const sigmaTensor = Math.max(1, 0.33 * radius);
  const sigmaEdge = inkShortEdge * edgeFraction;

  return {
    flattenShortEdge,
    inkShortEdge,

    radius,
    sigmaTensor,
    sigmaFlow: 2 * sigmaTensor,
    sharpness: lerp(7, 11, strength),

    sigmaEdge,
    sigmaStreamline: 3 * sigmaEdge,
    tau: lerp(0.982, 0.996, detail),

    edgeThreshold: 0,
    edgeSharpness: 220,
    inkOpacity: lerp(0.2, 1, line),

    // Fewer bands than comic at the same strength: three to five reads as cel
    // paint, fourteen reads as a posterised photograph.
    bins: Math.round(lerp(5.2, 3.2, strength)),
    quantSharpness: lerp(18, 36, strength),
    colour,
    splitTone: lerp(0.04, 0.11, colour),
    chromaLift: lerp(0.08, 0.38, colour),
    skinHold: lerp(0.15, 0.55, colour),
    specular: lerp(0.04, 0.18, colour),

    styleMix: fadeToNothing(strength),
  };
}
