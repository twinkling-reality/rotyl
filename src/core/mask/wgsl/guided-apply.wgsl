// The last stage: evaluate the local linear model against the image at full
// resolution.
//
// This is where the detail comes from. The model's coefficients were fitted in
// a small working buffer and are smooth by construction, so magnifying them
// costs nothing; the guide they are applied to is the full-resolution image, so
// the boundary lands on the real edge rather than on a magnified approximation
// of where the coarse mask thought it was.
//
// The filter returns a soft matte, and a soft matte magnified sixteen times
// reads as a blurred selection. The final smoothstep narrows the transition
// without making it binary: where the guide has a strong edge the matte crosses
// the band within a pixel or two and the result is antialiased, and where the
// guide is smooth the edge stays soft, which is what an out-of-focus boundary
// should look like.

struct Uniforms {
  firmness: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var coefficientTex: texture_2d<f32>;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let model = textureSampleLevel(coefficientTex, linearSampler, uv, 0.0);
  // A single bilinear tap. This pass runs at output resolution, which is the
  // source's own resolution except for images past the preview cap, so there is
  // nothing here to alias except in that one case, and paying for a box
  // downsample of a 24 megapixel image to avoid it would cost more than the
  // artefact does.
  let guide = linearToOklab(textureSampleLevel(sourceTex, linearSampler, uv, 0.0).rgb);

  let matte = dot(model.xyz, guide) + model.w;
  return vec4f(smoothstep(0.5 - u.firmness, 0.5 + u.firmness, matte), 0.0, 0.0, 1.0);
}
