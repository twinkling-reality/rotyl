// Brush stamping into the selection coverage mask.
//
// One instanced quad per stroke segment, shaded by a capsule distance field.
// Fixed-function blending does the rest: `max` for painting and `min` for
// erasing, which is what makes overlapping stamps inside a single stroke
// idempotent. Accumulating with additive blending instead would darken every
// place the pointer slowed down or doubled back.
//
// The shader writes ANTIALIASED COVERAGE, not a binary hit. Because the mask is
// never binary, there is no separate feathering stage anywhere in the pipeline
// — and blurring a binary mask to feather it later would be actively wrong: it
// is mean-curvature flow, and it erases thin strokes while preserving their
// area.
//
// Every coordinate here is in IMAGE pixels.

// Only the image dimensions live in a uniform, because only they are constant
// for the lifetime of a document.
//
// Radius, hardness and polarity travel with each instance instead. They vary
// per stroke, and several strokes are stamped into one frame during a replay —
// `queue.writeBuffer` is ordered against submission rather than against the
// encoder, so a uniform rewritten between two recorded draws would silently
// give BOTH draws the second value. Carrying them in the vertex stream removes
// the hazard rather than working around it.
struct Uniforms {
  imageSize: vec2f,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) imagePosition: vec2f,
  @location(1) @interpolate(flat) segment: vec4f,
  // radius, hardness, polarity
  @location(2) @interpolate(flat) brush: vec3f,
}

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) segment: vec4f,
  @location(1) brush: vec4f,
) -> VertexOutput {
  // Quad corners covering the capsule's bounding box, padded by one pixel so
  // the antialias ramp is never clipped by the geometry.
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );
  let corner = corners[vertexIndex];

  let pad = brush.x + 1.0;
  let low = min(segment.xy, segment.zw) - pad;
  let high = max(segment.xy, segment.zw) + pad;
  let imagePosition = low + corner * (high - low);

  var out: VertexOutput;
  let uv = imagePosition / u.imageSize;
  out.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.imagePosition = imagePosition;
  out.segment = segment;
  out.brush = brush.xyz;
  return out;
}

fn distanceToSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let lengthSquared = dot(ba, ba);
  // A stroke of one sample is a point, not a segment; guard the divide.
  if (lengthSquared < 1e-8) {
    return length(pa);
  }
  let h = clamp(dot(pa, ba) / lengthSquared, 0.0, 1.0);
  return length(pa - ba * h);
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4f {
  let radius = in.brush.x;
  let hardness = in.brush.y;
  let polarity = in.brush.z;

  let distance = distanceToSegment(in.imagePosition, in.segment.xy, in.segment.zw);

  // The falloff band is at least one pixel wide so that even a fully hard
  // brush gets an antialiased edge rather than a staircase.
  let falloff = mix(radius, 1.0, hardness);
  let coverage = 1.0 - smoothstep(radius - falloff, radius, distance);

  // Painting writes coverage and blends with max; erasing writes the
  // complement and blends with min.
  let value = select(1.0 - coverage, coverage, polarity > 0.0);
  return vec4f(value, 0.0, 0.0, 1.0);
}
