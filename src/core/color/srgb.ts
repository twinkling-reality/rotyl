/**
 * sRGB transfer functions.
 *
 * The renderer never calls these: source textures are sampled through an
 * `rgba8unorm-srgb` view and the composite writes through one, so the hardware
 * does the decode and encode for free and bit-exactly. These exist as the
 * test oracle that proves the hardware round trip matches the specification,
 * and for the few CPU-side colour calculations (contrast checks, defaults).
 */

/** sRGB-encoded [0,1] -> linear-light [0,1]. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear-light [0,1] -> sRGB-encoded [0,1]. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
