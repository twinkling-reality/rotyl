import { beforeAll, describe, expect, it } from 'vitest';
import { disposeWithTestDevice, testDevice, writeTextureRgba } from './gpu-harness.ts';
import { SelectionMask } from '../src/core/mask/selection-mask.ts';
import { MaskRefiner } from '../src/core/mask/mask-refiner.ts';
import { DEFAULT_REFINE_SETTINGS, resolveRefineParams } from '../src/core/mask/refine-params.ts';
import { SOURCE_FORMAT, SOURCE_VIEW_FORMAT } from '../src/core/gpu/formats.ts';
import { packCoverage, type CoverageMask } from '../src/core/document/coverage-mask.ts';
import { linearToSrgb } from '../src/core/color/srgb.ts';
import { linearToOklab } from '../src/core/color/oklab.ts';

/**
 * The bridge from a segmentation engine to the render mask, on real hardware.
 *
 * The claim under test is the reason the bridge exists: an engine mask is 256 px
 * square whatever the photograph is, so its boundary is wrong by many image
 * pixels before anything else happens, and magnifying it cannot fix that
 * because magnification has no idea where the edge is. Refinement does, because
 * it reads the image.
 *
 * THE GEOMETRY IS DELIBERATE. What decides whether the filter has any room to
 * work is the ratio between its window and one engine texel, and because the
 * window is a fraction of the image while the engine mask is a fixed 256 px,
 * that ratio is a constant, about six, however large the photograph is. A
 * test using a smaller engine mask would quietly change that constant and
 * measure a filter the product never runs.
 *
 * EVERY RENDER HAPPENS IN ONE PHASE, before any case runs, and the cases only
 * read the numbers. That is not tidiness. Spreading GPU work across separate
 * `it` blocks aborted the Dawn Node worker perhaps half the time, always at a
 * test boundary and never with an error scope catching anything; browsers show
 * none of it. Measuring once and asserting many times is also the honest shape
 * for this file, which is a measurement rather than a set of independent cases.
 */

const SIZE = 1024;
const COARSE_SIZE = 256;
/** Where the photograph's edge is. */
const TRUE_EDGE = 512;
/**
 * Where the engine put it: two engine texels out.
 *
 * MEASURED REACH, on the case below, as boundary error in image pixels:
 *
 *   engine error   1 texel   2      3      4      6      8
 *   magnified       3.5      7.5   11.5   15.5   23.5   31.5
 *   refined        -0.5     -0.4    4.6   11.0   21.8   31.0
 *
 * So the filter erases the error outright up to about two engine texels,
 * recovers most of a three-texel error, and gives up past four, which is what
 * the window predicts, since it spans about six engine texels and the fit is
 * dominated by the coarse boundary once the error approaches that. Two texels
 * is where a segmentation model's boundary actually sits, and it is also the
 * quantisation the 256 px grid imposes on any photograph larger than that.
 */
const COARSE_EDGE = 520;

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const encode = (c: number): number => Math.round(linearToSrgb(c) * 255);
const luminance = (c: Rgb): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Neighbours differing only in hue, matched in Rec709 luminance. */
const CHROMA_LEFT: Rgb = { r: 0.8, g: 0.15, b: 0.05 };
const CHROMA_RIGHT: Rgb = { r: 0.05, g: 0.3, b: 0.7726 };
const DARK: Rgb = { r: 0.03, g: 0.03, b: 0.035 };
const LIGHT: Rgb = { r: 0.75, g: 0.78, b: 0.8 };

/** Landing this close counts as "on the edge" for a 1024 px image. */
const ON_EDGE = 2;

/** A vertical edge at TRUE_EDGE, defined in linear light and stored as sRGB. */
function twoToneImage(left: Rgb, right: Rgb): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const bytes = (c: Rgb): readonly number[] => [encode(c.r), encode(c.g), encode(c.b), 255];
  const leftBytes = bytes(left);
  const rightBytes = bytes(right);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      pixels.set(x < TRUE_EDGE ? leftBytes : rightBytes, (y * SIZE + x) * 4);
    }
  }
  return pixels;
}

