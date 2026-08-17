/**
 * The three coordinate spaces, and the conversions between them.
 *
 *   screen  CSS pixels, what pointer events carry
 *   canvas  device pixels, the size of the WebGPU backing store
 *   image   source pixels, where the selection mask lives
 *
 * The load-bearing invariant: nothing downstream of the input handler ever
 * sees a screen coordinate. Pointer positions are converted once, at the event
 * boundary, and every stroke point stored by the document is already in image
 * space. That is what keeps a selection aligned when the window resizes, when
 * the style panel opens, when the user zooms, and when export renders at a
 * different resolution than the preview.
 *
 * The view is stored as zoom + centre rather than as a matrix because those are
 * the two quantities the interaction actually manipulates; `imageSamplingUv`
 * derives what the shader needs. Rotation would arrive as a third field here
 * and a rotated basis there, without changing any caller.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface ViewTransform {
  /** Canvas (device) pixels per image pixel. */
  readonly zoom: number;
  /** The image-space point displayed at the centre of the canvas. */
  readonly center: Vec2;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Canvas (device px) -> image px. */
export function canvasToImage(view: ViewTransform, canvas: Size, point: Vec2): Vec2 {
  return {
    x: (point.x - canvas.width / 2) / view.zoom + view.center.x,
    y: (point.y - canvas.height / 2) / view.zoom + view.center.y,
  };
}

/** Image px -> canvas (device px). */
export function imageToCanvas(view: ViewTransform, canvas: Size, point: Vec2): Vec2 {
  return {
    x: (point.x - view.center.x) * view.zoom + canvas.width / 2,
    y: (point.y - view.center.y) * view.zoom + canvas.height / 2,
  };
}

/**
 * Screen (CSS px, client coordinates) -> canvas (device px).
 *
 * Derived from the measured element rect rather than from devicePixelRatio, so
 * it stays correct under browser zoom, fractional DPR, and any CSS sizing the
 * layout applies to the canvas element.
 */
export function screenToCanvas(
  clientPoint: Vec2,
  rect: { left: number; top: number; width: number; height: number },
  canvas: Size,
): Vec2 {
  // A zero-width rect happens for one frame while the canvas is being laid
  // out; mapping through it would produce Infinity and poison a stroke.
  const sx = rect.width > 0 ? canvas.width / rect.width : 1;
  const sy = rect.height > 0 ? canvas.height / rect.height : 1;
  return {
    x: (clientPoint.x - rect.left) * sx,
    y: (clientPoint.y - rect.top) * sy,
  };
}

/**
 * Zoom about a fixed canvas point, without drift.
 *
 * Solved rather than approximated: the image-space point under the cursor is
 * required to be identical before and after, so repeated zoom in/out returns
 * exactly where it started instead of creeping.
 */
export function zoomAbout(
  view: ViewTransform,
  canvas: Size,
  anchorCanvas: Vec2,
  factor: number,
): ViewTransform {
  const zoom = clampZoom(view.zoom * factor);
  if (zoom === view.zoom) return view;

  const before = canvasToImage(view, canvas, anchorCanvas);
  const after = canvasToImage({ zoom, center: view.center }, canvas, anchorCanvas);
  return {
    zoom,
    center: {
      x: view.center.x + before.x - after.x,
      y: view.center.y + before.y - after.y,
    },
  };
}

/** Pan by a canvas-space delta. */
export function panBy(view: ViewTransform, deltaCanvas: Vec2): ViewTransform {
  return {
    zoom: view.zoom,
    center: {
      x: view.center.x - deltaCanvas.x / view.zoom,
      y: view.center.y - deltaCanvas.y / view.zoom,
    },
  };
}

/** The view that fits `image` inside `canvas` with `padding` device px of margin. */
export function fitToCanvas(image: Size, canvas: Size, padding = 0): ViewTransform {
  const available = {
    width: Math.max(1, canvas.width - padding * 2),
    height: Math.max(1, canvas.height - padding * 2),
  };
  const zoom =
    image.width > 0 && image.height > 0
      ? clampZoom(Math.min(available.width / image.width, available.height / image.height))
      : 1;
  return { zoom, center: { x: image.width / 2, y: image.height / 2 } };
}

/**
 * The scale/offset the display shader needs to turn a canvas UV into an image
 * UV, so the whole view is one fullscreen pass with no geometry.
 *
 *   imageUv = canvasUv * scale + offset
 */
export function imageSamplingUv(
  view: ViewTransform,
  canvas: Size,
  image: Size,
): { scale: Vec2; offset: Vec2 } {
  const scale = {
    x: canvas.width / (view.zoom * image.width),
    y: canvas.height / (view.zoom * image.height),
  };
  const offset = {
    x: (view.center.x - canvas.width / (2 * view.zoom)) / image.width,
    y: (view.center.y - canvas.height / (2 * view.zoom)) / image.height,
  };
  return { scale, offset };
}
