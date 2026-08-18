// Separable bilateral flatten: one axis per pass, run a few times.
//
// The alternative in this codebase is the comic style's anisotropic Kuwahara,
// which is O(radius squared) per pixel and measures 120 ms on a chain where
// everything else together costs single digits. This is O(radius), and two
// passes of it plus an iteration is a fraction of that - which is the whole
// reason a style built on it can run on every frame of a video rather than on
// every frame the machine can spare.
//
// Separable is an approximation: a true bilateral is not separable, because the
// range weight depends on the centre pixel and a second pass sees an already
// filtered one. Iterating is what makes that acceptable, and it is also what
// makes the result FLAT rather than merely smooth - each pass pulls a region
// closer to its own mean, so three passes converge toward piecewise-constant
// where a single wide pass would only blur. (Winnemoller, Olsen & Gooch 2006
// does the same thing for the same reason.)
//
// THE AVERAGE IS TAKEN IN LINEAR LIGHT, which is the only place averaging is
// correct. The RANGE WEIGHT is taken on the square root of the same values -
// gamma 2.0 as a one-instruction stand-in for a perceptual space. That is not a
// colour conversion but a decision about which differences count as an edge: in
// linear light a step across a shadow is numerically tiny and a step across a
// highlight is enormous, so a single range sigma would smear every shadow flat
// while preserving noise in the sky.

const MAX_TAPS: i32 = 16;

struct Uniforms {
  // One texel along the axis this pass filters.
  step: vec2f,
  // In texels of this buffer, which is derived to hold it near a constant
  // fraction of the image.
  sigmaSpatial: f32,
  // In square-root-of-linear units: how different two colours must be to count
  // as separate regions.
  sigmaRange: f32,
}

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let centre = textureSampleLevel(sourceTex, linearSampler, uv, 0.0).rgb;
  let centreKey = sqrt(max(centre, vec3f(0.0)));

  let taps = min(i32(ceil(2.0 * u.sigmaSpatial)), MAX_TAPS);
  let spatialScale = -0.5 / max(u.sigmaSpatial * u.sigmaSpatial, 1e-4);
  let rangeScale = -0.5 / max(u.sigmaRange * u.sigmaRange, 1e-6);

  var total = centre;
  var weight = 1.0;

  for (var i = 1; i <= MAX_TAPS; i++) {
    if (i > taps) { break; }

    let offset = f32(i) * u.step;
    let spatial = exp(spatialScale * f32(i * i));

    // Both directions from one loop iteration: the spatial weight is the same
    // and only the range weight differs, so this halves the exp() count.
    let forward = textureSampleLevel(sourceTex, linearSampler, uv + offset, 0.0).rgb;
    let backward = textureSampleLevel(sourceTex, linearSampler, uv - offset, 0.0).rgb;

    let forwardDelta = sqrt(max(forward, vec3f(0.0))) - centreKey;
    let backwardDelta = sqrt(max(backward, vec3f(0.0))) - centreKey;

    let forwardWeight = spatial * exp(rangeScale * dot(forwardDelta, forwardDelta));
    let backwardWeight = spatial * exp(rangeScale * dot(backwardDelta, backwardDelta));

    total += forwardWeight * forward + backwardWeight * backward;
    weight += forwardWeight + backwardWeight;
  }

  return vec4f(total / weight, 1.0);
}
