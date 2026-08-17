// Oklab lightness of the flattened layer, resampled to the ink resolution.
//
// The ink stages work on lightness alone. Taking it in Oklab rather than as a
// linear-light luma means the difference-of-Gaussians measures perceptual
// steps, so contours in shadow are found with the same sensitivity as contours
// in highlight instead of being crushed toward zero.

@group(0) @binding(0) var flatTex: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let colour = textureSampleLevel(flatTex, linearSampler, uv, 0.0).rgb;
  return vec4f(linearToOklab(colour).x, 0.0, 0.0, 1.0);
}
