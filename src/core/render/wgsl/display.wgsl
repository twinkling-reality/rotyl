// Display pass: maps the composited image onto the canvas through the view
// transform, and draws the selection overlay.
//
// This pass exists only on screen. It runs after the composite, reads the
// composite's already-encoded output as raw sRGB bytes, and writes to the
// canvas without re-encoding, so the overlay constants below are tuned in the
// same space they are applied in, and none of this can reach an exported file.
//
// Separating it also means panning and zooming re-run one cheap pass rather
// than the whole style chain.

struct Uniforms {
  // imageUv = canvasUv * uvScale + uvOffset
  uvScale: vec2f,
  uvOffset: vec2f,
  background: vec3f,
  liftOpacity: f32,
  contourOpacity: f32,
  casingRadius: f32,
  coreRadius: f32,
  _pad: f32,
}

@group(0) @binding(0) var compositeTex: texture_2d<f32>;
@group(0) @binding(1) var maskTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> u: Uniforms;

// Morphological gradient of the mask: zero in flat regions, rising toward 1 at
// a coverage boundary. Folded in here rather than run as its own pass.
//
// `fwidth` makes the radius screen-space, so the contour keeps a constant
// on-screen weight at every zoom level with nothing recomputed on the CPU.
// Sampling an r8unorm mask with linear filtering makes the result naturally
// antialiased, which is why no multisampling or distance field is involved.
fn contour(uv: vec2f, texelStep: vec2f, radius: f32) -> f32 {
  let step = texelStep * radius;
  let k = 0.70710678;
  var offsets = array<vec2f, 8>(
    vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0),
    vec2f(k, k), vec2f(-k, k), vec2f(k, -k), vec2f(-k, -k),
  );

  let centre = textureSampleLevel(maskTex, linearSampler, uv, 0.0).r;
  var lowest = centre;
  var highest = centre;
  for (var i = 0; i < 8; i++) {
    let sample = textureSampleLevel(maskTex, linearSampler, uv + offsets[i] * step, 0.0).r;
    lowest = min(lowest, sample);
    highest = max(highest, sample);
  }
  return highest - lowest;
}

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let imageUv = uv * u.uvScale + u.uvOffset;

  // Taken before the bounds test below: fwidth is a quad-level derivative and
  // may only be called under uniform control flow, so it cannot appear after a
  // branch that some invocations in the quad take and others do not.
  let texelStep = fwidth(imageUv);

  if (imageUv.x < 0.0 || imageUv.x > 1.0 || imageUv.y < 0.0 || imageUv.y > 1.0) {
    return vec4f(u.background, 1.0);
  }

  var rgb = textureSampleLevel(compositeTex, linearSampler, imageUv, 0.0).rgb;
  let coverage = textureSampleLevel(maskTex, linearSampler, imageUv, 0.0).r;

  // Lift the UNSELECTED region toward paper rather than dimming it. On a light
  // theme this reads as "not yet part of the drawing", and unlike dimming it
  // stays legible over black imagery.
  let luma = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let lifted = mix(rgb, mix(vec3f(luma), vec3f(0.976), 0.78), 0.45 * u.liftOpacity);
  rgb = mix(lifted, rgb, coverage);

  // Two-tone hairline: a white casing with a darker core on top. Carrying its
  // own contrast is what lets one treatment stay visible over black, white,
  // mid-grey and noise alike. Any single-colour contour disappears against
  // image content of that colour.
  if (u.contourOpacity > 0.0) {
    rgb = mix(rgb, vec3f(1.0), contour(imageUv, texelStep, u.casingRadius) * 0.85 * u.contourOpacity);
    rgb = mix(rgb, vec3f(0.07), contour(imageUv, texelStep, u.coreRadius) * u.contourOpacity);
  }

  return vec4f(rgb, 1.0);
}
