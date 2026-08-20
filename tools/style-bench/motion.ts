// MEASUREMENT 4: what a temporal method costs, measured BEFORE one is built.
//
// Every temporal method improves flicker trivially, and some of them do it by
// making the picture worse. Blend enough of the last frame in and a fixed camera
// is perfectly steady while a moving one smears. Measurements 2 and 0 cannot
// catch that: `static-720p` has a fixed camera and nothing in it can expose a
// ghost, and `pan-720p` moves the whole frame together, which is the one case a
// warp of the last frame gets right by construction.
//
// So this is the counter-metric, and it is here before any cure is. It runs on
// `traffic-720p`, where the camera is fixed and five cars are not, and it asks
// four things per frame rather than one:
//
//   RESIDUE     how much the styled frame moves where nothing moved. This is
//               the number the chapter is about, and it is measurement 2's
//               flicker restricted to the pixels that are honestly still.
//   HONEST      how much it moves where something did. The control: it should
//               be large, and a method that shrinks it is erasing motion.
//   DEVIATION   how far the method's frame is from the per-frame render of the
//               same frame, in each of the three populations. Zero everywhere
//               for the per-frame row by construction, which is the reading of
//               "no stabilisation at all" the others are compared against.
//   DETAIL      the gradient energy inside a moving car, against the per-frame
//               render's. A smear loses it.
//
// THE DEVIATION IS SPLIT THREE WAYS BECAUSE THE PICTURE SAID SO. The first
// version of this measured it only in the band a car had just left, on the
// argument that a ghost can live nowhere else. The trail map it writes says
// otherwise: at these speeds most of what a blend does is a halo just OUTSIDE
// the moving object, on ground no car touched on either frame. That lands in
// `still`, where a vacated-band figure cannot see it, and it is the larger half
// of the damage.
//
// A METRIC WITH NO FAILING CASE IS NOT A CHECK, so a straw man is measured
// alongside: the previous stylised frame blended in at a fixed weight, with no
// motion compensation at all. That is the cheapest thing anybody would try and
// it is the thing this measurement has to fail. If it does not, the metric is
// wrong and nothing built on it can be believed.
//
// Needs `traffic-720p.mp4`, `traffic-clean-720p.mp4` and `traffic-mask-720p.mp4`
// from make-clips.sh.

import { CONTENT_CASES, type Case } from './chain.ts';
import { CLIPS, StyleStage, type Difference } from './harness.ts';
import { clipFrames } from './stability.ts';
import { toBase64, type Still } from './stills.ts';

export const SIZE = { width: 1280, height: 720 };

/** How many consecutive pairs each row averages over. Two seconds is sixty. */
export const FRAMES = 24;

/**
 * Above this the mask says a moving thing covered the pixel.
 *
 * Halfway, because the mask records coverage rather than membership and a car's
 * edge is antialiased in both the picture and the mask. What the threshold
 * decides is only which side of the boundary a half-covered pixel is counted
 * on, and the three populations below are disjoint by construction whatever it
 * is set to.
 */
const COVERED = 128;

/**
 * The weights the straw man is measured at.
 *
 * Two of them rather than one, because the interesting thing about a method
 * that has no motion compensation is not that it fails but HOW its two numbers
 * trade: every step of weight buys residue and pays for it in trail, and a
 * single point cannot show a trade.
 */
const BLENDS = [0.25, 0.5] as const;

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Three disjoint populations of pixel, decided by the mask on two frames. */
export interface Populations {
  /** Covered by nothing, on this frame or the last. Where the residue lives. */
  readonly still: Uint8Array;
  /** Covered now. The control. */
  readonly moving: Uint8Array;
  /** Covered last frame and not now: the band a ghost lives in and little else. */
  readonly vacated: Uint8Array;
}

export function populations(previous: Uint8Array, now: Uint8Array): Populations {
  const pixels = now.length / 4;
  const still = new Uint8Array(pixels);
  const moving = new Uint8Array(pixels);
  const vacated = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const was = (previous[i * 4] ?? 0) > COVERED;
    const is = (now[i * 4] ?? 0) > COVERED;
    if (is) moving[i] = 1;
    else if (was) vacated[i] = 1;
    else still[i] = 1;
  }
  return { still, moving, vacated };
}

