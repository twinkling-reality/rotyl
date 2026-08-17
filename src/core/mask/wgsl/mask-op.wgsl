// Whole-mask operations: invert, and applying a mask that came from somewhere
// other than the brush.
//
// The `source` texture is bound for the apply operations and ignored by invert;
// binding it unconditionally keeps one pipeline layout for both.

struct Uniforms {
  // 0 invert, 1 replace, 2 add, 3 subtract
  operation: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var currentTex: texture_2d<f32>;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let current = textureSampleLevel(currentTex, linearSampler, uv, 0.0).r;
  let incoming = textureSampleLevel(sourceTex, linearSampler, uv, 0.0).r;

  var result = current;
  if (u.operation < 0.5) {
    result = 1.0 - current;
  } else if (u.operation < 1.5) {
    result = incoming;
  } else if (u.operation < 2.5) {
    result = max(current, incoming);
  } else {
    result = min(current, 1.0 - incoming);
  }

  return vec4f(result, 0.0, 0.0, 1.0);
}
