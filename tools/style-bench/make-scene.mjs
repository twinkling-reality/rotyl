// The picture the style measurements are taken against, drawn from nothing.
//
// A photograph cannot be checked in — licensing aside, a benchmark whose input
// nobody else has is a benchmark nobody else can repeat. So the scene is
// synthesised, and synthesised to have the statistics the style chain is
// sensitive to rather than to look like art:
//
//   hazy, desaturated distance   the case the palette exists for: stylise this
//                                and the answer is grey, because the input is
//   large near-flat regions      where cel banding shows, and where a
//                                winner-take-all flatten has nothing to win by
//   hard architectural edges     what the ink is supposed to find
//   fine foliage texture         what it is supposed to ignore
//   long thin road markings      lines a difference of Gaussians can drop
//   a few saturated accents      the only real colour in an otherwise grey frame
//   film grain, sigma ~2 codes   the perturbation temporal stability is about
//
// Deterministic: same bytes on every machine, from a seeded PRNG and no
// dependencies. PNG is written by hand because zlib is in the standard library
// and an image encoder is not worth a package.

import { writeFileSync } from 'node:fs';
import { encodePng } from './png.mjs';

const WIDTH = 1920;
const HEIGHT = 1080;
const HORIZON = 0.52 * HEIGHT;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x5ea11ed);

/** Periodic value noise on a lattice, smoothed. Periodic so that a coordinate
 * outside [0, 1] wraps rather than running off the end of the grid, which is
 * the difference between texture and a stripe of blown-out extrapolation. */
function noiseField(cells, seed) {
  const rng = mulberry32(seed);
  const grid = Float32Array.from({ length: cells * cells }, () => rng());
  const wrap = (v) => ((v % cells) + cells) % cells;
  const at = (gx, gy) => grid[wrap(gy) * cells + wrap(gx)] ?? 0;
  return (x, y) => {
    const fx = x * cells;
    const fy = y * cells;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const top = at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx;
    const bottom = at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx;
    return top * (1 - sy) + bottom * sy;
  };
}

function fbm(seed, octaves = 4) {
  const layers = Array.from({ length: octaves }, (_, i) => noiseField(4 << i, seed + i * 977));
  return (x, y) => {
    let total = 0;
    let amplitude = 1;
    let sum = 0;
    for (const layer of layers) {
      total += amplitude * layer(x, y);
      sum += amplitude;
      amplitude *= 0.5;
    }
    return total / sum;
  };
}

const foliageNoise = fbm(11, 5);
const asphaltNoise = fbm(53, 4);
const facadeNoise = fbm(97, 3);

