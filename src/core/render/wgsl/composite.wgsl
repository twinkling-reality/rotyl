// The composite: the one pass that reads the selection mask.
//
// EXPORT ENDS HERE. What this pass writes is exactly the exported file, at
// export resolution. The overlay that makes a selection visible is a separate,
// display-only pass, so there is no way for a UI affordance to leak into a
// saved image.
//
// Two properties this pass is responsible for:
//
//   Unselected pixels are untouched. mix(base, styled, 0) returns base bit-for
//   -bit, so a mask value of zero reproduces the source byte exactly — not
//   approximately. This holds for any finite `styled`, which is why the
//   stylisation pass guarantees finiteness rather than assuming it.
//
//   Boundaries have no seam. Every earlier stage ran over the WHOLE image and
//   none of them saw the mask. Masking earlier would be cheaper, but the
//   flatten and ink kernels sample well outside their own pixel, so a pixel
//   just inside the selection would be computed from a neighbourhood that had
//   been zeroed — which draws a visible halo along the selection edge.

struct Uniforms {
  // Style crossfade, folded into the mask: scaling coverage is exactly
  // equivalent to crossfading the styled layer, and costs nothing.
  styleMix: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var styledTex: texture_2d<f32>;
@group(0) @binding(2) var maskTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(sourceTex, linearSampler, uv, 0.0);
  let styled = textureSampleLevel(styledTex, linearSampler, uv, 0.0).rgb;
  let coverage = textureSampleLevel(maskTex, linearSampler, uv, 0.0).r * u.styleMix;

  return vec4f(mix(base.rgb, styled, coverage), base.a);
}