/** An engine mask covering the left region, with its boundary in the wrong place. */
function coarseMask(): CoverageMask {
  const coverage = new Uint8Array(COARSE_SIZE * COARSE_SIZE);
  const scale = SIZE / COARSE_SIZE;
  for (let y = 0; y < COARSE_SIZE; y++) {
    for (let x = 0; x < COARSE_SIZE; x++) {
      coverage[y * COARSE_SIZE + x] = (x + 0.5) * scale < COARSE_EDGE ? 255 : 0;
    }
  }
  return packCoverage(COARSE_SIZE, COARSE_SIZE, coverage);
}

/**
 * Where coverage crosses half, to sub-pixel precision.
 *
 * Interpolating between the bracketing samples rather than returning the first
 * one under the threshold is what makes a soft ramp and a firm step
 * comparable: they can share an integer crossing and still sit a pixel apart.
 */
function halfCoverageCrossing(row: Uint8Array): number {
  for (let x = 1; x < row.length; x++) {
    const previous = row[x - 1] ?? 0;
    const current = row[x] ?? 0;
    if (previous >= 128 && current < 128) {
      return x - 1 + (previous - 128) / Math.max(1, previous - current);
    }
  }
  return Number.NaN;
}

interface Boundary {
  readonly crossing: number;
  /** Samples that are neither fully in nor fully out: the antialias ramp. */
  readonly partial: number;
}

interface Measurements {
  readonly luminanceEdge: { readonly refined: Boundary; readonly magnified: Boundary };
  readonly chromaEdge: { readonly refined: Boundary };
  readonly flatField: { readonly refined: Boundary; readonly magnified: Boundary };
}

let measurements: Measurements;

