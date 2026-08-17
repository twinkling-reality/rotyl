// Box downsample from the source image into a stage buffer.
//
// A single bilinear tap reads at most a 2x2 source neighbourhood, so reducing
// a 4000 px photograph to a 500 px flatten buffer that way would discard 98% of
// the pixels and alias the rest into the Kuwahara stage as false structure.
// This averages a grid across the whole source footprint instead.

const MAX_TAPS: i32 = 8;

struct Uniforms {
  // Source texels covered by one destination texel, per axis.
  footprint: vec2f,
  sourceTexel: vec2f,
}

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Each bilinear tap already averages 2x2, so the grid only needs to cover
  // half the footprint in each axis.
  let taps = clamp(vec2i(ceil(u.footprint * 0.5)), vec2i(1), vec2i(MAX_TAPS));

  var total = vec3f(0.0);
  var weight = 0.0;

  for (var y = 0; y < MAX_TAPS; y++) {
    if (y >= taps.y) { break; }
    for (var x = 0; x < MAX_TAPS; x++) {
      if (x >= taps.x) { break; }

      // Tap centres spread evenly across the footprint, offset by half a step
      // so the pattern is symmetric about the destination texel centre.
      let step = u.footprint / vec2f(taps);
      let offset = (vec2f(f32(x), f32(y)) + 0.5 - vec2f(taps) * 0.5) * step;
      let sample = textureSampleLevel(sourceTex, sourceSampler, uv + offset * u.sourceTexel, 0.0);
      total += sample.rgb;
      weight += 1.0;
    }
  }

  return vec4f(total / max(weight, 1.0), 1.0);
}