/**
 * How far apart two renders are, over one population of pixels.
 *
 * The same three figures `harness.ts` reports, restricted. `mean` is the least
 * useful of them here for the reason it is there: boiling is a small proportion
 * of pixels moving a long way rather than every pixel moving a little.
 */
export function differenceWhere(a: Uint8Array, b: Uint8Array, keep: Uint8Array): Difference {
  const histogram = new Float64Array(256);
  let pixels = 0;
  for (let i = 0; i < keep.length; i++) {
    if (keep[i] !== 1) continue;
    const at = i * 4;
    const delta = Math.max(
      Math.abs((a[at] ?? 0) - (b[at] ?? 0)),
      Math.abs((a[at + 1] ?? 0) - (b[at + 1] ?? 0)),
      Math.abs((a[at + 2] ?? 0) - (b[at + 2] ?? 0)),
    );
    histogram[delta] = (histogram[delta] ?? 0) + 1;
    pixels++;
  }
  if (pixels === 0) return { mean: 0, p99: 0, flicker: 0 };

  let total = 0;
  let seen = 0;
  let p99 = 0;
  let flicker = 0;
  for (let delta = 0; delta < 256; delta++) {
    const at = histogram[delta] ?? 0;
    total += delta * at;
    seen += at;
    if (p99 === 0 && seen >= pixels * 0.99) p99 = delta;
    if (delta > 8) flicker += at;
  }
  return { mean: round(total / pixels), p99, flicker: round((flicker / pixels) * 100) };
}

/**
 * Mean gradient magnitude over a population, in codes per pixel.
 *
 * WHAT A SMEAR TAKES AWAY. A ghost is a second, displaced copy of a moving
 * edge: it blurs the real one and adds low-contrast duplicates beside it, and
 * both lower the average. Forward differences on the green channel, which
 * carries most of the luminance and needs no colour maths to be comparable
 * between two renders of the same frame.
 */
function detail(image: Uint8Array, keep: Uint8Array, width: number): number {
  let total = 0;
  let pixels = 0;
  const height = keep.length / width;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x;
      if (keep[i] !== 1) continue;
      const at = i * 4 + 1;
      const dx = Math.abs((image[at + 4] ?? 0) - (image[at] ?? 0));
      const dy = Math.abs((image[at + width * 4] ?? 0) - (image[at] ?? 0));
      total += Math.hypot(dx, dy);
      pixels++;
    }
  }
  return pixels === 0 ? 0 : round(total / pixels);
}

/**
 * The previous stylised frame blended in, with no motion compensation.
 *
 * THE STRAW MAN, and the only reason it is here is that a counter-metric with
 * no failing case is not a check. It is recursive rather than a two-frame
 * average, because that is what a temporal filter actually is and because the
 * recursion is what makes a trail last rather than appear once.
 */
function blended(current: Uint8Array, previous: Uint8Array | undefined, weight: number): Uint8Array {
  if (!previous || weight === 0) return current;
  const out = new Uint8Array(current.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round((previous[i] ?? 0) * weight + (current[i] ?? 0) * (1 - weight));
  }
  return out;
}

interface Running {
  /** Frame to frame, where nothing moved. The number the chapter is about. */
  residue: Difference;
  /** Frame to frame, where something did. The control. */
  honest: Difference;
  /** Against the per-frame render, in each of the three populations. */
  deviation: { still: Difference; moving: Difference; vacated: Difference };
  detailRatio: number;
  n: number;
}

const nothing = (): Difference => ({ mean: 0, p99: 0, flicker: 0 });

const empty = (): Running => ({
  residue: nothing(),
  honest: nothing(),
  deviation: { still: nothing(), moving: nothing(), vacated: nothing() },
  detailRatio: 0,
  n: 0,
});

function add(into: Difference, one: Difference): Difference {
  return { mean: into.mean + one.mean, p99: into.p99 + one.p99, flicker: into.flicker + one.flicker };
}

const settle = (one: Difference, n: number): Difference =>
  n === 0 ? one : { mean: round(one.mean / n), p99: round(one.p99 / n), flicker: round(one.flicker / n) };