/** Standard normal, Box-Muller, for grain that looks like a sensor's. */
function gaussian(rng) {
  const u = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const HAZE = [0.78, 0.79, 0.8];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Buildings, far to near, so nearer ones are drawn over the haze of the last. */
function makeBuildings() {
  const out = [];
  for (let band = 0; band < 3; band++) {
    const depth = 1 - band * 0.42;
    let x = -40 - rand() * 80;
    while (x < WIDTH + 40) {
      const w = 70 + rand() * (150 + band * 120);
      const h = (90 + rand() * 260) * (1 + band * 0.55);
      const shade = 0.3 + rand() * 0.22;
      out.push({
        x,
        w,
        top: HORIZON - h,
        depth,
        // Cool grey concrete, barely coloured: the input the palette has to rescue.
        base: [shade * 0.98, shade, shade * 1.06],
        windows: band > 0,
        lit: 0.1 + rand() * 0.25,
        seed: rand() * 1000,
      });
      x += w + 2 + rand() * 10;
    }
  }
  return out;
}

const BUILDINGS = makeBuildings();

/** Cars, far to near along the road, the only saturated things in the frame. */
const CARS = [
  { t: 0.06, lane: -0.55, body: [0.42, 0.11, 0.12], scale: 1 },
  { t: 0.16, lane: 0.5, body: [0.16, 0.17, 0.2], scale: 1 },
  { t: 0.3, lane: -0.62, body: [0.72, 0.68, 0.62], scale: 1 },
  { t: 0.48, lane: 0.58, body: [0.11, 0.2, 0.3], scale: 0.95 },
  { t: 0.72, lane: -0.5, body: [0.55, 0.5, 0.12], scale: 0.85 },
];

/** Half-width of the carriageway at a given depth, in pixels. */
function roadHalfWidth(t) {
  return 20 + t * t * 1020;
}

function roadCentre(t) {
  return WIDTH * (0.5 + 0.04 * t);
}

function shadeAt(x, y) {
  const u = x / WIDTH;
  const v = y / HEIGHT;

  if (y < HORIZON) {
    // Sky: a flat hazy gradient with a sun that is felt rather than seen.
    const t = y / HORIZON;
    let colour = mix([0.5, 0.56, 0.66], [0.82, 0.81, 0.78], Math.pow(t, 1.6));
    const dx = (u - 0.72) * 1.9;
    const dy = v - 0.2;
    const glow = Math.exp(-(dx * dx + dy * dy) * 9);
    colour = mix(colour, [1, 0.95, 0.86], glow * 0.55);

    for (const b of BUILDINGS) {
      if (x < b.x || x >= b.x + b.w || y < b.top) continue;
      let facade = b.base.slice();
      const grime = facadeNoise((x + b.seed) / 900, y / 900);
      facade = facade.map((c) => c * (0.9 + 0.2 * grime));

      if (b.windows) {
        // A window grid, mostly dark, a few lit: hard edges at a regular pitch,
        // which is what a difference of Gaussians finds easiest to over-ink.
        const cw = 17;
        const ch = 24;
        const gx = Math.floor((x - b.x - 6) / cw);
        const gy = Math.floor((y - b.top - 10) / ch);
        const inX = (x - b.x - 6) % cw < cw * 0.62 && x - b.x > 6 && x - b.x < b.w - 6;
        const inY = (y - b.top - 10) % ch < ch * 0.6 && y - b.top > 10;
        if (inX && inY && gx >= 0 && gy >= 0) {
          const cell = mulberry32(Math.round(b.seed) * 7919 + gx * 131 + gy * 17)();
          facade = cell < b.lit ? [0.86, 0.8, 0.6] : facade.map((c) => c * 0.62);
        }
      }
      // Aerial perspective: the far band is nearly the haze itself.
      colour = mix(HAZE, facade, 0.25 + 0.68 * b.depth);
    }

    // Foliage against the sky, near the left edge.
    const canopy = foliageNoise(u * 1.4, v * 2.2);
    const canopyMask = canopy - 0.42 - 1.6 * Math.abs(u - 0.16) - 2.2 * Math.max(0, 0.3 - v);
    if (canopyMask > 0 && y > HORIZON - 320) {
      const leaf = mix([0.09, 0.14, 0.07], [0.24, 0.3, 0.13], foliageNoise(u * 9, v * 9));
      colour = mix(colour, mix(HAZE, leaf, 0.86), Math.min(1, canopyMask * 14));
    }
    return colour;
  }

  // Road, in perspective: t runs 0 at the horizon to 1 at the bottom edge.
  const t = (y - HORIZON) / (HEIGHT - HORIZON);
  const half = roadHalfWidth(t);
  const centre = roadCentre(t);
  const across = (x - centre) / half;

  let colour;
  if (Math.abs(across) < 1) {
    const grain = asphaltNoise(x / (600 * (0.2 + t)), y / 400);
    colour = [0.2 + 0.09 * grain, 0.2 + 0.088 * grain, 0.21 + 0.09 * grain];

    // Lane dashes: long thin marks, the finest structure the ink must keep.
    const along = 1 / Math.max(0.06, t) + y * 0.004;
    const dash = Math.abs(across) < 0.035 && (along * 2.2) % 2 < 1.1;
    const kerbLine = Math.abs(Math.abs(across) - 0.93) < 0.012;
    if (dash || kerbLine) colour = mix(colour, [0.86, 0.85, 0.8], 0.85);
  } else {
    // Pavement and verge.
    const grain = asphaltNoise(x / 500, y / 500);
    colour = [0.36 + 0.1 * grain, 0.35 + 0.1 * grain, 0.34 + 0.1 * grain];
    if (Math.abs(across) > 1.5) {
      const leaf = mix([0.13, 0.19, 0.09], [0.3, 0.34, 0.15], foliageNoise(x / 300, y / 300));
      colour = mix(colour, leaf, 0.5);
    }
  }

  for (const car of CARS) {
    const ct = car.t;
    const chalf = roadHalfWidth(ct);
    const cx = roadCentre(ct) + car.lane * chalf;
    const cy = HORIZON + ct * (HEIGHT - HORIZON);
    const w = chalf * 0.34 * car.scale;
    const h = w * 0.78;
    const dx = (x - cx) / w;
    const dy = (y - (cy - h * 0.5)) / h;
    // A rounded body rather than a rectangle: a curved silhouette is a harder
    // thing for an edge detector to draw cleanly than a straight one.
    const inside = Math.pow(Math.abs(dx), 2.4) + Math.pow(Math.abs(dy), 2.6);
    if (inside < 1.25) {
      let body = car.body;
      // The greenhouse: its own smaller shape, so the glass meets the body on a
      // curve rather than on a horizontal cut across the whole car.
      const glass = Math.pow(Math.abs(dx / 0.62), 2.2) + Math.pow(Math.abs((dy + 0.42) / 0.42), 2.2);
      if (glass < 1) body = mix(body, [0.22, 0.26, 0.3], 0.75);
      const sheen = Math.max(0, 1 - Math.abs(dx + 0.35) * 3.5) * Math.max(0, 1 - Math.abs(dy + 0.75) * 5);
      body = mix(body, [1, 1, 0.98], sheen * 0.45);

      // Tail lights: small, saturated, and inside the body rather than beside it.
      if (Math.abs(Math.abs(dx) - 0.66) < 0.11 && Math.abs(dy - 0.12) < 0.16) {
        body = mix(body, [0.92, 0.13, 0.09], 0.9);
      }
      colour = mix(colour, body, Math.min(1, Math.max(0, (1 - inside) * 9)));
    }
  }

  // Haze thins toward the viewer, exactly as it does up the buildings.
  return mix(HAZE, colour, 0.42 + 0.58 * Math.min(1, t * 2.2));
}

function render() {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  const grainRng = mulberry32(0xc0ffee);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const colour = shadeAt(x + 0.5, y + 0.5);
      // Luma grain plus a little chroma, both at the level a decent sensor
      // leaves at base ISO. This is the perturbation, and it is the reason a
      // per-frame style can boil.
      const luma = gaussian(grainRng) * (2.1 / 255);
      const offset = (y * WIDTH + x) * 3;
      for (let c = 0; c < 3; c++) {
        const value = colour[c] + luma + gaussian(grainRng) * (0.9 / 255);
        rgb[offset + c] = Math.max(0, Math.min(255, Math.round(value * 255)));
      }
    }
  }
  return rgb;
}

const rgb = render();
const out = process.argv[2] ?? 'tools/style-bench/clips/scene.png';
writeFileSync(out, encodePng(rgb, WIDTH, HEIGHT));
if (process.argv.includes('--raw')) writeFileSync(`${out.replace(/\.png$/, '')}.rgb`, rgb);
console.log(`${out}  ${WIDTH}x${HEIGHT}`);
