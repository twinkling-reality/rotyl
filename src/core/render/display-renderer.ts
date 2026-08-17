import { FullscreenPass } from '../gpu/fullscreen-pass.ts';
import { imageSamplingUv, type Size, type ViewTransform } from '../view/view-transform.ts';
import type { Dimensions } from './resolution.ts';
import displayWgsl from './wgsl/display.wgsl?raw';

export interface OverlayState {
  /** How strongly unselected area is lifted toward paper, 0..1. */
  readonly lift: number;
  /** Opacity of the selection contour, 0..1. */
  readonly contour: number;
}

export const OVERLAY_VISIBLE: OverlayState = { lift: 1, contour: 1 };
export const OVERLAY_HIDDEN: OverlayState = { lift: 0, contour: 0 };

/** Contour radii in device pixels; the shader keeps them screen-space via fwidth. */
const CASING_RADIUS = 2.4;
const CORE_RADIUS = 1.1;

/**
 * Draws the composited image onto the canvas through the view transform, and
 * overlays the selection.
 *
 * Kept separate from the composite for two reasons. It reads the composite's
 * already-encoded output as raw sRGB bytes and writes without re-encoding, so
 * the overlay constants are applied in the space they were tuned in; and
 * because it is the only pass panning and zooming affect, navigating the image
 * costs one fullscreen pass rather than the whole style chain.
 */
export class DisplayRenderer {
  readonly #device: GPUDevice;
  readonly #pass: FullscreenPass;
  readonly #layout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;
  readonly #uniforms: GPUBuffer;
  readonly #background: readonly [number, number, number];

  constructor(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    background: readonly [number, number, number],
  ) {
    this.#device = device;
    this.#background = background;
    this.#sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.#uniforms = device.createBuffer({
      label: 'display-uniforms',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    this.#pass = new FullscreenPass({
      label: 'display',
      device,
      fragmentWgsl: displayWgsl,
      bindGroupLayout: this.#layout,
      targetFormat: canvasFormat,
    });
  }

  render(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    compositeTexture: GPUTexture,
    maskTexture: GPUTexture,
    imageSize: Dimensions,
    canvasSize: Size,
    view: ViewTransform,
    overlay: OverlayState,
  ): void {
    const { scale, offset } = imageSamplingUv(view, canvasSize, imageSize);
    const [r, g, b] = this.#background;

    this.#device.queue.writeBuffer(
      this.#uniforms,
      0,
      new Float32Array([
        scale.x,
        scale.y,
        offset.x,
        offset.y,
        r,
        g,
        b,
        overlay.lift,
        overlay.contour,
        CASING_RADIUS,
        CORE_RADIUS,
        0,
      ]),
    );

    const bindGroup = this.#device.createBindGroup({
      layout: this.#layout,
      entries: [
        // A plain (non-sRGB) view: the composite is already encoded, and the
        // overlay maths below is defined in that space.
        { binding: 0, resource: compositeTexture.createView() },
        { binding: 1, resource: maskTexture.createView() },
        { binding: 2, resource: this.#sampler },
        { binding: 3, resource: { buffer: this.#uniforms } },
      ],
    });

    this.#pass.run(encoder, targetView, bindGroup);
  }

  dispose(): void {
    this.#uniforms.destroy();
  }
}