/**
 * One style over the traffic clip, per frame and blended, side by side.
 *
 * The blends are carried in the SAME pass as the per-frame render rather than
 * in one of their own, because the trail figure is a comparison between the two
 * on the same frame and a second pass would compare two renders of two decodes.
 */
interface Method {
  readonly name: string;
  readonly weight: number;
  readonly running: Running;
  /** This method's own output for the frame before, which is what it blends. */
  previous?: Uint8Array;
}

async function overTraffic(device: GPUDevice, clip: string, item: Case): Promise<Record<string, unknown>> {
  const stage = new StyleStage(device, SIZE);
  const methods: Method[] = [
    { name: 'per frame', weight: 0, running: empty() },
    ...BLENDS.map((weight) => ({ name: `blend ${String(weight)}`, weight, running: empty() })),
  ];

  const pictures = clipFrames(`${CLIPS}/${clip}.mp4`, FRAMES);
  const masks = clipFrames(`${CLIPS}/traffic-mask-720p.mp4`, FRAMES);
  let previousMask: Uint8Array | undefined;

  try {
    for (;;) {
      const picture = await pictures.next();
      const mask = await masks.next();
      if (picture.done || mask.done) break;

      stage.uploadImage(picture.value);
      await stage.render(item.style, item.controls, 'full', true);
      const styled = await stage.readOutput();

      // Read back through the source texture, which is where anything uploaded
      // lands. The mask is a picture as far as the GPU is concerned.
      stage.uploadImage(mask.value);
      const maskBytes = await stage.readSource();

      const where = previousMask ? populations(previousMask, maskBytes) : undefined;
      const perFrameDetail = where ? detail(styled, where.moving, SIZE.width) : 0;

      for (const method of methods) {
        const output = blended(styled, method.previous, method.weight);
        if (where && method.previous) {
          const running = method.running;
          running.residue = add(running.residue, differenceWhere(method.previous, output, where.still));
          running.honest = add(running.honest, differenceWhere(method.previous, output, where.moving));
          // Against the per-frame render of THIS frame, so a deviation is the
          // method's own doing rather than anything the clip did. Zero in every
          // population for the per-frame row by construction, which is the
          // reading of "no stabilisation at all" the others are compared to.
          //
          // ALL THREE POPULATIONS, and the picture is why. The first version of
          // this measured only the band a car had just left, on the argument
          // that a ghost can live nowhere else. The trail map says otherwise: at
          // these speeds most of what a blend does is a halo just OUTSIDE the
          // moving object, on ground no car has touched on either frame, which
          // lands in `still` and which a vacated-band figure cannot see.
          running.deviation.still = add(
            running.deviation.still,
            differenceWhere(styled, output, where.still),
          );
          running.deviation.moving = add(
            running.deviation.moving,
            differenceWhere(styled, output, where.moving),
          );
          running.deviation.vacated = add(
            running.deviation.vacated,
            differenceWhere(styled, output, where.vacated),
          );
          running.detailRatio +=
            perFrameDetail === 0 ? 1 : detail(output, where.moving, SIZE.width) / perFrameDetail;
          running.n++;
        }
        method.previous = output;
      }

      previousMask = maskBytes;
    }
  } finally {
    await pictures.return(undefined);
    await masks.return(undefined);
    stage.dispose();
  }

  const out: Record<string, unknown> = {};
  for (const method of methods) {
    const running = method.running;
    out[method.name] = {
      residue: settle(running.residue, running.n),
      honest: settle(running.honest, running.n),
      deviation: {
        still: settle(running.deviation.still, running.n),
        moving: settle(running.deviation.moving, running.n),
        vacated: settle(running.deviation.vacated, running.n),
      },
      detail_against_per_frame: running.n === 0 ? 0 : round(running.detailRatio / running.n),
      pairs: running.n,
    };
  }
  return out;
}

export async function motion(device: GPUDevice): Promise<unknown> {
  const out: Record<string, unknown> = {
    what: 'what a temporal method would cost, measured before one is built',
    covered_threshold: COVERED,
    frames: FRAMES,
  };
  for (const clip of ['traffic-720p', 'traffic-clean-720p']) {
    const rows: Record<string, unknown> = {};
    for (const item of CONTENT_CASES) rows[item.name] = await overTraffic(device, clip, item);
    out[clip] = rows;
  }
  return out;
}

