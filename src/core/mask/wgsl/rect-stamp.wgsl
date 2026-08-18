// A rectangle stamped into the selection coverage mask.
//
// The same instance stream, the same blending and the same one-pixel antialias
// ramp as the brush; only the distance function differs, which is why this
// shares the brush's uniform, its vertex layout and its two pipelines rather
// than bringing its own.
//
// A rectangle is not what the Box tool draws. That one is a QUESTION — the
// region a segmentation model should look for an object inside — and it answers
// with the object, not with the region. This is the region itself, which is the
// shape a panel of stylisation over a scene actually wants.
//
// Every coordinate here is in IMAGE pixels.

struct Uniforms {
  imageSize: vec2f,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) imagePosition: vec2f,
  @location(1) @interpolate(flat) rect: vec4f,
  @location(2) @interpolate(flat) polarity: f32,
}

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) rect: vec4f,
  @location(1) options: vec4f,
) -> VertexOutput {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );
  let corner = corners[vertexIndex];

  // Padded by one pixel so the antialias ramp is never clipped by the geometry,
  // and normalised here so a rectangle dragged upward or leftward is the same
  // rectangle. Nothing downstream is asked to know that.
  let low = min(rect.xy, rect.zw) - 1.0;
  let high = max(rect.xy, rect.zw) + 1.0;
  let imagePosition = low + corner * (high - low);

  var out: VertexOutput;
  let uv = imagePosition / u.imageSize;
  out.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.imagePosition = imagePosition;
  out.rect = rect;
  out.polarity = options.z;
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4f {
  let low = min(in.rect.xy, in.rect.zw);
  let high = max(in.rect.xy, in.rect.zw);

  // Signed distance to the rectangle, negative inside. The two terms are the
  // outside and inside cases; exactly one of them is non-zero.
  let d = max(low - in.imagePosition, in.imagePosition - high);
  let distance = length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);

  // Half a pixel either side of the edge, so a rectangle whose edge falls
  // between two texels gets a ramp rather than a staircase. The brush earns its
  // edge the same way.
  let coverage = 1.0 - smoothstep(-0.5, 0.5, distance);

  // Painting writes coverage and blends with max; erasing writes the complement
  // and blends with min.
  let value = select(1.0 - coverage, coverage, in.polarity > 0.0);
  return vec4f(value, 0.0, 0.0, 1.0);
}
