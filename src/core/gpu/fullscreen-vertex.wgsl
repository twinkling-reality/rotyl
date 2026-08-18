// Shared vertex stage for every fullscreen pass.
//
// Three vertices covering the viewport, generated from the vertex index. No
// vertex buffer, no index buffer. The V coordinate is flipped because WebGPU's
// clip space has +Y up while textures are addressed top-down, so without the
// flip every pass would render the image upside down.

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let corner = corners[index];

  var out: VertexOutput;
  out.position = vec4f(corner, 0.0, 1.0);
  out.uv = vec2f((corner.x + 1.0) * 0.5, 1.0 - (corner.y + 1.0) * 0.5);
  return out;
}
