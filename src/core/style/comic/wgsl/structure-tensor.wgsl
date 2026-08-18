// Structure tensor of the colour image, via Scharr derivatives.
//
// Scharr rather than Sobel because its weights (0.183 / 0.634) are optimised
// for rotational symmetry: a Sobel-derived orientation field visibly favours
// the diagonals, and every downstream stage, the Kuwahara ellipse and the ink
// flow field, is an orientation consumer.
//
// The three products (E, F, G) are written unnormalised. Normalising before
// the smoothing pass would throw away edge magnitude, which is precisely the
// weighting that lets strong contours dominate their neighbourhood.

struct Uniforms {
  texelSize: vec2f,
}

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn tap(uv: vec2f, dx: f32, dy: f32) -> vec3f {
  return textureSampleLevel(sourceTex, sourceSampler, uv + vec2f(dx, dy) * u.texelSize, 0.0).rgb;
}

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = 0.183;
  let m = 1.0 - 2.0 * c;

  let tl = tap(uv, -1.0, -1.0);
  let tc = tap(uv,  0.0, -1.0);
  let tr = tap(uv,  1.0, -1.0);
  let ml = tap(uv, -1.0,  0.0);
  let mr = tap(uv,  1.0,  0.0);
  let bl = tap(uv, -1.0,  1.0);
  let bc = tap(uv,  0.0,  1.0);
  let br = tap(uv,  1.0,  1.0);

  let fx = c * (tr + br) + m * mr - c * (tl + bl) - m * ml;
  let fy = c * (bl + br) + m * bc - c * (tl + tr) - m * tc;

  return vec4f(dot(fx, fx), dot(fx, fy), dot(fy, fy), 1.0);
}
