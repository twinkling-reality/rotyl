import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import type { CoverageMask } from '../core/document/selection-command.ts';
import type { MaskCandidate } from '../core/perception/mask-candidates.ts';

/**
 * The other objects the click could have meant.
 *
 * A point on a sleeve is a cuff, a shirt and a person, and the model says so.
 * it returns all three and rates one highest. Everything up to here has kept
 * those alternatives; this is where they become visible, and it is most of what
 * separates click-to-select that feels like it read your mind from one that
 * feels like a coin toss.
 *
 * EACH ONE SHOWS ITS OWN MASK rather than a dot or a word. "Smaller" and
 * "larger" are true but useless when the difference is a sleeve against a
 * person; the silhouette is the only description that answers the question
 * being asked, and it costs a 26 px canvas.
 *
 * Nothing appears when the engine had only one reading. A single button implies
 * a choice that is not there.
 */

export interface CandidatePickerProps {
  /** Smallest first, as the perception store orders them. */
  readonly candidates: readonly MaskCandidate[];
  readonly chosen: number | undefined;
  /** Width over height of the photograph, so a thumbnail is not distorted. */
  readonly aspect: number;
  readonly onChoose: (rank: number) => void;
}

/** Long edge of a thumbnail, in CSS pixels. */
const THUMB = 30;

/** The mask, drawn dark enough to read against the panel behind it. */
const INK = 26;

/** Coverage at or above this is inside, matching how the candidates are ordered. */
const SOLID = 128;

/** Fraction of the crop left as margin, so a silhouette is not cut off at its own edge. */
const CROP_PADDING = 0.12;

/**
 * Smallest crop worth showing, as a fraction of the frame.
 *
 * Without it a click on something tiny fills the thumbnail with one blob at
 * enormous magnification, which says nothing about what was selected.
 */
const MIN_CROP = 0.16;

