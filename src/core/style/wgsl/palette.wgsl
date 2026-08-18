// Palettes in the shader: two operators over the same five stops.
//
// A palette is what makes a picture read as chosen rather than sampled, and
// there are exactly two useful ways to impose one. They are here together
// because they are the same data and the same argument, and because a style
// that wants one usually wants the option of the other.
//
// RAMP maps LIGHTNESS to colour. Dark parts take the dark end, light parts the
// light end, hue is replaced wholesale. Form survives completely because it is
// carried by the lightness being used as the index. What it cannot do is keep
// two things apart: a red tail light and a grey wall of the same lightness come
// out the same colour, so a whole picture collapses to a single hue ramp. That
// is a look, and it is the right one when the photograph's own colour is worth
// nothing - smog, fog, sodium light.
//
// SNAP takes the NEAREST stop in Oklab, in all three dimensions. The palette is
// then a set rather than a ramp: things that differ in hue stay different,
// because the axis they differ along is one of the axes being measured. It is
// the operator a poster wants - few colours, chosen, but still able to tell a
// car from a road.
//
// Both work in Oklab, where distance is roughly perceptual, so "nearest" means
// what a person would call nearest and the midpoint between two stops is the
// colour a person would call the midpoint.

const PALETTE_STOPS = 5;

/** The palette colour at a given lightness: four segments between five stops. */
fn paletteRamp(stops: array<vec4f, PALETTE_STOPS>, lightness: f32) -> vec3f {
  let t = clamp(lightness, 0.0, 1.0) * f32(PALETTE_STOPS - 1);
  let index = min(u32(floor(t)), u32(PALETTE_STOPS - 2));
  return mix(stops[index].xyz, stops[index + 1u].xyz, t - f32(index));
}

/**
 * The nearest stop, and enough about the runner-up to draw the boundary
 * without a staircase.
 *
 * A hard nearest-neighbour assignment aliases: the boundary between two
 * regions is a level set of a smooth field, and rounding it lands on pixel
 * corners. `margin` is how much closer the winner is than the runner-up, which
 * goes to zero exactly on that boundary - so a caller with a derivative can
 * blend the two across one pixel and get a clean edge from a hard decision.
 */
struct PaletteMatch {
  nearest: vec3f,
  next: vec3f,
  margin: f32,
}

fn paletteSnap(stops: array<vec4f, PALETTE_STOPS>, lab: vec3f) -> PaletteMatch {
  var best = 1e30;
  var second = 1e30;
  var nearest = stops[0].xyz;
  var next = stops[0].xyz;

  for (var i = 0; i < PALETTE_STOPS; i++) {
    let stop = stops[i].xyz;
    let d = distance(lab, stop);
    if (d < best) {
      second = best;
      next = nearest;
      best = d;
      nearest = stop;
    } else if (d < second) {
      second = d;
      next = stop;
    }
  }

  var out: PaletteMatch;
  out.nearest = nearest;
  out.next = next;
  out.margin = second - best;
  return out;
}

/**
 * Move a picture's lightness to where the palette's lives.
 *
 * Both are described by a mean and a spread, so this is one affine map: centre
 * the picture on the palette's centre and scale it to the palette's spread. A
 * hazy photograph then reaches the dark and light stops it would otherwise
 * never touch, and a high-contrast one stops slamming into both ends.
 *
 * The gain is bounded because the alternative is a flat grey frame - spread
 * near zero - being blown up into whatever noise it has. At the bounds the
 * palette is applied literally, which is the behaviour that used to be the only
 * behaviour.
 */
fn fitLightness(lightness: f32, picture: vec2f, palette: vec2f) -> f32 {
  let gain = clamp(palette.y / max(picture.y, 0.03), 0.5, 2.5);
  return clamp(palette.x + (lightness - picture.x) * gain, 0.0, 1.0);
}

/**
 * The same, for chroma: how far a picture's colours are pushed toward the
 * palette's own saturation before being matched against it.
 *
 * Without this a desaturated photograph lands near the neutral axis, where the
 * nearest stop is decided almost entirely by lightness and two objects of
 * different colour take the same one. With it, hue gets a say proportional to
 * how much the palette itself uses hue.
 */
fn fitChroma(ab: vec2f, pictureChroma: f32, paletteChroma: f32) -> vec2f {
  return ab * clamp(paletteChroma / max(pictureChroma, 0.01), 1.0, 3.0);
}
