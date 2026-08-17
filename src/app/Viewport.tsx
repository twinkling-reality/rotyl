import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import type { RotylRuntime } from './use-rotyl.ts';
import type { BrushMode } from '../core/render/rotyl-engine.ts';
import { OVERLAY_HIDDEN, OVERLAY_VISIBLE } from '../core/render/display-renderer.ts';
import { canvasToImage, panBy, screenToCanvas, zoomAbout } from '../core/view/view-transform.ts';

export interface ViewportProps {
  readonly runtime: RotylRuntime;
  readonly tool: BrushMode;
  readonly brushRadius: number;
  readonly overlayVisible: boolean;
  /** True while a blocking operation owns the GPU, e.g. an export. */
  readonly paused: boolean;
  /** Increment to refit the image; the only way back from a lost view. */
  readonly fitRequest: number;
  readonly onSelectionChanged: () => void;
  /** Overlaid on the canvas — the toolbar, so it centres on the image. */
  readonly children?: JSX.Element | JSX.Element[];
}

const FIT_PADDING = 48;
const ZOOM_PER_WHEEL_UNIT = 0.0015;

/**
 * The canvas, the render loop, and pointer input.
 *
 * This is the only component that touches the engine every frame, and it does
 * so entirely outside the component lifecycle: pointer samples go straight into
 * the engine and a requestAnimationFrame loop draws. Nothing about a brush
 * stroke passes through component state, because a 120 Hz pointer would then be
 * asking the UI framework to reconcile at 120 Hz — and, more importantly,
 * because a scheduler the renderer does not control would sit in the middle of
 * the one latency path the product is judged on.
 */
