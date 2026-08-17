// The products the guided filter takes local means of.
//
// Thirteen quantities are needed — three guide channels, the mask, the six
// unique entries of the guide's covariance, and three guide-mask products — so
// they are written across four four-channel targets. The first target is the
// guide buffer itself, which already holds (L, a, b, p); this pass fills the
// other three, selected by `plane`, from a single tap each.
//
// Splitting them across passes rather than across render targets is deliberate:
// four rgba32float attachments are 64 bytes per sample, and
// maxColorAttachmentBytesPerSample is 32 by default, so a multi-target version
// would fail to create a pipeline on conformant hardware.

struct Uniforms {
  // 0 -> (LL, La, Lb, aa), 1 -> (ab, bb, Lp, ap), 2 -> (bp, 0, 0, 0)
  plane: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var guideTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let g = textureLoad(guideTex, vec2i(fragCoord.xy), 0);
  let i = g.xyz;
  let p = g.w;

  if (u.plane < 0.5) {
    return vec4f(i.x * i.x, i.x * i.y, i.x * i.z, i.y * i.y);
  }
  if (u.plane < 1.5) {
    return vec4f(i.y * i.z, i.z * i.z, i.x * p, i.y * p);
  }
  return vec4f(i.z * p, 0.0, 0.0, 0.0);
}