beforeAll(async () => {
  const { device } = await testDevice();
  const refiner = new MaskRefiner(device);
  const selection = new SelectionMask(device, SIZE, SIZE, SIZE, SIZE);
  const source = device.createTexture({
    label: 'refine-test-source',
    size: { width: SIZE, height: SIZE },
    format: SOURCE_FORMAT,
    viewFormats: [SOURCE_VIEW_FORMAT],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const guideView = source.createView({ format: SOURCE_VIEW_FORMAT });
  const bytesPerRow = Math.ceil(SIZE / 256) * 256;
  const staging = device.createBuffer({
    size: bytesPerRow * (SIZE - 1) + SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  disposeWithTestDevice(() => {
    refiner.dispose();
    selection.dispose();
    source.destroy();
    staging.destroy();
  });

  const context = { refiner, guideView, guideSize: { width: SIZE, height: SIZE } };
  const mask = coarseMask();

  const boundaryOf = async (refine: boolean): Promise<Boundary> => {
    selection.beginFrame();
    refiner.beginFrame();
    const encoder = device.createCommandEncoder();
    selection.replay(
      encoder,
      [
        {
          kind: 'applyMask',
          mask,
          op: 'replace',
          frame: 0,
          ...(refine ? { refine: DEFAULT_REFINE_SETTINGS } : {}),
        },
      ],
      context,
    );
    encoder.copyTextureToBuffer(
      { texture: selection.texture },
      { buffer: staging, bytesPerRow },
      { width: SIZE, height: SIZE },
    );
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(staging.getMappedRange()).slice();
    staging.unmap();

    const middle = SIZE / 2;
    const row = padded.subarray(middle * bytesPerRow, middle * bytesPerRow + SIZE);
    return {
      crossing: halfCoverageCrossing(row),
      partial: [...row].filter((value) => value > 8 && value < 247).length,
    };
  };

  const both = async (left: Rgb, right: Rgb): Promise<{ refined: Boundary; magnified: Boundary }> => {
    writeTextureRgba(device, source, SIZE, SIZE, twoToneImage(left, right));
    return { refined: await boundaryOf(true), magnified: await boundaryOf(false) };
  };

  const luminanceEdge = await both(DARK, LIGHT);
  writeTextureRgba(device, source, SIZE, SIZE, twoToneImage(CHROMA_LEFT, CHROMA_RIGHT));
  const chromaEdge = { refined: await boundaryOf(true) };
  const flatField = await both(DARK, DARK);

  measurements = { luminanceEdge, chromaEdge, flatField };
});

describe('engine mask refinement', () => {
  it('moves the boundary from where the engine put it to where the image edge is', () => {
    const { refined, magnified } = measurements.luminanceEdge;

    // Magnification can only reproduce the engine's own boundary, so it lands
    // well inside the wrong region and stays there.
    expect(Math.abs(magnified.crossing - TRUE_EDGE)).toBeGreaterThan(5);
    expect(Math.abs(magnified.crossing - COARSE_EDGE)).toBeLessThan(ON_EDGE);

    expect(Math.abs(refined.crossing - TRUE_EDGE)).toBeLessThan(ON_EDGE);
  });

  it('follows an edge with no luminance step, which a scalar guide cannot see', () => {
    // Same brightness, different hue. A luminance guide is flat across this
    // edge, so a filter built on one would smear the boundary straight through
    // it; the three-channel guide sees it.
    expect(Math.abs(luminance(CHROMA_LEFT) - luminance(CHROMA_RIGHT))).toBeLessThan(0.01);
    expect(Math.abs(measurements.chromaEdge.refined.crossing - TRUE_EDGE)).toBeLessThan(ON_EDGE);
  });

  it('leaves the boundary where it was when the image gives no reason to move it', () => {
    // A uniform field. There is no edge to snap to, so the fit degenerates to
    // passing the coarse mask through rather than inventing a boundary.
    const { refined, magnified } = measurements.flatField;
    expect(Math.abs(refined.crossing - magnified.crossing)).toBeLessThan(6);
  });

  it('produces an antialiased edge rather than a binary one', () => {
    // The brush guarantees a coverage ramp so that no stage downstream has to
    // feather anything; refinement has to hold the same guarantee, or engine
    // selections would be the one kind with a staircase along them.
    const { partial } = measurements.luminanceEdge.refined;
    expect(partial).toBeGreaterThan(0);
    // ...without the ramp being so wide that the selection reads as blurred.
    expect(partial).toBeLessThan(24);
  });
});

describe('refinement parameters', () => {
  it('holds the window at a fixed fraction of the image across output sizes', () => {
    // The property that makes preview and export agree, checked exactly rather
    // than inferred from two renders.
    for (const shortEdge of [512, 1024, 2048, 4096, 6000]) {
      const params = resolveRefineParams(DEFAULT_REFINE_SETTINGS, shortEdge);
      expect(params.radius / params.workingShortEdge).toBeCloseTo(DEFAULT_REFINE_SETTINGS.windowFraction, 10);
    }
  });

  it('never computes statistics below the resolution the engine already supplied', () => {
    // Below 256 the filter would be discarding detail the engine produced, and
    // no amount of edge-aware upsampling afterwards can bring it back.
    expect(resolveRefineParams(DEFAULT_REFINE_SETTINGS, 64).workingShortEdge).toBeGreaterThanOrEqual(256);
  });
});

describe('the guide colour space', () => {
  it('separates the equal-luminance pair that Rec709 collapses', () => {
    // Why the guide is Oklab and not luminance, as a number: these two colours
    // are indistinguishable to a luminance guide and far apart perceptually.
    const left = linearToOklab(CHROMA_LEFT);
    const right = linearToOklab(CHROMA_RIGHT);
    expect(Math.hypot(left.L - right.L, left.a - right.a, left.b - right.b)).toBeGreaterThan(0.2);
  });
});