export function Viewport({
  runtime,
  tool,
  brushRadius,
  overlayVisible,
  paused,
  fitRequest,
  onSelectionChanged,
  children,
}: ViewportProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);

  // Props the animation frame and event handlers read. Kept in a ref so the
  // listeners can be attached once instead of being torn down on every change.
  const settings = useRef({ tool, brushRadius, overlayVisible, paused, onSelectionChanged });
  settings.current = { tool, brushRadius, overlayVisible, paused, onSelectionChanged };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const { engine, device, canvasFormat } = runtime;
    const context = canvas.getContext('webgpu');
    if (!context) return undefined;
    context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });

    let disposed = false;
    let frame = 0;
    let hasSized = false;

    const draw = (): void => {
      if (disposed) return;
      frame = requestAnimationFrame(draw);
      // An export borrows this renderer and reconfigures its stage buffers;
      // rendering a preview frame into the middle of that is wasted work at
      // best, and it competes for GPU memory at the worst possible moment.
      if (settings.current.paused) return;
      if (!engine.needsRender || canvas.width === 0 || canvas.height === 0) return;

      engine.setOverlay(settings.current.overlayVisible ? OVERLAY_VISIBLE : OVERLAY_HIDDEN);
      engine.render(context.getCurrentTexture().createView(), {
        width: canvas.width,
        height: canvas.height,
      });
    };
    frame = requestAnimationFrame(draw);

    // --- sizing ---
    // devicePixelContentBoxSize gives exact device pixels; deriving them from
    // CSS size times devicePixelRatio accumulates rounding drift, which shows
    // up as a canvas that is one pixel short and an image that shimmers.
    const resize = (entry: ResizeObserverEntry): void => {
      const box = entry.devicePixelContentBoxSize?.[0];
      const width = box ? box.inlineSize : Math.round(entry.contentRect.width * globalThis.devicePixelRatio);
      const height = box ? box.blockSize : Math.round(entry.contentRect.height * globalThis.devicePixelRatio);
      if (width === 0 || height === 0) return;
      if (canvas.width === width && canvas.height === height) return;

      canvas.width = width;
      canvas.height = height;
      if (!hasSized && engine.hasMedia) {
        engine.fitView({ width, height }, FIT_PADDING);
        hasSized = true;
      }
      engine.invalidateDisplay();
    };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) resize(entry);
    });
    observer.observe(canvas, { box: 'device-pixel-content-box' });

    // --- pointer ---
    const toImage = (event: PointerEvent | WheelEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      const canvasSize = { width: canvas.width, height: canvas.height };
      const point = screenToCanvas({ x: event.clientX, y: event.clientY }, rect, canvasSize);
      return canvasToImage(engine.view, canvasSize, point);
    };

    // A stroke keeps the radius it began with, so the ring must show that
    // rather than the live setting while the bracket keys are pressed mid-drag.
    let strokeRadius: number | undefined;

    const setCursorVisible = (visible: boolean): void => {
      const cursor = cursorRef.current;
      if (cursor) cursor.style.opacity = visible ? '1' : '0';
    };
    setCursorVisible(false);

    const moveCursor = (event: PointerEvent): void => {
      const cursor = cursorRef.current;
      if (!cursor) return;
      setCursorVisible(true);
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width > 0 ? canvas.width / rect.width : 1;
      // Radius is stored in image pixels so the brush stays glued to the photo;
      // the ring must therefore be drawn at radius * zoom, in CSS pixels.
      const radius = strokeRadius ?? settings.current.brushRadius;
      const cssRadius = Math.max(5, (radius * engine.view.zoom) / scale);
      cursor.style.width = `${String(cssRadius * 2)}px`;
      cursor.style.height = `${String(cssRadius * 2)}px`;
      cursor.style.transform = `translate3d(${String(event.clientX - rect.left - cssRadius)}px, ${String(
        event.clientY - rect.top - cssRadius,
      )}px, 0)`;
    };

    let panning = false;
    let lastPan = { x: 0, y: 0 };
    // The pointer that owns the current gesture. A second finger or pen landing
    // mid-stroke would otherwise feed its own coordinates into the same stroke,
    // drawing a line between two hands.
    let activePointer: number | undefined;

    const onPointerDown = (event: PointerEvent): void => {
      if (!engine.hasMedia || activePointer !== undefined) return;
      activePointer = event.pointerId;
      canvas.setPointerCapture(event.pointerId);

      // Middle button, or shift held, pans instead of painting.
      if (event.button === 1 || event.shiftKey) {
        panning = true;
        lastPan = { x: event.clientX, y: event.clientY };
        return;
      }
      if (event.button !== 0) {
        activePointer = undefined;
        return;
      }

      strokeRadius = settings.current.brushRadius;
      engine.beginStroke(settings.current.tool, strokeRadius, 0.85, toImage(event));
    };

    const onPointerMove = (event: PointerEvent): void => {
      moveCursor(event);
      if (activePointer !== undefined && event.pointerId !== activePointer) return;

      if (panning) {
        const rect = canvas.getBoundingClientRect();
        const scale = rect.width > 0 ? canvas.width / rect.width : 1;
        engine.setView(
          panBy(engine.view, {
            x: (event.clientX - lastPan.x) * scale,
            y: (event.clientY - lastPan.y) * scale,
          }),
        );
        lastPan = { x: event.clientX, y: event.clientY };
        return;
      }

      if (!engine.isStroking) return;
      // Coalesced events carry every sample the hardware produced since the
      // last frame. Using only the latest turns a fast curve into a polyline.
      const samples = event.getCoalescedEvents?.() ?? [event];
      engine.extendStroke(samples.map((sample) => toImage(sample)));
    };

    const endGesture = (event: PointerEvent): boolean => {
      if (activePointer !== undefined && event.pointerId !== activePointer) return false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      activePointer = undefined;
      panning = false;
      strokeRadius = undefined;
      return true;
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!endGesture(event)) return;
      if (!engine.isStroking) return;
      engine.commitStroke();
      settings.current.onSelectionChanged();
    };

    // A cancelled pointer is the system taking the gesture away — a palm
    // rejection, a scroll takeover. Committing it would record a stroke the
    // user did not finish, so it is discarded.
    const onPointerCancel = (event: PointerEvent): void => {
      if (!endGesture(event)) return;
      engine.cancelStroke();
    };

    const onWheel = (event: WheelEvent): void => {
      if (!engine.hasMedia) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const canvasSize = { width: canvas.width, height: canvas.height };
      const anchor = screenToCanvas({ x: event.clientX, y: event.clientY }, rect, canvasSize);
      engine.setView(
        zoomAbout(engine.view, canvasSize, anchor, Math.exp(-event.deltaY * ZOOM_PER_WHEEL_UNIT)),
      );
    };

    const onPointerLeave = (): void => {
      setCursorVisible(false);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [runtime]);

  // Refit on request. Panning has no bounds by design — dragging past the edge
  // is useful when working near a corner — so there has to be a way back.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || fitRequest === 0) return;
    runtime.engine.fitView({ width: canvas.width, height: canvas.height }, FIT_PADDING);
  }, [runtime, fitRequest]);

  return (
    <div class="viewport">
      <canvas ref={canvasRef} class="viewport__canvas viewport__canvas--brushing" />
      <div ref={cursorRef} class="brush-cursor" aria-hidden="true" />
      {children}
    </div>
  );
}
