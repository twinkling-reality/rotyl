import { linearToOklab } from '../color/oklab.ts';
import { srgbToLinear } from '../color/srgb.ts';

/**
 * Palettes, as gradient maps in Oklab.
 *
 * THE REASON A FILTER LOOKS LIKE A FILTER IS THAT IT KEEPS THE PHOTOGRAPH'S
 * COLOUR. Stylise hazy traffic and the flattening, the quantisation and the ink
 * all do their job, and the result is grey, because the input was grey. An
 * illustration of the same street is not grey — not because it was drawn better
 * but because someone CHOSE the colours, and the choosing is the part no amount
 * of edge detection supplies.
 *
 * So a palette here maps LIGHTNESS to colour, rather than nudging the colours
 * that are already there. Dark parts of the picture take the dark end of the
 * ramp, light parts the light end, and everything between interpolates. Form
 * survives completely — it is carried by lightness, which is exactly what is
 * being used as the index — while hue is replaced wholesale. A photograph's own
 * hue contributes nothing, which is the point: smog has no hue worth keeping.
 *
 * Interpolated in Oklab, not in RGB, so the midpoint between two stops is the
 * colour a person would call the midpoint rather than the one the wire format
 * happens to produce. Mixing a deep teal and a cream in linear RGB passes
 * through a muddy green; in Oklab it does not.
 *
 * FIVE STOPS, EVENLY SPACED. Enough for a ramp with a shadow, a midtone and a
 * highlight plus the two transitions; few enough that the whole palette fits in
 * one uniform slot beside the parameters that use it.
 */

export const PALETTE_STOPS = 5;

export interface Palette {
  readonly name: string;
  /** Dark to light, as sRGB hex. */
  readonly stops: readonly [string, string, string, string, string];
}

/**
 * The first entry is no palette at all.
 *
 * Present as a choice rather than only as an amount of zero because "off" is a
 * thing people look for by name, and hunting for the slider that turns
 * something off is worse than one more button.
 */
export const PALETTES: readonly Palette[] = [
  { name: 'None', stops: ['#000000', '#404040', '#808080', '#bfbfbf', '#ffffff'] },
  // The reference this was built for: a mural of a street under flame trees,
  // painted in petrol and aqua with a cream sky.
  { name: 'Mural', stops: ['#0b2e3f', '#14697a', '#2fa8a0', '#8fd6c4', '#f2ead3'] },
  // Risograph: two inks that should not work together, and do.
  { name: 'Riso', stops: ['#1b1035', '#6a1e6e', '#d6336c', '#f97f4e', '#ffe3a3'] },
  { name: 'Emerald', stops: ['#07130f', '#14432f', '#2e7d4f', '#86c46a', '#f0f3c4'] },
  // Cool monochrome. The one that makes grey footage look deliberate rather
  // than merely grey.
  { name: 'Noir', stops: ['#0a0e14', '#253243', '#55647a', '#a3b0be', '#f4f1ea'] },
];

function hexToOklab(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const linear = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((channel) =>
    srgbToLinear(channel / 255),
  );
  const { L, a, b } = linearToOklab({ r: linear[0] ?? 0, g: linear[1] ?? 0, b: linear[2] ?? 0 });
  return [L, a, b];
}

/**
 * One palette as uniform floats: five stops of Oklab, padded to vec4.
 *
 * Converted here rather than in the shader because it is the same twenty
 * numbers on every frame, and because the conversion is one place where a
 * mistake would be a subtle hue shift rather than an obvious failure.
 */
export function paletteUniform(index: number): number[] {
  const palette = PALETTES[Math.min(PALETTES.length - 1, Math.max(0, Math.round(index)))] ?? PALETTES[0];
  if (!palette) return Array.from({ length: PALETTE_STOPS * 4 }, () => 0);
  return palette.stops.flatMap((hex) => [...hexToOklab(hex), 0]);
}

/**
 * Where a palette's own lightness sits: its mean and spread, and its mean
 * chroma.
 *
 * Measured from the stops rather than declared, because a palette is chosen by
 * picking five colours and nobody picking them is thinking about a standard
 * deviation. The style layer uses these to fit the picture to the palette; see
 * fitLightness in wgsl/palette.wgsl for why that is necessary at all.
 */
export function paletteLightness(index: number): { mean: number; spread: number; chroma: number } {
  const palette = PALETTES[Math.min(PALETTES.length - 1, Math.max(0, Math.round(index)))] ?? PALETTES[0];
  const lab = (palette?.stops ?? []).map((hex) => hexToOklab(hex));
  if (lab.length === 0) return { mean: 0.5, spread: 0.25, chroma: 0.05 };

  const mean = lab.reduce((total, [L]) => total + L, 0) / lab.length;
  const variance = lab.reduce((total, [L]) => total + (L - mean) ** 2, 0) / lab.length;
  const chroma = lab.reduce((total, [, a, b]) => total + Math.hypot(a, b), 0) / lab.length;
  return { mean, spread: Math.sqrt(variance), chroma };
}

export const PALETTE_NAMES: readonly string[] = PALETTES.map((palette) => palette.name);
