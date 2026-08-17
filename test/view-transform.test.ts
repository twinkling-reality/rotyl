import { describe, expect, it } from 'vitest';
import {
  canvasToImage,
  fitToCanvas,
  imageSamplingUv,
  imageToCanvas,
  panBy,
  screenToCanvas,
  zoomAbout,
  type ViewTransform,
} from '../src/core/view/view-transform.ts';

const canvas = { width: 800, height: 600 };
const view: ViewTransform = { zoom: 1.5, center: { x: 320, y: 240 } };

describe('coordinate spaces', () => {
  it('round-trips canvas and image', () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: 400, y: 300 },
      { x: 799, y: 599 },
      { x: -50, y: 1200 },
    ]) {
      const image = canvasToImage(view, canvas, point);
      const back = imageToCanvas(view, canvas, image);
      expect(back.x).toBeCloseTo(point.x, 9);
      expect(back.y).toBeCloseTo(point.y, 9);
    }
  });

  it('maps the canvas centre to the view centre', () => {
    const image = canvasToImage(view, canvas, { x: 400, y: 300 });
    expect(image.x).toBeCloseTo(320, 9);
    expect(image.y).toBeCloseTo(240, 9);
  });

  it('derives the canvas scale from the measured rect, not devicePixelRatio', () => {
    // A canvas laid out at 400 CSS px with an 800 px backing store: every
    // client coordinate must double, whatever the device pixel ratio claims.
    const point = screenToCanvas({ x: 100, y: 50 }, { left: 0, top: 0, width: 400, height: 300 }, canvas);
    expect(point).toEqual({ x: 200, y: 100 });
  });

  it('survives a zero-sized rect during layout', () => {
    const point = screenToCanvas({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 0 }, canvas);
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });
});

describe('zoom about a point', () => {
  it('holds the anchored image point exactly still', () => {
    const anchor = { x: 610, y: 130 };
    const before = canvasToImage(view, canvas, anchor);
    const zoomed = zoomAbout(view, canvas, anchor, 2.5);
    const after = canvasToImage(zoomed, canvas, anchor);

    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('does not drift over repeated in-and-out cycles', () => {
    const anchor = { x: 137, y: 451 };
    let current = view;
    for (let i = 0; i < 60; i++) {
      current = zoomAbout(current, canvas, anchor, 1.2);
      current = zoomAbout(current, canvas, anchor, 1 / 1.2);
    }
    expect(current.zoom).toBeCloseTo(view.zoom, 6);
    expect(current.center.x).toBeCloseTo(view.center.x, 4);
    expect(current.center.y).toBeCloseTo(view.center.y, 4);
  });

  it('clamps rather than running away', () => {
    let current = view;
    for (let i = 0; i < 200; i++) current = zoomAbout(current, canvas, { x: 0, y: 0 }, 2);
    expect(current.zoom).toBeLessThanOrEqual(64);

    for (let i = 0; i < 400; i++) current = zoomAbout(current, canvas, { x: 0, y: 0 }, 0.5);
    expect(current.zoom).toBeGreaterThanOrEqual(0.02);
  });
});

describe('pan', () => {
  it('moves the image with the pointer, in image units', () => {
    const panned = panBy(view, { x: 30, y: -15 });
    expect(panned.center.x).toBeCloseTo(320 - 30 / 1.5, 9);
    expect(panned.center.y).toBeCloseTo(240 + 15 / 1.5, 9);
  });
});

describe('fit', () => {
  it('fits the whole image inside the canvas with padding', () => {
    const fitted = fitToCanvas({ width: 4000, height: 3000 }, canvas, 48);
    const corner = imageToCanvas(fitted, canvas, { x: 0, y: 0 });
    const far = imageToCanvas(fitted, canvas, { x: 4000, y: 3000 });

    expect(corner.x).toBeGreaterThanOrEqual(48 - 0.001);
    expect(corner.y).toBeGreaterThanOrEqual(48 - 0.001);
    expect(far.x).toBeLessThanOrEqual(canvas.width - 48 + 0.001);
    expect(far.y).toBeLessThanOrEqual(canvas.height - 48 + 0.001);
  });

  it('centres the image', () => {
    const fitted = fitToCanvas({ width: 4000, height: 3000 }, canvas);
    expect(fitted.center).toEqual({ x: 2000, y: 1500 });
  });

  it('does not divide by zero on a degenerate image', () => {
    expect(fitToCanvas({ width: 0, height: 0 }, canvas).zoom).toBe(1);
  });
});

describe('shader sampling transform', () => {
  it('agrees with the CPU coordinate conversion at the canvas corners', () => {
    const image = { width: 1600, height: 1200 };
    const { scale, offset } = imageSamplingUv(view, canvas, image);

    for (const canvasPoint of [
      { x: 0, y: 0 },
      { x: canvas.width, y: canvas.height },
      { x: 250, y: 410 },
    ]) {
      const uv = { x: canvasPoint.x / canvas.width, y: canvasPoint.y / canvas.height };
      const fromShader = { x: uv.x * scale.x + offset.x, y: uv.y * scale.y + offset.y };
      const fromCpu = canvasToImage(view, canvas, canvasPoint);

      expect(fromShader.x * image.width).toBeCloseTo(fromCpu.x, 6);
      expect(fromShader.y * image.height).toBeCloseTo(fromCpu.y, 6);
    }
  });
});
