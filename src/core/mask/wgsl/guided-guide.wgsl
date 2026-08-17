// First stage of the refinement: the guide, and the coarse mask, sampled into
// one working buffer.
//
// The guide is Oklab, not linear RGB. The filter downstream decides how much a
// colour difference should move the boundary, and it does so with a single
// regularisation constant; that constant is only meaningful if equal numeric
// differences mean equal perceived differences, which is true in Oklab and
// badly false in linear light, where the whole shadow range is compressed into
// a few hundredths.
//
// The source is box-downsampled rather than bilinearly sampled for the reason
// the style chain downsamples the same way: one bilinear tap reads a 2x2
// neighbourhood, so reducing a 4000 px photograph to a 512 px working buffer
// that way would alias sensor noise into the statistics as false structure,
// and false structure is exactly what the filter would then snap the boundary
// to.

const MAX_TAPS: i32 = 8;

struct Uniforms {
  // Source texels covered by one working texel, per axis.
  footprint: vec2f,
  sourceTexel: vec2f,
}

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var coarseTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
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

  let guide = linearToOklab(total / max(weight, 1.0));
  // The engine mask is far smaller than this buffer, so this tap magnifies. It
  // is the only place the coarse mask is read: everything after this works from
  // the local relationship between the mask and the image, which is what lets
  // the boundary land somewhere the coarse mask never resolved.
  let coarse = textureSampleLevel(coarseTex, linearSampler, uv, 0.0).r;

  return vec4f(guide, coarse);
}
