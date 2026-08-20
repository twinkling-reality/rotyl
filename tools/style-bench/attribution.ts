// MEASUREMENT 5: where the residue comes from, before anything is built to
// remove it.
//
// `docs/video.md` states the design and its price in one breath: every stage
// runs per frame with no knowledge of the last one, and a decision that flips
// between two frames boils however good either frame is. Earlier chapters
// softened the individual decisions and the numbers moved a long way. What is
// left is what softening a decision cannot reach, and there are three stories
// about where it comes from. They imply completely different features at
// completely different prices:
//
//   THE INPUT MOVES        a fixed camera still delivers grain and encoder
//                          noise, and every stage downstream answers to it
//                          honestly. The fix is one pass BEFORE the chain and
//                          needs no motion estimation on a static shot.
//   A STAGE AMPLIFIES      something inside the chain moves more than its own
//                          input did. The fix is inside one stage of one chain
//                          and touches no architecture.
//   THE DECISIONS ARE      the fix is genuinely temporal: the previous stylised
//   PER FRAME              frame, warped by motion, blended where the warp can
//                          be trusted. The expensive one, and the only one that
//                          breaks an invariant.
//
// THREE ROWS TELL THEM APART, and none of them needs a way to read a buffer out
// of the middle of a chain:
//
//   as it is          the chain over consecutive frames of a clip whose grain
//                     moves. What ships, and the number to beat.
//   no moving grain   the same frames from a clip encoded without temporal
//                     noise, so the input barely changes at all between two of
//                     them. Whatever residue survives here is NOT the grain.
//   input denoised    the same grainy clip with each frame averaged against the
//                     one before it, on the way in. This is the cheap fix,
//                     priced rather than argued: one pass, no motion
//                     estimation, and it is the whole of hypothesis one.
//
// And the AMPLIFICATION column decides hypothesis two on its own. It is the
// styled difference over the input difference that produced it: at or below
// one, the chain is transmitting what it was given and there is nothing inside
// it to fix, so the expensive answer buys nothing the cheap one does not.
//
// Restricted to the pixels a moving thing did not touch, which is what the mask
// beside `traffic-720p` is for: a car crossing the frame is an honest change
// and would swamp every row here. On a photograph nothing moves, so the
// restriction is the whole frame.
//
// AND IT RUNS ON PHOTOGRAPHS AS WELL AS ON THE DRAWN SCENE, which is not
// optional. The drawn scene reports every chain but print attenuating; the
// photographs report the poster chain amplifying foliage by one and a half.
// A finding taken on the synthetic scene alone has reversed sign here before
// and it cost a style an operator, so the two are taken together or not at all.
//
// Needs `traffic-720p.mp4`, `traffic-clean-720p.mp4` and `traffic-mask-720p.mp4`
// from make-clips.sh, and the four photograph clips from fetch-real.sh.

import { CONTENT_CASES, type Case } from './chain.ts';
import {
  addDifference,
  amplification,
  CLIPS,
  NO_DIFFERENCE,
  REAL,
  settleDifference,
  StyleStage,
  type Difference,
} from './harness.ts';
import { clipFrames } from './stability.ts';
import { differenceWhere, populations, FRAMES, SIZE } from './motion.ts';

/**
 * How much of the last frame the cheap fix keeps.
 *
 * A quarter, which is the weakest thing worth measuring: it is one pass, it
 * cannot smear much, and if a quarter is enough to move the residue then the
 * residue was the grain. If it is not enough, a larger weight is a bigger
 * smear rather than a different idea, and the counter-metric next door already
 * says what a bigger smear costs.
 */
const DENOISE = 0.25;

/**
 * The input averaged against the frame before it.
 *
 * ON THE WAY IN, which is the whole of what makes this hypothesis one rather
 * than hypothesis three. Blending the OUTPUT is a temporal filter and needs a
 * warp to be safe on moving content; blending the INPUT is a denoise, and on a
 * fixed camera the two frames it averages are the same picture twice.
 */
function averaged(current: Uint8Array, previous: Uint8Array | undefined, weight: number): Uint8Array {
  if (!previous) return current;
  const out = new Uint8Array(current.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round((previous[i] ?? 0) * weight + (current[i] ?? 0) * (1 - weight));
  }
  return out;
}

interface Running {
  input: Difference;
  styled: Difference;
  n: number;
}

const empty = (): Running => ({ input: NO_DIFFERENCE, styled: NO_DIFFERENCE, n: 0 });

/** What is done to a clip's frames on the way into the chain. */
interface Condition {
  readonly name: string;
  /** Which of the subject's clips to read, where it offers two. */
  readonly clean?: boolean;
  readonly denoise: number;
}

const CONDITIONS: readonly Condition[] = [
  { name: 'as it is', denoise: 0 },
  { name: 'no moving grain', clean: true, denoise: 0 },
  { name: 'input denoised', denoise: DENOISE },
];

