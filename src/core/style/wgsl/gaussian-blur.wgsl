// Separable Gaussian, one axis per invocation.
//
// Used only on the structure tensor, never on colour: smoothing the tensor is
// what turns a noisy per-pixel gradient into a coherent orientation field, and
// it is the reason the ink follows contours instead of chasing texture.

const MAX_RADIUS: i32 = 24;

struct Uniforms {
  // Texel step along the axis being blurred; the other component is zero.
  direction: vec2f,
  sigma: f32,
  _pad: f32,
}

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sigma = max(u.sigma, 1e-4);
  let radius = min(i32(ceil(sigma * 3.0)), MAX_RADIUS);
  let denominator = 2.0 * sigma * sigma;

  var total = vec3f(0.0);
  var weightSum = 0.0;

  for (var i = -MAX_RADIUS; i <= MAX_RADIUS; i++) {
    if (i < -radius) { continue; }
    if (i > radius) { break; }

    let offset = f32(i);
    let weight = exp(-(offset * offset) / denominator);
    total += weight * textureSampleLevel(sourceTex, sourceSampler, uv + u.direction * offset, 0.0).rgb;
    weightSum += weight;
  }

  return vec4f(total / weightSum, 1.0);
}
