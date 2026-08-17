// Flow-based difference of Gaussians, second half: integrate the edge response
// ALONG the local structure direction.
//
// The first pass answers "is there a step across this point"; this one walks
// the streamline through the point and averages that answer over its
// neighbours along the edge. Isolated responses from noise average away, while
// responses that agree along a contour reinforce — which is the difference
// between a speckle field and a drawn line.

const MAX_STEPS: i32 = 40;

struct Uniforms {
  texelSize: vec2f,
  sigma: f32,
  _pad: f32,
}

@group(0) @binding(0) var responseTex: texture_2d<f32>;
@group(0) @binding(1) var tensorTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> u: Uniforms;

fn tangentAt(uv: vec2f) -> vec2f {
  return decodeStructure(textureSampleLevel(tensorTex, linearSampler, uv, 0.0).rgb).tangent;
}

// Walk one direction along the streamline, accumulating weighted response.
//
// The sign flip is the single most common way to get this wrong. The tangent
// field is a direction without an orientation — sampling it can return either
// of two opposite vectors — so without forcing agreement with the previous
// step the walk reverses on itself, re-treads the pixels it came from, and the
// accumulation collapses to a blur of the starting point.
fn walk(startUv: vec2f, startTangent: vec2f, sign: f32, steps: i32, denom: f32) -> vec2f {
  var uv = startUv;
  var direction = startTangent * sign;
  var total = 0.0;
  var weightSum = 0.0;

  for (var s = 1; s <= MAX_STEPS; s++) {
    if (s > steps) { break; }

    uv += direction * u.texelSize;

    let distance = f32(s);
    let weight = exp(-(distance * distance) / denom);
    total += weight * textureSampleLevel(responseTex, linearSampler, uv, 0.0).r;
    weightSum += weight;

    var next = tangentAt(uv);
    if (dot(next, direction) < 0.0) { next = -next; }
    // Bilinear interpolation of unit vectors does not preserve length, so the
    // step size would drift without renormalising.
    let length = length(next);
    if (length < 1e-6) { break; }
    direction = next / length;
  }

  return vec2f(total, weightSum);
}

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sigma = max(u.sigma, 0.1);
  let steps = min(i32(ceil(2.0 * sigma)), MAX_STEPS);
  let denom = 2.0 * sigma * sigma;

  let centre = textureSampleLevel(responseTex, linearSampler, uv, 0.0).r;
  let tangent = tangentAt(uv);

  let forward = walk(uv, tangent, 1.0, steps, denom);
  let backward = walk(uv, tangent, -1.0, steps, denom);

  let total = centre + forward.x + backward.x;
  let weightSum = 1.0 + forward.y + backward.y;

  return vec4f(total / weightSum, 0.0, 0.0, 1.0);
}
