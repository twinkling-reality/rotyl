import { srgbToLinear } from '../../color/srgb.ts';
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
 * The print style's three controls, and the screen they describe.
 *
 * The image is separated into four ink densities and each is drawn as a
 * rotated dot screen, the way a four-colour press does it. What makes it a
 * style rather than a simulation is that the screen is coarse enough to see:
 * the dots are the point.
 *
 * SCALE IS A FRACTION OF THE IMAGE, as everywhere else in the style layer, and
 * here that is the whole design rather than an optimisation. The screen pitch
 * is a fraction of the short edge, so a photograph exported at 6000 px carries
 * the same number of dots across it as the 1200 px preview the user judged —
 * the dots are larger in pixels and identical in composition. Deriving the
 * pitch in pixels instead would silently turn the preview into a different
 * image from the export, which is the failure mode this discipline exists to
 * prevent.
 *
 * The tone buffer's resolution is then derived FROM the pitch rather than
 * chosen: a screen can carry no detail finer than its own cell, so resolving
 * the photograph beyond a few samples per cell is work whose result the screen
 * discards. Coarser dots therefore cost less, which is the opposite of how a
 * naive implementation behaves.
 */

export const DEFAULT_PRINT_CONTROLS = {
  /** Amount of stylisation. 0 = untouched, 1 = fully graphic. */
  strength: 0.75,
  /** Screen pitch. 0 = a fine magazine screen, 1 = a coarse newsprint one. */
  coarseness: 0.45,
  /** 0 = a single black ink, 1 = four-colour. */
  colour: 1,
} as const;

export const PRINT_CONTROLS: readonly StyleControlSpec[] = [
  { key: 'strength', label: 'Strength', initial: DEFAULT_PRINT_CONTROLS.strength },
  { key: 'coarseness', label: 'Coarseness', initial: DEFAULT_PRINT_CONTROLS.coarseness },
  { key: 'colour', label: 'Colour', initial: DEFAULT_PRINT_CONTROLS.colour },
];

/**
 * Screen pitch as a fraction of the short edge, at either end of the control.
 *
 * The fine end is about 240 rows across the image, which is where a dot stops
 * being a texture and starts being a print process; the coarse end is about 40,
 * which is a poster seen close up.
 */
const FINE_PITCH = 1 / 240;
const COARSE_PITCH = 1 / 40;

/**
 * Tone samples per screen cell.
 *
 * The screen resolves one dot per cell, so this is the point past which extra
 * resolution is discarded. Three keeps the density field smooth under the
 * bilinear magnification without paying for detail the dots cannot carry.
 */
const SAMPLES_PER_CELL = 3;

/**
 * The four plates, in the order the separation writes them.
 *
 * `srgb` is the ink at full coverage, written in the space it was picked in and
 * converted once below rather than kept as linear triples nobody can read.
 *
 * `angle` is the classic screen set, in degrees. Two screens at similar angles
 * beat against each other into coarse moiré; thirty degrees apart the beat is
 * tight enough to read as the rosette that IS the look of colour print. Yellow,
 * the weakest ink, takes the axis-aligned angle where a residual pattern shows
 * least.
 *
 * `drift` is the direction of that plate's registration error, in units of one
 * screen cell. Black carries the detail and is the plate the others register
 * to, so it does not move. Expressing the error in cells rather than pixels
 * keeps it the same fraction of the image at every resolution, which is the
 * same discipline the pitch itself follows.
 */
const INKS = [
  { srgb: [0.0, 0.66, 0.93], angle: 15, drift: [1, 0.35] },
  { srgb: [0.92, 0.1, 0.55], angle: 75, drift: [-0.4, 1] },
  { srgb: [1.0, 0.94, 0.1], angle: 0, drift: [-0.9, -0.7] },
  { srgb: [0.11, 0.1, 0.11], angle: 45, drift: [0, 0] },
] as const;

/** Not white: a warm sheet is most of what separates a print from a posterisation. */
const PAPER_SRGB = [0.976, 0.969, 0.949] as const;

export interface PrintInk {
  /** Screen angle, in radians. */
  readonly angle: number;
  /** Registration error, as a fraction of the image's short edge. */
  readonly offset: readonly [number, number];
  /** Linear-light colour where the ink covers fully. */
  readonly colour: readonly [number, number, number];
}

export interface PrintParams {
  /** Short edge of the tone buffer; its long edge follows the image aspect. */
  readonly toneShortEdge: number;
  /** Distance between screen cells, as a fraction of the image's short edge. */
  readonly pitchFraction: number;
  /** Cyan, magenta, yellow, black — the order the separation writes them in. */
  readonly inks: readonly PrintInk[];
  readonly paper: readonly [number, number, number];

  // Separation, applied at tone resolution.
  /** Density below which no ink is laid down at all, so highlights stay paper. */
  readonly blackPoint: number;
  readonly gain: number;
  readonly colour: number;

  readonly styleMix: number;
}

function linearTriple(srgb: readonly [number, number, number]): [number, number, number] {
  return [srgbToLinear(srgb[0]), srgbToLinear(srgb[1]), srgbToLinear(srgb[2])];
}

export function resolvePrintParams(
  controls: StyleControls,
  outputShortEdge: number,
  quality: StyleQuality,
): PrintParams {
  const strength = control(controls, 'strength', DEFAULT_PRINT_CONTROLS.strength);
  const coarseness = control(controls, 'coarseness', DEFAULT_PRINT_CONTROLS.coarseness);
  const colour = control(controls, 'colour', DEFAULT_PRINT_CONTROLS.colour);
  const q = QUALITY_SCALE[quality];

  // Geometric rather than linear: halving the pitch is the same perceptual step
  // wherever it happens, so a linear control would spend most of its travel in
  // the coarse end where the difference between two settings is one dot.
  const pitchFraction = FINE_PITCH * Math.pow(COARSE_PITCH / FINE_PITCH, coarseness);

  // The one place resolution is decided. Note that the QUALITY TIER SCALES ONLY
  // THIS, never the pitch: a draft frame samples the photograph more coarsely
  // and prints exactly the same screen, so dragging a slider cannot change the
  // composition the user is judging.
  const toneShortEdge = stageResolution((SAMPLES_PER_CELL * q) / pitchFraction, outputShortEdge);

  const registration = lerp(0.08, 0.35, strength) * pitchFraction;

  return {
    toneShortEdge,
    pitchFraction,
    inks: INKS.map((ink) => ({
      angle: (ink.angle * Math.PI) / 180,
      offset: [ink.drift[0] * registration, ink.drift[1] * registration] as const,
      colour: linearTriple(ink.srgb),
    })),
    paper: linearTriple(PAPER_SRGB),

    // Strength buys contrast and clean paper rather than more ink: a press with
    // a raised black point drops its highlights out entirely, which is what
    // makes a print read as graphic rather than as a dotted photograph.
    blackPoint: lerp(0.02, 0.14, strength),
    gain: lerp(1.05, 1.55, strength),
    colour,

    styleMix: fadeToNothing(strength),
  };
}
