// The picture's own tonal range, reduced to four numbers in one pass.
//
// A palette is a claim about where a picture's lightness lives, and a
// photograph rarely agrees. Measured on the reference scene - hazy traffic,
// which is the case the palette exists for - the picture's lightness has a
// standard deviation of 0.136 while every palette here spans about 0.25. So a
// palette applied literally uses two and a half of its five stops, and the
// result is a picture in one colour rather than in the chosen ones.
//
// This measures the picture so the palette can be fitted to it. One fullscreen
// pass onto a 1x1 target: a single invocation taking a fixed 32x32 grid of
// bilinear taps, which is a thousand samples of an already smoothed buffer and
// costs less than any pass that touches every pixel.
//
// A FIXED GRID IS WHAT MAKES THIS SAFE ON VIDEO. The sample points do not move
// between frames and each tap is a local average, so the statistics change when
// the scene changes and not when the grain does - which is the difference
// between a palette that fits the shot and an auto-exposure that pumps.

const GRID: i32 = 32;

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  var total = 0.0;
  var totalSquared = 0.0;
  var totalChroma = 0.0;

  for (var j = 0; j < GRID; j++) {
    for (var i = 0; i < GRID; i++) {
      let at = (vec2f(f32(i), f32(j)) + 0.5) / f32(GRID);
      let lab = linearToOklab(textureSampleLevel(sourceTex, linearSampler, at, 0.0).rgb);
      total += lab.x;
      totalSquared += lab.x * lab.x;
      totalChroma += length(lab.yz);
    }
  }

  let count = f32(GRID * GRID);
  let mean = total / count;
  // Clamped rather than trusted: the difference of two nearly equal sums is
  // where a variance goes negative, and sqrt of that is a NaN travelling
  // downstream into every pixel.
  let variance = max(totalSquared / count - mean * mean, 0.0);
  return vec4f(mean, sqrt(variance), totalChroma / count, 1.0);
}
