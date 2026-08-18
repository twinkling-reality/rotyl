// The poster pass: flat colour, chosen or kept, and a line where two regions
// meet. At output resolution, and the only pass of this style that is.
//
// Everything before this ran on a buffer a few hundred pixels across. This is
// where that becomes a picture, and it is the same argument the comic style's
// cel step and the print style's screen both make: read the photograph cheaply
// and small, make the hard decision that defines the look at full size. A
// quantisation of a magnified ramp is a crisp band; a magnified quantisation is
// a staircase.
//
// THE OUTLINE IS A REGION BOUNDARY, NOT AN EDGE DETECTION, and what makes it
// one is WHICH PICTURE IT READS. It measures the flattened picture, which is
// the bilateral's own piecewise-constant answer, so what it can respond to is
// contrast between areas: smog, sensor grain and the inside of foliage are what
// the flatten took out on the way here. A difference of Gaussians reads the
// photograph and has no such opinion. It answers to contrast wherever it finds
// it, so it inks all three, and the threshold that stops it doing that also
// stops it drawing the faint boundary that matters. Four taps on top of the one
// this pass already reads, and one threshold whose units are "how different do
// two areas have to be".
//
// UNTIL THIS CHAPTER IT COMPARED THE QUANTISED COLOUR ON BOTH SIDES, and that
// was wrong in a way only a photograph could show. round() flips a whole band
// on an infinitesimal change, so the comparison moved by a fifth of the Oklab
// range where the picture had moved by a thousandth of one, and a stroke
// appeared at full weight between one frame and the next. A drawn scene of
// large flat regions has almost no pixel near a band edge, so it never showed
// there. A brick wall is nothing but marginal boundaries: a perturbation whose
// 99th percentile was six codes came out of the chain at seventy-eight. It
// comes out at fifteen now, against eight for the same picture with the outline
// switched off altogether.
//
// The quantiser was not carrying the drawing anyway. Two sides in different
// bands returned a whole band however far apart the picture had them, so a
// boundary of a hundredth and a boundary of a fifth were both inked at full
// weight, and which pixels along a faint boundary landed in different bands was
// decided by where the band grid happened to fall. A faint line was already
// being drawn at a strength that followed its contrast, as a dotted line rather
// than as a fainter one. This draws the fainter one, and being continuous in
// the input is then a property of the operator rather than a floor bolted under
// a transition.
//
// What a person can see is that a contour where the quantiser changes its mind
// on a nearly flat field no longer gets a line. That contour is the banding
// artefact rather than a boundary between two things: where it falls is decided
// by the grid rather than by the picture, noise moves it freely, and anything
// that inks it boils by construction.

/** Least width of a band transition, as a fraction of one band. */
const MIN_BAND_SOFTNESS: f32 = 0.12;
/** Least width of a palette boundary, in Oklab distance. */
const MIN_MARGIN_SOFTNESS: f32 = 0.02;
/**
 * Where the outline's ramp leaves the ground, as a fraction of its threshold.
 *
 * A ramp that reaches zero only at zero contrast puts a faint stroke across
 * every gradient, and this style's claim is that a gradient comes out as areas.
 * A quarter is what keeps a flat area measurably flat: the fixture in
 * test/poster-stylisation.test.ts asks for three quarters of neighbouring
 * pixels to be within one code of each other, and a ramp from zero misses it.
 */
const FAINT_FRACTION: f32 = 0.25;

struct Uniforms {
  // xy: one output texel. zw: the line's half width, in uv - a fraction of the
  // image, so a line is the same weight in a preview and in an export.
  texel: vec4f,
  levels: f32,
  chromaStep: f32,
  saturation: f32,
  paletteAmount: f32,
  lineWeight: f32,
  lineThreshold: f32,
  // The palette block starts on its own 16-byte boundary, which is what a vec4f
  // is aligned to and what this pair of floats is here to reach.
  _pad: vec2f,
  /** The palette's own lightness, mean then spread, and its own mean chroma. */
  paletteFit: vec4f,
  /** Five Oklab stops, dark to light, in xyz. */
  palette: array<vec4f, PALETTE_STOPS>,
}

@group(0) @binding(0) var flatTex: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;
/** 1x1: the picture's mean lightness, its spread, and its mean chroma. */
@group(0) @binding(3) var levelsTex: texture_2d<f32>;

/** The picture at a point, in Oklab, with this style's saturation applied. */
fn labAt(uv: vec2f) -> vec3f {
  let lab = linearToOklab(textureSampleLevel(flatTex, linearSampler, uv, 0.0).rgb);
  return vec3f(lab.x, lab.yz * u.saturation);
}

/**
 * The same colour, moved into the palette's range.
 *
 * The palette is matched against this rather than against the picture's own
 * coordinates, so a hazy frame reaches every stop instead of two. The picture
 * is still drawn in its own colours wherever the palette is not applied.
 */
fn fitted(lab: vec3f, picture: vec3f) -> vec3f {
  return vec3f(
    fitLightness(lab.x, picture.xy, u.paletteFit.xy),
    fitChroma(lab.yz, picture.z, u.paletteFit.z),
  );
}

/**
 * The colour of the area a point belongs to, in the space the areas are judged
 * in: the flattened picture, moved as far toward the palette's range as the
 * palette is applied, so a threshold means the same thing either way.
 *
 * NOT QUANTISED, which is the whole of the outline's fix and is argued at the
 * top of this file. The flatten is what decided where one area stops and the
 * next begins; the quantiser only rounds what it decided, and rounding a
 * boundary is what made the line flicker.
 */
