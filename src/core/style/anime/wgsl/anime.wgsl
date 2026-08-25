// Final character treatment, at output resolution.
//
// The flatten and the ink arrive magnified. Quantising a soft ramp produces a
// hard cel band, and thresholding a soft difference-of-Gaussians produces a
// hard line, so the two cheap stages are re-sharpened here by the operations
// that define the look.
//
// HUE IS NOT REPLACED. A palette that maps lightness onto chosen colours is
// the right tool for a street that has no hue worth keeping. A person is the
// opposite case: identity lives in the hue of skin, hair and clothing, and
// replacing it is how a portrait becomes a costume. This pass reshapes
// lightness into cel bands, keys the lighting (warm highlight, cool shadow),
// lifts clothing chroma, holds skin chroma, and adds a hair-sheet specular.
// The photograph's a and b are the ones that leave.

struct Uniforms {
  bins: f32,
  quantSharpness: f32,
  colour: f32,
  inkOpacity: f32,
  edgeThreshold: f32,
  edgeSharpness: f32,
  splitTone: f32,
  chromaLift: f32,
  skinHold: f32,
  specular: f32,
  _pad0: vec2f,
}

@group(0) @binding(0) var flatTex: texture_2d<f32>;
@group(0) @binding(1) var inkTex: texture_2d<f32>;
@group(0) @binding(2) var levelsTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<uniform> u: Uniforms;

fn softBand(lightness: f32, bins: f32, sharpness: f32) -> f32 {
  let width = 1.0 / max(bins, 1.0);
  let nearest = width * floor(lightness / width + 0.5);
  return nearest + (width * 0.5) * tanh(sharpness * (lightness - nearest));
}

// Skin-like: warm a, warm-to-neutral b, chroma in a living range, not a wall
// and not a saturated jacket. Soft on purpose: a hard class on hue is how
// darker skin and flushed cheeks fall out of the treatment.
fn skinWeight(lab: vec3f) -> f32 {
  let chroma = length(lab.yz);
  let hueOk = smoothstep(-0.02, 0.02, lab.y) * (1.0 - smoothstep(0.14, 0.2, abs(lab.z - 0.04)));
  let chromaOk = smoothstep(0.02, 0.05, chroma) * (1.0 - smoothstep(0.13, 0.18, chroma));
  let lightOk = smoothstep(0.18, 0.32, lab.x) * (1.0 - smoothstep(0.88, 0.96, lab.x));
  return clamp(hueOk * chromaOk * lightOk, 0.0, 1.0);
}

// Hair-like: darker, higher chroma than skin, or a deep neutral. Used only
// to place a specular sheet, never to recolour.
fn hairWeight(lab: vec3f) -> f32 {
  let chroma = length(lab.yz);
  let dark = 1.0 - smoothstep(0.42, 0.62, lab.x);
  let rich = smoothstep(0.04, 0.1, chroma);
  return clamp(dark * max(rich, 0.35 * (1.0 - smoothstep(0.55, 0.75, lab.x))), 0.0, 1.0);
}

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let flattened = textureSampleLevel(flatTex, linearSampler, uv, 0.0).rgb;
  var lab = linearToOklab(flattened);
  let picture = textureSampleLevel(levelsTex, linearSampler, vec2f(0.5), 0.0).rgb;
  let meanL = max(picture.x, 0.001);
  let spreadL = max(picture.y, 0.04);
  let meanC = max(picture.z, 0.001);

  let skin = skinWeight(lab);
  let hair = hairWeight(lab) * (1.0 - skin);
  let cloth = (1.0 - skin) * (1.0 - 0.65 * hair);

  // Region-aware bins: skin wants three shades, clothing can carry more
  // folds, hair wants a highlight band on top of a dark mass.
  let bins = mix(u.bins + 1.4 * cloth, max(3.0, u.bins - 0.8), skin);
  var lightness = softBand(lab.x, bins, u.quantSharpness);

  // Key the lighting the way a cel sheet does: a little warmth into the
  // lights, a little cool into the shadows. Applied in a/b so hue identity
  // survives and only the key changes.
  let key = clamp((lab.x - meanL) / spreadL, -1.5, 1.5);
  let warm = vec2f(0.018, 0.028);
  let cool = vec2f(-0.01, -0.034);
  let tone = mix(cool, warm, smoothstep(-0.6, 0.8, key));
  lab.y += u.splitTone * tone.x * u.colour;
  lab.z += u.splitTone * tone.y * u.colour;

  // Hold skin chroma (illustration of a person, not a painted mask) and lift
  // clothing and hair so they read as chosen rather than photographed.
  let chroma = length(lab.yz);
  let chromaTarget = mix(
    chroma * (1.0 - u.skinHold * 0.35),
    min(chroma * (1.0 + u.chromaLift) + 0.012 * u.chromaLift, meanC * 2.4),
    cloth,
  );
  let chromaScale = select(chromaTarget / max(chroma, 1.0e-4), 1.0, chroma < 1.0e-4);
  lab.y *= mix(1.0, chromaScale, u.colour);
  lab.z *= mix(1.0, chromaScale, u.colour);
  lab.x = mix(lab.x, lightness, 0.92);

  // One hard specular sheet on dark hair, keyed from the picture's own
  // highlight rather than from a fixed threshold, so it tracks the lighting
  // of the shot instead of drawing a white stripe on every brunette.
  let specBand = smoothstep(meanL + 0.35 * spreadL, meanL + 1.15 * spreadL, lab.x);
  lab.x = mix(lab.x, min(lab.x + 0.16 * specBand, 0.92), hair * u.specular);

  var colour = clamp(oklabToLinear(lab), vec3f(0.0), vec3f(1.0));

  let response = textureSampleLevel(inkTex, linearSampler, uv, 0.0).r;
  let coverage = inkThreshold(response, u.edgeThreshold, u.edgeSharpness);
  // Slightly heavier line on the silhouette-like high-response ink, lighter
  // inside a face so eyes and mouth stay features rather than stamps.
  let interior = smoothstep(0.02, 0.16, response);
  let ink = u.inkOpacity * mix(0.72, 1.0, 1.0 - interior * 0.45);
  colour *= 1.0 - ink * (1.0 - coverage);

  return vec4f(select(vec3f(0.0), colour, colour == colour), 1.0);
}
