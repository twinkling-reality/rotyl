// Anisotropic Kuwahara filter, polynomial-weight variant
// (Kyprianidis, Kang & Döllner 2009; polynomial weights 2010).
//
// This is the stage that makes the result read as *illustrated* rather than as
// a photograph with a filter on it. A bilateral filter denoises: it keeps fur
// and foliage as fur and foliage, only smoother. This instead replaces each
// pixel with the mean of whichever oriented sector around it is most
// homogeneous, which flattens regions into painterly patches while sharpening
// the boundaries between them, exactly the structure an inked drawing has.
//
// The neighbourhood is an ellipse aligned to the local structure: elongated
// along edges, narrow across them, so it never averages across a contour.
//
// Two iterations at a small radius beat one at twice the radius. Better shape
// coherence, and roughly half the samples, since cost grows with radius².

const MAX_BOUND: i32 = 24;
const PI: f32 = 3.14159265359;
const SECTORS: i32 = 8;

struct Uniforms {
  texelSize: vec2f,
  radius: f32,
  sharpness: f32,
}

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var tensorTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> u: Uniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let structure = decodeStructure(textureSampleLevel(tensorTex, linearSampler, uv, 0.0).rgb);

  let radius = max(u.radius, 1.0);
  // alpha = 1, so eccentricity runs from 1 (isotropic) to 2 (strongly aligned)
  // and the ellipse's axis ratio reaches 4:1 on a hard edge.
  let eccentricity = 1.0 + structure.anisotropy;
  let major = eccentricity * radius;
  let minor = radius / eccentricity;

  let cosPhi = structure.tangent.x;
  let sinPhi = structure.tangent.y;
  // Maps an offset in pixels onto the unit disk, so the ellipse test is
  // dot(p, p) <= 1 regardless of orientation or eccentricity.
  let toUnitDisk = mat2x2f(
    vec2f(cosPhi / major, -sinPhi / minor),
    vec2f(sinPhi / major,  cosPhi / minor),
  );
  let bound = min(i32(ceil(major)), MAX_BOUND);

  // Sector overlap constants. zeta scales with the radius because it controls
  // how far the sector weighting functions bleed into each other.
  let zeta = 2.0 / radius;
  let psi = 3.0 * PI / 16.0;
  let sinPsi = sin(psi);
  let eta = (zeta + cos(psi)) / (sinPsi * sinPsi);

  var meanAccum = array<vec3f, 8>();
  var lumaAccum = array<f32, 8>();
  var lumaSqAccum = array<f32, 8>();
  var weightAccum = array<f32, 8>();

  // Seed every sector with the centre pixel so that a sector receiving no
  // other samples still has a defined mean.
  let centre = textureSampleLevel(sourceTex, linearSampler, uv, 0.0).rgb;
  let centreLuma = luminance(centre);
  let seed = 1.0 / f32(SECTORS);
  for (var k = 0; k < SECTORS; k++) {
    meanAccum[k] = centre * seed;
    lumaAccum[k] = centreLuma * seed;
    lumaSqAccum[k] = centreLuma * centreLuma * seed;
    weightAccum[k] = seed;
  }

  // Half-plane traversal: each offset is evaluated once and contributes to
  // sector k at +(i, j) and to the opposite sector at -(i, j) with the same
  // weight. Halves the sample count exactly.
  for (var j = 0; j <= MAX_BOUND; j++) {
    if (j > bound) { break; }
    for (var i = -MAX_BOUND; i <= MAX_BOUND; i++) {
      if (i < -bound) { continue; }
      if (i > bound) { break; }
      if (j == 0 && i <= 0) { continue; }

      let offset = vec2f(f32(i), f32(j));
      let p = toUnitDisk * offset;
      let radial = dot(p, p);
      if (radial > 1.0) { continue; }

      // Polynomial sector weights: eight overlapping lobes around the disk,
      // built from two axis-aligned polynomials and the same pair rotated 45
      // degrees. No trigonometry per sample.
      let polyX = zeta - eta * p.x * p.x;
      let polyY = zeta - eta * p.y * p.y;
      let rotated = 0.70710678 * vec2f(p.x - p.y, p.x + p.y);
      let rotPolyX = zeta - eta * rotated.x * rotated.x;
      let rotPolyY = zeta - eta * rotated.y * rotated.y;

      var weights = array<f32, 8>();
      weights[0] = pow(max(0.0,  p.y + polyX), 2.0);
      weights[1] = pow(max(0.0,  rotated.y + rotPolyX), 2.0);
      weights[2] = pow(max(0.0, -p.x + polyY), 2.0);
      weights[3] = pow(max(0.0, -rotated.x + rotPolyY), 2.0);
      weights[4] = pow(max(0.0, -p.y + polyX), 2.0);
      weights[5] = pow(max(0.0, -rotated.y + rotPolyX), 2.0);
      weights[6] = pow(max(0.0,  p.x + polyY), 2.0);
      weights[7] = pow(max(0.0,  rotated.x + rotPolyY), 2.0);

      var weightTotal = 0.0;
      for (var k = 0; k < SECTORS; k++) { weightTotal += weights[k]; }
      if (weightTotal <= 0.0) { continue; }

      // Radial falloff, normalised so the eight sectors partition the disk.
      let g = exp(-PI * radial) / weightTotal;

      let step = offset * u.texelSize;
      let forward = textureSampleLevel(sourceTex, linearSampler, uv + step, 0.0).rgb;
      let backward = textureSampleLevel(sourceTex, linearSampler, uv - step, 0.0).rgb;
      let forwardLuma = luminance(forward);
      let backwardLuma = luminance(backward);

      for (var k = 0; k < SECTORS; k++) {
        let w = weights[k] * g;
        if (w <= 0.0) { continue; }
        let opposite = (k + 4) & 7;

        meanAccum[k] += w * forward;
        lumaAccum[k] += w * forwardLuma;
        lumaSqAccum[k] += w * forwardLuma * forwardLuma;
        weightAccum[k] += w;

        meanAccum[opposite] += w * backward;
        lumaAccum[opposite] += w * backwardLuma;
        lumaSqAccum[opposite] += w * backwardLuma * backwardLuma;
        weightAccum[opposite] += w;
      }
    }
  }

  // Combine sectors, weighting each by the inverse of its own variance raised
  // to `sharpness`, so the most homogeneous sector dominates.
  //
  // Variance is taken from luminance alone rather than per channel. That is
  // partly register pressure, three fewer live accumulators per sector across
  // the whole sample loop, and partly that chroma noise should not decide
  // which sector wins.
  var colourTotal = vec3f(0.0);
  var alphaTotal = 0.0;

  for (var k = 0; k < SECTORS; k++) {
    let weight = weightAccum[k];
    if (weight <= 0.0) { continue; }

    let mean = meanAccum[k] / weight;
    let meanLuma = lumaAccum[k] / weight;
    let variance = abs(lumaSqAccum[k] / weight - meanLuma * meanLuma);
    // The floor is load-bearing: without it a perfectly homogeneous sector
    // divides by zero. With sharpness at 10 this term reaches ~1e17, which is
    // fine in f32 and would overflow in f16. Hence the f32 accumulators.
    let alpha = 1.0 / pow(max(0.02, sqrt(variance)), u.sharpness);

    colourTotal += alpha * mean;
    alphaTotal += alpha;
  }

  if (alphaTotal <= 0.0) {
    return vec4f(centre, 1.0);
  }
  return vec4f(colourTotal / alphaTotal, 1.0);
}
