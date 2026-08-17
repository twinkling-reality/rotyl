// Flow-based difference of Gaussians, first half: a one-dimensional DoG taken
// ACROSS the local structure direction.
//
// Sampling across the edge rather than isotropically is the whole point. An
// isotropic DoG responds to texture in every direction at once and produces
// broken, cluttered speckle; restricting the kernel to the gradient direction
// measures only "is there a step here", and the second pass then integrates
// that measurement along the edge to produce a continuous stroke.
//
// This is the tau-form: response = C - tau * S, where C and S are Gaussian
// averages at sigma and k*sigma. The commonly published p-form,
// (1 + p)*C - p*S, has a DC gain of 1, so its threshold compares against
// absolute luminance and inks a dark photograph solid black.
//
// Two details that matter:
//   - the input is the FLATTENED layer, not the original photograph; running
//     this on raw pixels turns fur and foliage into stipple noise
//   - iteration 2 re-injects the previous ink into the luminance field, which
//     measurably improves line connectivity

const MAX_TAPS: i32 = 24;
const K: f32 = 1.6;

struct Uniforms {
  texelSize: vec2f,
  sigma: f32,
  tau: f32,
  epsilon: f32,
  sharpness: f32,
  // 0 on the first iteration, 1 once there is a previous response to re-inject.
  reinject: f32,
  _pad: f32,
}

@group(0) @binding(0) var luminanceTex: texture_2d<f32>;
@group(0) @binding(1) var tensorTex: texture_2d<f32>;
@group(0) @binding(2) var previousInkTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<uniform> u: Uniforms;

fn sampleField(uv: vec2f) -> f32 {
  let base = textureSampleLevel(luminanceTex, linearSampler, uv, 0.0).r;
  if (u.reinject < 0.5) {
    return base;
  }
  let previous = textureSampleLevel(previousInkTex, linearSampler, uv, 0.0).r;
  return min(base, inkThreshold(previous, u.epsilon, u.sharpness));
}

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let structure = decodeStructure(textureSampleLevel(tensorTex, linearSampler, uv, 0.0).rgb);
  // Perpendicular to the tangent: straight across the edge.
  let across = vec2f(-structure.tangent.y, structure.tangent.x);

  let sigma = max(u.sigma, 0.1);
  let sigmaWide = sigma * K;
  let taps = min(i32(ceil(2.0 * sigmaWide)), MAX_TAPS);

  let denomNarrow = 2.0 * sigma * sigma;
  let denomWide = 2.0 * sigmaWide * sigmaWide;

  var narrow = 0.0;
  var narrowWeight = 0.0;
  var wide = 0.0;
  var wideWeight = 0.0;

  for (var i = -MAX_TAPS; i <= MAX_TAPS; i++) {
    if (i < -taps) { continue; }
    if (i > taps) { break; }

    let d = f32(i);
    let value = sampleField(uv + across * d * u.texelSize);

    let wNarrow = exp(-(d * d) / denomNarrow);
    narrow += wNarrow * value;
    narrowWeight += wNarrow;

    let wWide = exp(-(d * d) / denomWide);
    wide += wWide * value;
    wideWeight += wWide;
  }

  let response = narrow / narrowWeight - u.tau * (wide / wideWeight);
  return vec4f(response, 0.0, 0.0, 1.0);
}
