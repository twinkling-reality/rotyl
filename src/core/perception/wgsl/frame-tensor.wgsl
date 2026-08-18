// The image, as a segmentation model wants to receive it.
//
// Three things have to be right here, and each is silent when it is wrong.
//
//   COLOUR SPACE. The model was trained on ordinary image files, so it expects
//   sRGB-encoded values. The source is sampled through an sRGB view, which
//   means every value reaching this shader is linear, correct for averaging,
//   and wrong for the model, so it is re-encoded after the average and before
//   the normalisation. Averaging in the encoded space instead would darken
//   every downsampled edge, which is the classic image-resize bug.
//
//   ASPECT. The model resizes to a square and does not preserve aspect. That
//   looks like a bug and is not: it is what the processor the weights were
//   trained with does, and matching it is what makes the mask land where the
//   model thinks it does. A letterboxed input would put every boundary in the
//   wrong place by the size of the bars.
//
//   LAYOUT. The tensor is planar, one channel after another, so the three
//   channels are written to three single-channel targets and copied into one
//   buffer at three offsets. A single interleaved target would need a transpose
//   afterwards over twelve megabytes.

const MAX_TAPS: i32 = 8;

struct Uniforms {
  // Source texels covered by one model texel, per axis.
  footprint: vec2f,
  sourceTexel: vec2f,
  mean: vec3f,
  _pad0: f32,
  inverseStd: vec3f,
  _pad1: f32,
}

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct Planes {
  @location(0) red: vec4f,
  @location(1) green: vec4f,
  @location(2) blue: vec4f,
}

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> Planes {
  let taps = clamp(vec2i(ceil(u.footprint * 0.5)), vec2i(1), vec2i(MAX_TAPS));
  let stride = u.footprint / vec2f(taps);

  var total = vec3f(0.0);
  var weight = 0.0;

  for (var y = 0; y < MAX_TAPS; y++) {
    if (y >= taps.y) { break; }
    for (var x = 0; x < MAX_TAPS; x++) {
      if (x >= taps.x) { break; }

      let offset = (vec2f(f32(x), f32(y)) + 0.5 - vec2f(taps) * 0.5) * stride;
      total += textureSampleLevel(sourceTex, linearSampler, uv + offset * u.sourceTexel, 0.0).rgb;
      weight += 1.0;
    }
  }

  let encoded = linearToSrgb(total / max(weight, 1.0));
  let normalised = (encoded - u.mean) * u.inverseStd;

  var out: Planes;
  out.red = vec4f(normalised.r, 0.0, 0.0, 1.0);
  out.green = vec4f(normalised.g, 0.0, 0.0, 1.0);
  out.blue = vec4f(normalised.b, 0.0, 0.0, 1.0);
  return out;
}