/**
 * A picture of the trail, because a number for it is not evidence of one.
 *
 * The same argument `flicker.ts` makes: a scalar can say a method got steadier
 * while saying nothing about what it did to the picture, and the one thing a
 * reader wants to see about a smear is the smear. Three pictures rather than
 * two, because the first two do not show it. A recursive blend at a half is a
 * geometric decay, so on a car crossing two or three pixels a frame the ghost
 * is a thin bright annulus rather than a visible double image, and side by side
 * the two frames look almost the same. The third one paints where the
 * difference is, which is what the number is counting.
 */
export async function motionPictures(device: GPUDevice): Promise<readonly Still[]> {
  const out: Still[] = [];
  const stage = new StyleStage(device, SIZE);
  const item = CONTENT_CASES.find((candidate) => candidate.name === 'poster, default');
  if (!item) throw new Error('style-bench: no poster case to draw a trail with');

  const pictures = clipFrames(`${CLIPS}/traffic-720p.mp4`, FRAMES);
  const masks = clipFrames(`${CLIPS}/traffic-mask-720p.mp4`, FRAMES);
  let carried: Uint8Array | undefined;
  let last: Uint8Array | undefined;
  let previousMask: Uint8Array | undefined;
  let where: Populations | undefined;

  try {
    for (;;) {
      const picture = await pictures.next();
      const mask = await masks.next();
      if (picture.done || mask.done) break;

      stage.uploadImage(picture.value);
      await stage.render(item.style, item.controls, 'full', true);
      last = await stage.readOutput();
      carried = blended(last, carried, 0.5);

      stage.uploadImage(mask.value);
      const maskBytes = await stage.readSource();
      if (previousMask) where = populations(previousMask, maskBytes);
      previousMask = maskBytes;
    }
  } finally {
    await pictures.return(undefined);
    await masks.return(undefined);
  }
  stage.dispose();

  if (!carried || !last || !where) return out;
  out.push({
    name: 'motion per frame',
    width: SIZE.width,
    height: SIZE.height,
    rgb: toBase64(last),
    labels: ['the last frame, rendered per frame'],
  });
  out.push({
    name: 'motion blend 0.5',
    width: SIZE.width,
    height: SIZE.height,
    rgb: toBase64(carried),
    labels: ['the same frame with half of the last one blended in, and no motion compensation'],
  });
  out.push({
    name: 'motion trail',
    width: SIZE.width,
    height: SIZE.height,
    rgb: toBase64(trailMap(last, carried, where), 3),
    labels: ['where the two differ: red is the band a car has just left, blue is everywhere else'],
  });
  return out;
}

/**
 * Where the blended frame differs from the per-frame one, over the frame.
 *
 * TWO COLOURS, because the difference between them is the whole finding. Red is
 * the vacated band, which is what the trail figure counts and where a ghost is
 * the only thing that can live. Blue is every other pixel, where a difference
 * is the method doing the job it was asked to do. A single colour would say a
 * temporal method changes the picture, which nobody doubted.
 */
function trailMap(perFrame: Uint8Array, method: Uint8Array, where: Populations): Uint8Array {
  const pixels = perFrame.length / 4;
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0, o = 0; i < pixels; i++, o += 3) {
    const at = i * 4;
    const delta = Math.max(
      Math.abs((perFrame[at] ?? 0) - (method[at] ?? 0)),
      Math.abs((perFrame[at + 1] ?? 0) - (method[at + 1] ?? 0)),
      Math.abs((perFrame[at + 2] ?? 0) - (method[at + 2] ?? 0)),
    );
    if (delta > 8) {
      const vacated = where.vacated[i] === 1;
      rgb[o] = vacated ? 255 : 40;
      rgb[o + 1] = 40;
      rgb[o + 2] = vacated ? 40 : 255;
    } else {
      rgb[o] = (perFrame[at] ?? 0) >> 1;
      rgb[o + 1] = (perFrame[at + 1] ?? 0) >> 1;
      rgb[o + 2] = (perFrame[at + 2] ?? 0) >> 1;
    }
  }
  return rgb;
}
