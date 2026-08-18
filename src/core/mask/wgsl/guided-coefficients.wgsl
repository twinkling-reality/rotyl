// The guided filter's local linear model (He, Sun and Tang).
//
// Over each window the output matte is assumed to be an affine function of the
// guide colour, q = dot(a, I) + b, and a and b are the least-squares fit of that
// assumption to the coarse mask. Two consequences are the whole reason this
// stage exists:
//
//   Inside an object, where the mask is locally constant, the fit degenerates
//   to a = 0, b = p. The mask passes through untouched.
//
//   Across a boundary, a is large along whichever colour direction separates
//   the two sides, so the matte transitions exactly where the image does. That
//   is what lets a 256 px mask produce an edge at 4000 px that follows the
//   object rather than the mask's own texel grid.
//
// The guide is three-channel, so the fit is a 3x3 solve rather than a scalar
// divide. A luminance-only guide is cheaper and much worse in the case that
// matters most: two regions of equal lightness and different hue, where the
// scalar filter sees no edge at all and smears the boundary straight through.
//
// eps regularises the solve and doubles as the knob deciding how faint an edge
// is worth following. Because the guide is Oklab, one value means the same
// thing in shadow and highlight.

struct Uniforms {
  epsilon: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var meanGuideTex: texture_2d<f32>;
@group(0) @binding(1) var meanPlane1Tex: texture_2d<f32>;
@group(0) @binding(2) var meanPlane2Tex: texture_2d<f32>;
@group(0) @binding(3) var meanPlane3Tex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let coord = vec2i(fragCoord.xy);
  let g = textureLoad(meanGuideTex, coord, 0);
  let p1 = textureLoad(meanPlane1Tex, coord, 0);
  let p2 = textureLoad(meanPlane2Tex, coord, 0);
  let p3 = textureLoad(meanPlane3Tex, coord, 0);

  let meanI = g.xyz;
  let meanP = g.w;

  // Covariance of the guide, plus eps on the diagonal.
  let s00 = p1.x - meanI.x * meanI.x + u.epsilon;
  let s01 = p1.y - meanI.x * meanI.y;
  let s02 = p1.z - meanI.x * meanI.z;
  let s11 = p1.w - meanI.y * meanI.y + u.epsilon;
  let s12 = p2.x - meanI.y * meanI.z;
  let s22 = p2.y - meanI.z * meanI.z + u.epsilon;

  let covIp = vec3f(p2.z, p2.w, p3.x) - meanI * meanP;

  let c00 = s11 * s22 - s12 * s12;
  let c01 = s02 * s12 - s01 * s22;
  let c02 = s01 * s12 - s02 * s11;
  let determinant = s00 * c00 + s01 * c01 + s02 * c02;

  // eps on the diagonal keeps a positive semi-definite covariance invertible,
  // so this only fires on genuine numerical trouble. Falling back to a = 0
  // leaves the matte equal to the local mean of the coarse mask, which is a
  // blur rather than an artefact.
  if (abs(determinant) < 1e-12) {
    return vec4f(0.0, 0.0, 0.0, meanP);
  }

  let c11 = s00 * s22 - s02 * s02;
  let c12 = s02 * s01 - s00 * s12;
  let c22 = s00 * s11 - s01 * s01;

  let inverse = mat3x3f(
    vec3f(c00, c01, c02),
    vec3f(c01, c11, c12),
    vec3f(c02, c12, c22),
  ) * (1.0 / determinant);

  let a = inverse * covIp;
  return vec4f(a, meanP - dot(a, meanI));
}