fn areaAt(uv: vec2f, picture: vec3f) -> vec3f {
  let lab = labAt(uv);
  return mix(lab, fitted(lab, picture), u.paletteAmount);
}

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let lab = labAt(uv);
  let picture = textureSampleLevel(levelsTex, linearSampler, vec2f(0.5), 0.0).rgb;

  // DERIVATIVES FIRST, and in uniform control flow. Both of the decisions below
  // are discontinuous, and a discontinuity is only a clean edge if it is
  // resolved against how fast the field is moving under this pixel.
  let lightnessSlope = fwidth(lab.x);

  // The lightness bands, with the boundary softened. This is exactly round(),
  // written so that the step can be resolved: the transition sits at the
  // half-way point, which is where round() changes its mind.
  //
  // THE FLOOR UNDER THE TRANSITION WIDTH IS WHAT STOPS THIS BOILING ON VIDEO,
  // and it was put here by a measurement rather than by taste. Softening across
  // one pixel is correct for an edge and useless for a gradient: where the
  // field is nearly flat, fwidth is nearly zero, so a band boundary is a step
  // of a whole level driven by a hundredth of one - and a frame of sensor
  // grain moves it. Measured on a fixed camera, that put 1.7% of pixels more
  // than 8 codes apart between consecutive frames, against 0.1% for the comic
  // style, whose cel step has always had a fixed soft ramp. The floor caps the
  // gain from input to output at about four, and it costs nothing visible: it
  // only widens the transition where the picture has no edge to sharpen.
  let scaled = lab.x * u.levels;
  let band = floor(scaled);
  let halfWidth = clamp(max(0.5 * lightnessSlope * u.levels, MIN_BAND_SOFTNESS), 1e-4, 0.49);
  let banded = (band + smoothstep(0.5 - halfWidth, 0.5 + halfWidth, scaled - band)) / max(u.levels, 1.0);

  // Chroma takes exactly the same treatment. Left hard it was the larger half
  // of the flicker: colour steps are as discontinuous as lightness ones and
  // there are more of them, because chroma is small everywhere in a hazy
  // picture and its steps are correspondingly close together.
  let chroma = length(lab.yz);
  let chromaBands = chroma / u.chromaStep;
  let chromaBand = floor(chromaBands);
  let chromaWidth = clamp(max(0.5 * fwidth(chroma) / u.chromaStep, MIN_BAND_SOFTNESS), 1e-4, 0.49);
  let steppedChroma =
    (chromaBand + smoothstep(0.5 - chromaWidth, 0.5 + chromaWidth, chromaBands - chromaBand))
    * u.chromaStep;
  let ownBanded = vec3f(banded, lab.yz * (steppedChroma / max(chroma, 1e-5)));

  // The palette, with its assignment boundary softened the same way. The margin
  // goes to zero exactly where two stops are equally near, which is where the
  // boundary is.
  let matched = paletteSnap(u.palette, fitted(lab, picture));
  // Floored for the same reason, in the same units the margin is measured in:
  // two stops of a palette are about 0.2 apart in Oklab, so a boundary that
  // resolves over 0.02 of that is sharp to look at and cannot jump a whole
  // stop when a pixel moves by a thousandth.
  let marginSlope = max(fwidth(matched.margin), MIN_MARGIN_SOFTNESS);
  let decided = clamp(0.5 + matched.margin / (2.0 * marginSlope), 0.5, 1.0);
  let snapped = mix(matched.next, matched.nearest, decided);

  let flat = mix(ownBanded, snapped, u.paletteAmount);

  // The line: how far this pixel's area colour is from the area colour a line
  // width away, in any of four directions.
  // The centre needs no tap of its own: this pass has already read it.
  let area = mix(lab, fitted(lab, picture), u.paletteAmount);
  var apart = 0.0;
  apart = max(apart, distance(area, areaAt(uv + vec2f(u.texel.z, 0.0), picture)));
  apart = max(apart, distance(area, areaAt(uv - vec2f(u.texel.z, 0.0), picture)));
  apart = max(apart, distance(area, areaAt(uv + vec2f(0.0, u.texel.w), picture)));
  apart = max(apart, distance(area, areaAt(uv - vec2f(0.0, u.texel.w), picture)));
  // A RAMP UP TO THE THRESHOLD RATHER THAN A DECISION TAKEN AT IT. The
  // threshold keeps its units and becomes where a stroke reaches FULL weight; a
  // quarter of it is where a stroke starts; in between, the weight is the
  // contrast. Straight rather than smoothed, because for a given reach a
  // straight ramp has the gentlest slope available, and the slope is what
  // decides how far a frame of grain can move an outline.
  let faint = FAINT_FRACTION * u.lineThreshold;
  let line = u.lineWeight * saturate((apart - faint) / max(u.lineThreshold - faint, 1e-4));

  // The line takes the palette's darkest stop rather than black, so a picture
  // in petrol and aqua is drawn in petrol. With no palette that stop is black
  // and the amount is zero, so it is black.
  let ink = mix(vec3f(0.0), u.palette[0].xyz, u.paletteAmount);

  // Clamp AFTER leaving Oklab: the space describes colours outside sRGB, a
  // saturation boost routinely lands there, and clamping in Oklab distorts hue
  // rather than merely limiting gamut.
  let colour = clamp(oklabToLinear(mix(flat, ink, line)), vec3f(0.0), vec3f(1.0));

  // The composite relies on mix(base, styled, 0) returning base exactly, which
  // holds for any finite value and fails for NaN.
  return vec4f(select(vec3f(0.0), colour, colour == colour), 1.0);
}
