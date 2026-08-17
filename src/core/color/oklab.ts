/**
 * Oklab (Björn Ottosson) conversions from and to linear-light sRGB.
 *
 * The comic style quantises lightness only. Doing that in Oklab rather than in
 * RGB is what keeps cel bands free of hue shift: quantising the three linear
 * RGB channels independently produces green/red/magenta blotches at band
 * boundaries, because each channel steps at a different luminance.
 *
 * Mirrors the WGSL in `color/color.wgsl`; the two are kept in agreement by
 * the colour tests.
 *
 * The `l_` / `m_` / `s_` names are Ottosson's own notation for the cube-rooted
 * LMS intermediates, kept verbatim so the implementation can be checked against
 * the published derivation line by line. `.oxlintrc.json` exempts this file
 * from the trailing-underscore rule for that reason alone.
 */

export interface Lab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Linear-light sRGB -> Oklab. */
export function linearToOklab({ r, g, b }: Rgb): Lab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/**
 * Oklab -> linear-light sRGB.
 *
 * The result is deliberately NOT clamped: Oklab describes colours outside the
 * sRGB gamut, and a saturation boost routinely leaves it. Callers clamp after
 * conversion, never before, so that out-of-gamut intermediates round-trip.
 */
export function oklabToLinear({ L, a, b }: Lab): Rgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}