/** A region of the frame, normalised. */
interface Crop {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

function thumbBox(aspect: number): { readonly width: number; readonly height: number } {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return safe >= 1
    ? { width: THUMB, height: Math.max(10, Math.round(THUMB / safe)) }
    : { width: Math.max(10, Math.round(THUMB * safe)), height: THUMB };
}

/**
 * The region all the candidates live in, shared by all of them.
 *
 * Shared, not per candidate, and that is the whole trick: a thumbnail of the
 * whole photograph renders anything smaller than a car as three indistinguishable
 * specks, while cropping each candidate to its own bounds would show three
 * silhouettes at three magnifications and destroy the one comparison being
 * offered. One crop keeps the sizes honest and makes the shapes legible.
 */
function sharedCrop(masks: readonly CoverageMask[]): Crop {
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;

  for (const mask of masks) {
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        if ((mask.coverage[y * mask.width + x] ?? 0) < SOLID) continue;
        x0 = Math.min(x0, x / mask.width);
        y0 = Math.min(y0, y / mask.height);
        x1 = Math.max(x1, (x + 1) / mask.width);
        y1 = Math.max(y1, (y + 1) / mask.height);
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) return { x0: 0, y0: 0, x1: 1, y1: 1 };

  const grow = (low: number, high: number): readonly [number, number] => {
    const span = Math.max(high - low, MIN_CROP) * (1 + CROP_PADDING * 2);
    const middle = (low + high) / 2;
    // Slid back inside the frame rather than clipped, so a subject against an
    // edge keeps the margin it needs to read as a shape.
    const start = Math.min(Math.max(middle - span / 2, 0), Math.max(0, 1 - span));
    return [start, Math.min(1, start + span)];
  };

  const [left, right] = grow(x0, x1);
  const [top, bottom] = grow(y0, y1);
  return { x0: left, y0: top, x1: right, y1: bottom };
}

/**
 * Box-average a crop of the engine's mask down to thumbnail size.
 *
 * Averaging rather than sampling because the interesting candidates are often
 * thin, an arm, a railing, and a nearest tap drops them entirely at this
 * scale, turning a real alternative into an apparently empty button.
 */
function drawMask(canvas: HTMLCanvasElement, mask: CoverageMask, crop: Crop): void {
  const context = canvas.getContext('2d');
  if (!context || mask.width === 0 || mask.height === 0) return;

  const { width, height } = canvas;
  const image = context.createImageData(width, height);
  const source = {
    left: crop.x0 * mask.width,
    top: crop.y0 * mask.height,
    width: (crop.x1 - crop.x0) * mask.width,
    height: (crop.y1 - crop.y0) * mask.height,
  };

  for (let y = 0; y < height; y++) {
    const top = Math.floor(source.top + (y / height) * source.height);
    const bottom = Math.max(top + 1, Math.floor(source.top + ((y + 1) / height) * source.height));
    for (let x = 0; x < width; x++) {
      const left = Math.floor(source.left + (x / width) * source.width);
      const right = Math.max(left + 1, Math.floor(source.left + ((x + 1) / width) * source.width));

      let total = 0;
      let counted = 0;
      for (let sy = top; sy < Math.min(bottom, mask.height); sy++) {
        for (let sx = left; sx < Math.min(right, mask.width); sx++) {
          total += mask.coverage[sy * mask.width + sx] ?? 0;
          counted++;
        }
      }

      const i = (y * width + x) * 4;
      image.data[i] = INK;
      image.data[i + 1] = INK;
      image.data[i + 2] = INK;
      image.data[i + 3] = counted > 0 ? Math.round(total / counted) : 0;
    }
  }

  context.putImageData(image, 0, 0);
}

function nameFor(rank: number, count: number): string {
  if (count === 2) return rank === 0 ? 'Smaller' : 'Larger';
  if (count === 3) return ['Smallest', 'Middle', 'Largest'][rank] ?? '';
  return `Reading ${String(rank + 1)}`;
}

interface ThumbnailProps {
  readonly mask: CoverageMask;
  readonly crop: Crop;
  readonly shape: { readonly width: number; readonly height: number };
}

function MaskThumbnail({ mask, crop, shape }: ThumbnailProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  // Backed at device resolution: a 30 px silhouette is nearly all edge, and
  // half of it would be a blur.
  const density = Math.min(3, Math.max(1, Math.round(globalThis.devicePixelRatio || 1)));

  useEffect(() => {
    const canvas = ref.current;
    if (canvas) drawMask(canvas, mask, crop);
  }, [mask, crop, shape.width, shape.height, density]);

  return (
    <canvas
      ref={ref}
      class="candidate__thumb"
      width={shape.width * density}
      height={shape.height * density}
      style={{ width: `${String(shape.width)}px`, height: `${String(shape.height)}px` }}
    />
  );
}

export function CandidatePicker({
  candidates,
  chosen,
  aspect,
  onChoose,
}: CandidatePickerProps): JSX.Element | null {
  if (candidates.length < 2) return null;

  const masks = candidates.map((candidate) => candidate.proposal.mask);
  const crop = sharedCrop(masks);
  // The crop's own aspect, not the photograph's: the mask is stored square and
  // stretched over the frame, so a region of it is only undistorted once the
  // image's proportions are put back.
  const shape = thumbBox(((crop.x1 - crop.x0) * aspect) / Math.max(1e-6, crop.y1 - crop.y0));

  return (
    <div class="candidates" role="group" aria-label="What was selected">
      {masks.map((mask, rank) => {
        const name = nameFor(rank, masks.length);
        return (
          <button
            key={rank}
            type="button"
            class={`candidate${rank === chosen ? ' candidate--active' : ''}`}
            aria-pressed={rank === chosen}
            aria-label={name}
            title={name}
            onClick={() => {
              onChoose(rank);
            }}
          >
            <MaskThumbnail mask={mask} crop={crop} shape={shape} />
          </button>
        );
      })}
    </div>
  );
}
