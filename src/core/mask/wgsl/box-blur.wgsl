// Separable box mean, one axis per invocation.
//
// A box rather than a Gaussian because the guided filter is defined over square
// windows: the local linear model is fitted to every pixel in the window with
// equal weight, and the algebra that makes the two blur passes equivalent to
// one 2D window only holds for a uniform kernel.
//
// textureLoad rather than a sampler, for two reasons that are really one: the
// statistics are carried in rgba32float, which is unfilterable, and the taps
// are exactly on texel centres anyway, so a filtered fetch would be paying for
// an interpolation that always lands on a single texel. Out-of-range loads
// return zero in WGSL, which would darken every border, so coordinates are
// clamped to replicate the edge instead.

const MAX_RADIUS: i32 = 24;

struct Uniforms {
  // (1, 0) or (0, 1).
  direction: vec2f,
  radius: f32,
  _pad: f32,
}

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(sourceTex));
  let centre = vec2i(fragCoord.xy);
  let step = vec2i(u.direction);
  let radius = clamp(i32(u.radius + 0.5), 0, MAX_RADIUS);

  var total = vec4f(0.0);
  var count = 0.0;

  for (var i = -MAX_RADIUS; i <= MAX_RADIUS; i++) {
    if (i < -radius) { continue; }
    if (i > radius) { break; }

    let coord = clamp(centre + step * i, vec2i(0), size - vec2i(1));
    total += textureLoad(sourceTex, coord, 0);
    count += 1.0;
  }

  return total / count;
}
