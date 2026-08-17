// Final stylisation, at output resolution: cel bands plus ink.
//
// Both inputs are magnified here, and that is deliberate rather than a
// compromise. Quantising a soft ramp produces a hard band boundary, and
// thresholding a soft difference-of-Gaussians response produces a hard line —
// so the two cheap low-resolution stages are re-sharpened into crisp output at
// full size by the very operations that define the look.

struct Uniforms {
  bins: f32,
  quantSharpness: f32,
  saturation: f32,
  inkOpacity: f32,
  edgeThreshold: f32,
  edgeSharpness: f32,
  _pad: vec2f,
}

@group(0) @binding(0) var flatTex: texture_2d<f32>;
@group(0) @binding(1) var inkTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let flattened = textureSampleLevel(flatTex, linearSampler, uv, 0.0).rgb;
  var lab = linearToOklab(flattened);

  // Soft quantisation of lightness only (Winnemöller). A hard floor() would
  // band visibly on gradients; the tanh reintroduces a narrow ramp at each
  // step, wide enough to dither the boundary and narrow enough to still read
  // as a discrete cel band.
  let bandWidth = 1.0 / max(u.bins, 1.0);
  let nearestBand = bandWidth * floor(lab.x / bandWidth + 0.5);
  lab.x = nearestBand + (bandWidth * 0.5) * tanh(u.quantSharpness * (lab.x - nearestBand));

  // Chroma boost in Oklab keeps hue fixed while saturation rises, which an
  // equivalent RGB or HSV boost does not.
  lab.y *= u.saturation;
  lab.z *= u.saturation;

  // Clamp AFTER converting back: Oklab describes colours outside sRGB, and a
  // saturation boost routinely lands there. Clamping in Oklab would distort
  // hue rather than merely limiting gamut.
  var colour = clamp(oklabToLinear(lab), vec3f(0.0), vec3f(1.0));

  // Ink multiplies rather than blending toward black, which keeps lines
  // chromatically neutral and lets them darken shadow without turning it flat.
  let response = textureSampleLevel(inkTex, linearSampler, uv, 0.0).r;
  let coverage = inkThreshold(response, u.edgeThreshold, u.edgeSharpness);
  colour *= 1.0 - u.inkOpacity * (1.0 - coverage);

  // Guarantee a finite result. The composite downstream relies on
  // mix(base, styled, 0) returning base exactly, which holds for any finite
  // styled value and fails for NaN — one NaN here would break the product's
  // central promise on every pixel of an unselected region.
  return vec4f(select(vec3f(0.0), colour, colour == colour), 1.0);
}
