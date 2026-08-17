// Colour separation: one photograph in, four ink densities out.
//
// Runs at tone resolution, which is a few samples per screen cell — everything
// expensive about this style happens here, on a buffer measured in hundreds of
// pixels, and the pass that follows only decides where to put dots.
//
// SEPARATION IS DONE IN ENCODED LIGHT, and that is not a lapse. The chain
// upstream works in linear light because averaging and filtering are only
// correct there, and the downsample that feeds this pass averaged in linear for
// exactly that reason. But ink density is a perceptual quantity: a mid grey is
// sRGB 0.5 and linear 0.21, so separating from linear values would lay down 79%
// ink where a press lays 50% and every photograph would print as a silhouette.
// So: average in linear, encode, then separate — the same order the frame
// tensor uses to feed the segmentation model, and for the same reason.

struct Uniforms {
  // 0 = a single black ink, 1 = four-colour.
  colour: f32,
  blackPoint: f32,
  gain: f32,
  _pad: f32,
}

@group(0) @binding(0) var toneTex: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let linear = clamp(textureSampleLevel(toneTex, linearSampler, uv, 0.0).rgb, vec3f(0.0), vec3f(1.0));
  let encoded = linearToSrgb(linear);

  // Ink is subtractive, so density is what the paper is missing.
  let cmy = vec3f(1.0) - encoded;

  // Grey component replacement: whatever all three chroma inks share is laid
  // down once as black instead. Without it a neutral shadow is printed three
  // times over, which is muddy on a press and muddy here.
  let key = min(cmy.r, min(cmy.g, cmy.b));

  // The single-ink end of the Colour control is not "the same separation with
  // the chroma turned down" — it is a different plate. Luma against the encoded
  // triple, which is the tone a monochrome press reproduces.
  let luma = dot(encoded, REC709);

  let chroma = (cmy - vec3f(key)) * u.colour;
  let black = mix(1.0 - luma, key, u.colour);

  // Strength is spent on contrast in the black plate and on saturation in the
  // chroma ones. A black point applied to the chroma plates would kill them
  // long before it cleaned up a highlight, since their densities are small
  // everywhere but the most saturated regions.
  return vec4f(
    clamp(chroma * u.gain, vec3f(0.0), vec3f(1.0)),
    clamp((black - u.blackPoint) * u.gain, 0.0, 1.0),
  );
}