/**
 * What the three conditions are run against.
 *
 * THE SYNTHETIC SCENE IS THE ONE THAT HIDES THIS, which is not a guess: the
 * outline that amplified a brick wall by five and a half reads as attenuating
 * on the drawn scene, and finding that out cost a style an operator. So the
 * four photographs are here beside it, put through exactly the recipe the
 * traffic clip uses, with the picture as the only thing that differs.
 *
 * `still` is where the residue is measured, and it is the whole frame on a
 * photograph because a photograph on a fixed camera has nothing moving in it.
 * The traffic clip has five cars, so it brings a mask.
 *
 * NO FILM SHOT HERE, and that is a limit rather than an omission. The two cuts
 * of Tears of Steel are the only inputs this project has with real sensor noise
 * in them, and they also have actors in them: an input denoise applied to a
 * clip with subject motion smears the subject, so the row would report a
 * shrinking input difference for the wrong reason, and there is no still
 * population to restrict to. What the film says about amplification is on the
 * real-footage page, taken the one way it can be.
 */
interface Subject {
  readonly name: string;
  readonly clip: string;
  /** The same content encoded with no temporal grain, where there is one. */
  readonly cleanClip?: string;
  /** Which pixels a moving thing covered, where anything moves. */
  readonly mask?: string;
}

const SUBJECTS: readonly Subject[] = [
  {
    name: 'the synthetic scene, five cars moving',
    clip: `${CLIPS}/traffic-720p.mp4`,
    cleanClip: `${CLIPS}/traffic-clean-720p.mp4`,
    mask: `${CLIPS}/traffic-mask-720p.mp4`,
  },
  ...['facade', 'foliage', 'fog', 'portrait'].map((name) => ({
    name: `${name}, fixed camera`,
    clip: `${REAL}/static-${name}-720p.mp4`,
  })),
];

/** Every pixel, for a clip with nothing moving in it. */
const everywhere = (pixels: number): Uint8Array => new Uint8Array(pixels).fill(1);

async function overCondition(
  device: GPUDevice,
  subject: Subject,
  condition: Condition,
  item: Case,
): Promise<Record<string, unknown> | undefined> {
  // A condition a subject cannot answer is left out rather than faked: only the
  // drawn scene can be rendered twice with the grain held still.
  const clip = condition.clean ? subject.cleanClip : subject.clip;
  if (!clip) return undefined;

  const stage = new StyleStage(device, SIZE);
  const running = empty();

  const pictures = clipFrames(clip, FRAMES);
  const masks = subject.mask ? clipFrames(subject.mask, FRAMES) : undefined;

  let previousRaw: Uint8Array | undefined;
  let previousFed: Uint8Array | undefined;
  let previousStyled: Uint8Array | undefined;
  let previousMask: Uint8Array | undefined;

  try {
    for (;;) {
      const picture = await pictures.next();
      const mask = await masks?.next();
      if (picture.done || mask?.done === true) break;

      // Uploaded once to get the bytes the chain would have seen, so the
      // denominator below is the picture the chain was given rather than the
      // file's own idea of it: the decoder and the colour conversion are inside
      // the measurement either way.
      stage.uploadImage(picture.value);
      const raw = await stage.readSource();
      const fed = condition.denoise > 0 ? averaged(raw, previousRaw, condition.denoise) : raw;
      if (condition.denoise > 0) stage.uploadBytes(fed);

      await stage.render(item.style, item.controls, 'full', true);
      const styled = await stage.readOutput();

      let maskBytes: Uint8Array | undefined;
      if (mask && !mask.done) {
        stage.uploadImage(mask.value);
        maskBytes = await stage.readSource();
      }

      if (previousFed && previousStyled) {
        const still =
          maskBytes && previousMask
            ? populations(previousMask, maskBytes).still
            : everywhere(styled.length / 4);
        running.input = addDifference(running.input, differenceWhere(previousFed, fed, still));
        running.styled = addDifference(running.styled, differenceWhere(previousStyled, styled, still));
        running.n++;
      }

      previousRaw = raw;
      previousFed = fed;
      previousStyled = styled;
      previousMask = maskBytes;
    }
  } finally {
    await pictures.return(undefined);
    await masks?.return(undefined);
    stage.dispose();
  }

  const input = settleDifference(running.input, running.n);
  const styled = settleDifference(running.styled, running.n);
  return { input, styled, amplification: amplification(styled, input), pairs: running.n };
}

export async function attribution(device: GPUDevice): Promise<unknown> {
  const out: Record<string, unknown> = {
    what: 'where the residue comes from, measured before anything is built to remove it',
    where: 'pixels no moving thing touched, which on a photograph is all of them',
    denoise_weight: DENOISE,
    frames: FRAMES,
  };
  for (const subject of SUBJECTS) {
    const conditions: Record<string, unknown> = {};
    for (const condition of CONDITIONS) {
      const rows: Record<string, unknown> = {};
      for (const item of CONTENT_CASES) {
        const row = await overCondition(device, subject, condition, item);
        if (row) rows[item.name] = row;
      }
      if (Object.keys(rows).length > 0) conditions[condition.name] = rows;
    }
    out[subject.name] = conditions;
  }
  return out;
}
