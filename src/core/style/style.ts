import type { Dimensions } from '../render/resolution.ts';

/**
 * What a style is, as far as the rest of Rotyl is concerned.
 *
 * Everything upstream of this file, the engine, the export path, the UI,
 * knows only that a style turns a source texture into a styled texture at
 * output resolution, and that it is driven by some named scalars. Nothing
 * upstream knows what a cel band or a halftone dot is, which is what makes
 * adding a style a matter of adding a directory rather than of threading a new
 * type through five layers.
 *
 * THE COMPOSITE IS NOT PART OF A STYLE. It reads the mask, blends, and is the
 * same single pass whatever produced the styled layer. That separation is the
 * product's central promise expressed as a boundary: a style cannot see the
 * selection, so it cannot accidentally stop being applied selectively.
 */

/**
 * A style's controls, as values in [0, 1] keyed by name.
 *
 * Deliberately not a per-style interface. The UI builds sliders from the
 * declared controls and the app stores whatever it is handed, so a style with
 * three controls needs no UI code of its own; a resolver reads the keys it
 * knows and falls back for the rest, so a control record from a different style
 * degrades to defaults rather than to NaN.
 */
export type StyleControls = Readonly<Record<string, number>>;

/**
 * One control a style declares.
 *
 * A CHOICE IS STILL A NUMBER. Its value is an index into `options`, which is
 * why `StyleControls` stays a record of numbers and why nothing between here
 * and the export path had to learn a second shape: the app stores it, compares
 * it and hands it back exactly as it does a slider. All the declaration buys is
 * that the panel draws buttons instead of a track, and that a style can offer a
 * decision that has no meaningful midpoint.
 */
export type StyleControlSpec =
  | {
      readonly kind: 'scalar';
      readonly key: string;
      /** Shown next to the slider, and used as its accessible name. */
      readonly label: string;
      readonly initial: number;
    }
  | {
      readonly kind: 'choice';
      readonly key: string;
      readonly label: string;
      /** An index into `options`. */
      readonly initial: number;
      readonly options: readonly string[];
    };

/**
 * Read one control, clamped, with the style's own default for anything absent
 * or non-finite.
 */
export function control(controls: StyleControls, key: string, fallback: number): number {
  const value = controls[key];
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/**
 * Read a choice as an index, rounded and clamped to the options that exist.
 *
 * Separate from `control` because that one clamps to [0, 1], which is right for
 * every scalar and silently wrong for an index. A palette chosen fourth would
 * come back as the first.
 */
export function choice(controls: StyleControls, key: string, count: number, fallback: number): number {
  const value = controls[key];
  const index = value === undefined || !Number.isFinite(value) ? fallback : Math.round(value);
  return Math.min(Math.max(0, count - 1), Math.max(0, index));
}

/**
 * Quality tiers scale a stage's SAMPLE DENSITY, never its apparent scale.
 *
 * Raising the tier buys a stage more resolution and, where the stage has a
 * kernel, a proportionally larger radius, so every length stays the same
 * fraction of the image and a draft composes exactly like an export.
 */
export const QUALITY_SCALE = {
  /** While a slider is being dragged. */
  draft: 0.6,
  /** Settled, and what the user judges the result by. */
  full: 1,
  /** Export: no longer competing with input latency. */
  export: 1.4,
} as const;

export type StyleQuality = keyof typeof QUALITY_SCALE;

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Stage resolutions snap to this grid so slider drags do not reallocate every frame. */
const RESOLUTION_STEP = 64;

/**
 * Snap a requested stage resolution to the grid, never exceeding `ceiling`.
 *
 * Clamping before snapping is not enough: rounding a clamped value can push it
 * back above the ceiling (480 snaps to 512), and the pipeline then allocates
 * the smaller buffer the source can actually supply while the kernel is still
 * derived from the larger request. The apparent scale drifts, and since the
 * quality tier changes the request, preview and export drift by different
 * amounts. Silently breaking the one invariant this layer exists to hold.
 *
 * Quantisation itself is free, because every style recovers its lengths from
 * the resolution actually granted rather than from the one it asked for. Only
 * sample density steps; the fraction of the image is exactly preserved.
 */
export function stageResolution(request: number, ceiling: number): number {
  const snapped = Math.round(request / RESOLUTION_STEP) * RESOLUTION_STEP;
  return Math.max(RESOLUTION_STEP, Math.min(ceiling, snapped));
}

/** Below this strength an effect fades out entirely, so 0 is a true no-op. */
const NO_OP_FADE = 0.15;

/**
 * The crossfade a style hands the composite at low strength.
 *
 * Shared because it is a promise the product makes rather than a look: at zero
 * strength every style must return the photograph, not a faint residue of
 * itself. A style whose parameters happen to approach identity is not enough.
 * quantisation and thresholding do not fade gracefully.
 */
export function fadeToNothing(strength: number): number {
  return strength < NO_OP_FADE ? strength / NO_OP_FADE : 1;
}

export interface StyledLayer {
  /** Output resolution, WORKING_FORMAT, valid until the next render. */
  readonly texture: GPUTexture;
  /**
   * How much of this layer the composite blends where coverage is full.
   *
   * A style owns its own fade to nothing, because "nothing" is a claim about
   * the style: below some strength the effect should read as absent rather
   * than as a faint residue. The composite folds it into coverage, which costs
   * nothing and keeps mix(base, styled, 0) exact.
   */
  readonly mix: number;
}

export interface StylePipeline {
  /**
   * Run the chain for one frame.
   *
   * `sourceView` is an sRGB view, so every stage works in linear light. The
   * returned texture is owned by the pipeline and reused next frame.
   */
  render(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    source: Dimensions,
    output: Dimensions,
    controls: StyleControls,
    quality: StyleQuality,
  ): StyledLayer;

  dispose(): void;
}

export interface StyleDefinition {
  readonly id: string;
  /** Shown in the style picker. */
  readonly name: string;
  readonly controls: readonly StyleControlSpec[];
  create(device: GPUDevice): StylePipeline;
}

export function defaultControls(style: StyleDefinition): StyleControls {
  return Object.fromEntries(style.controls.map((spec) => [spec.key, spec.initial]));
}

/** Whether two control records would produce the same render. */
export function sameControls(a: StyleControls, b: StyleControls): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}
