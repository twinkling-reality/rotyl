// The screen: four ink densities in, a printed sheet out, at output resolution.
//
// The dots are computed analytically rather than magnified from a buffer, which
// is what keeps them crisp at export size from a tone field a few hundred
// pixels across. It is the same argument the comic style's threshold makes: do
// the expensive reading of the photograph cheaply and small, and make the hard
// decision that defines the look at full size.

const TAU = 6.2831853;

// The spot function below reaches exactly 0 and exactly 1, at isolated points.
// Thresholding a density of 1 against it therefore leaves those points at half
// coverage, and a density of 0 tips them to half coverage the other way, so a
// solid black sparkles with paper and clean paper freckles with ink. Pushing
// the threshold this far past both ends closes the last dot and opens the
// first, at a cost of two percent of the tonal range that nothing can resolve.
const SOLID_MARGIN = 0.02;

struct Ink {
  // cos and sin of the screen angle, then this plate's registration error in uv.
  screen: vec4f,
  // Linear-light colour where the plate covers fully.
  colour: vec4f,
}

struct Uniforms {
  // Screen cells across the image, per axis. Carries the aspect ratio, so a
  // cell is square in IMAGE space and a dot is round on a panorama too.
  cells: vec2f,
  _pad: vec2f,
  paper: vec4f,
  inks: array<Ink, 4>,
}

@group(0) @binding(0) var densityTex: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cell = uv * u.cells;

  // How much of a cell falls inside one output pixel. THE ONE QUANTITY IN THIS
  // STYLE MEASURED IN OUTPUT PIXELS RATHER THAN IN FRACTIONS OF THE IMAGE, and
  // deliberately so: it is not part of the composition but of how the
  // composition is sampled, exactly like the width of an antialiased edge. The
  // dots are the same size relative to the photograph in a preview and in an
  // export; a larger render merely resolves them better.
  //
  // Evaluated here rather than per plate for two reasons. A derivative builtin
  // must sit in uniform control flow, so keeping it above the loop removes the
  // question entirely; and rotation preserves length, so one measure serves all
  // four screens.
  let perPixel = max(fwidth(cell.x), fwidth(cell.y));

  // Below two pixels per cell the screen is past Nyquist and drawing it would
  // alias into coarse beating rather than dissolve. Past that point the plate
  // falls back to the area its dots would have covered, which is the screen's
  // own transfer curve, so the fallback is continuous with the dots rather
  // than a different picture.
  let resolved = clamp(2.0 - 4.0 * perPixel, 0.0, 1.0);

  var sheet = u.paper.rgb;

  for (var i = 0u; i < 4u; i++) {
    let ink = u.inks[i];

    // Sampled through this plate's own registration error, so a misregistered
    // press shows at the EDGES of shapes, which is where the eye reads it.
    let densities = textureSampleLevel(densityTex, linearSampler, uv + ink.screen.zw, 0.0);
    let density = clamp(densities[i], 0.0, 1.0);

    let rotated = vec2f(
      cell.x * ink.screen.x - cell.y * ink.screen.y,
      cell.x * ink.screen.y + cell.y * ink.screen.x,
    );

    // The Euclidean dot, as a smooth field: maximal at cell centres, minimal at
    // the corners. Thresholding it against density grows a round dot that meets
    // its neighbours near half tone and closes into a round hole above it,
    // which is the classic spot function and the reason midtones hold together.
    let spot = 0.5 + 0.25 * (cos(TAU * rotated.x) + cos(TAU * rotated.y));

    // The exact gradient of that field, which turns the threshold into an edge
    // roughly one pixel wide without a second derivative builtin.
    let slope = 0.25 * TAU * length(vec2f(sin(TAU * rotated.x), sin(TAU * rotated.y)));
    let edge = max(slope * perPixel, 1e-4);

    let threshold = density * (1.0 + 2.0 * SOLID_MARGIN) - SOLID_MARGIN;
    let coverage = mix(
      smoothstep(0.0, 1.0, density),
      smoothstep(-edge, edge, threshold - spot),
      resolved,
    );

    // Subtractive, one plate over the last: ink absorbs rather than replaces,
    // which is what makes cyan over yellow read as green.
    sheet *= mix(vec3f(1.0), ink.colour.rgb, coverage);
  }

  // The composite relies on mix(base, styled, 0) returning base exactly, which
  // holds for any finite value and fails for NaN.
  return vec4f(select(vec3f(0.0), sheet, sheet == sheet), 1.0);
}
