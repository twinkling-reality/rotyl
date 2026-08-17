// Shared colour maths, prepended to the shaders that need it.
//
// Everything here operates in LINEAR light. Source textures are sampled
// through an sRGB view so the decode has already happened by the time a value
// reaches these functions.

const REC709 = vec3f(0.2126, 0.7152, 0.0722);

fn luminance(c: vec3f) -> f32 {
  return dot(c, REC709);
}

// The sRGB encode, in software.
//
// Normally the hardware does this when the composite writes through an sRGB
// view, and doing it by hand would be a second, redundant encode. Two consumers
// are not displays and do need it explicitly: a segmentation model, which was
// trained on ordinary encoded image files, and the print style's separation,
// where ink density is a perceptual quantity rather than a radiometric one.
// Feeding either linear light is not a subtle error — every shadow arrives
// several stops too dark.
//
// In both cases the encode happens AFTER any averaging. Averaging encoded
// values darkens every edge it touches.
fn linearToSrgb(c: vec3f) -> vec3f {
  let low = c * 12.92;
  let high = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, c <= vec3f(0.0031308));
}

// Oklab (Ottosson). Lightness in Oklab is perceptually uniform, which is why
// the cel bands are quantised there: quantising the three linear RGB channels
// independently steps each one at a different luminance and produces green and
// magenta blotches along every band boundary.
fn linearToOklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;

  // Guard the cube roots: a wide-gamut or out-of-range input can make these
  // negative, and pow() of a negative base is undefined.
  let l_ = pow(max(l, 0.0), 1.0 / 3.0);
  let m_ = pow(max(m, 0.0), 1.0 / 3.0);
  let s_ = pow(max(s, 0.0), 1.0 / 3.0);

  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}

fn oklabToLinear(lab: vec3f) -> vec3f {
  let l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  let m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  let s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;

  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;

  return vec3f(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}

// Orientation and anisotropy from a smoothed structure tensor (E, F, G).
//
// The returned tangent is the eigenvector of the SMALLER eigenvalue: the
// direction of least change, i.e. along an edge rather than across it. The
// tensor is deliberately not normalised before smoothing, so strong edges
// propagate their orientation into weakly-structured neighbours, which is what
// makes the field usable in flat regions.
struct Structure {
  tangent: vec2f,
  anisotropy: f32,
}

fn decodeStructure(tensor: vec3f) -> Structure {
  let e = tensor.x;
  let f = tensor.y;
  let g = tensor.z;

  let d = sqrt(max(0.0, (e - g) * (e - g) + 4.0 * f * f));
  let lambda1 = (e + g + d) * 0.5;
  let lambda2 = (e + g - d) * 0.5;

  var t = vec2f(lambda1 - e, -f);
  let len = length(t);
  // In a genuinely flat neighbourhood the eigenvector is undefined; any fixed
  // direction will do, and the anisotropy will be 0 so nothing depends on it.
  if (len < 1e-8) {
    t = vec2f(0.0, 1.0);
  } else {
    t = t / len;
  }

  let trace = lambda1 + lambda2;
  var anisotropy = 0.0;
  if (trace > 1e-8) {
    anisotropy = (lambda1 - lambda2) / trace;
  }

  var out: Structure;
  out.tangent = t;
  out.anisotropy = clamp(anisotropy, 0.0, 1.0);
  return out;
}
