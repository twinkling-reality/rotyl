import { FullscreenPass } from '../gpu/fullscreen-pass.ts';
import { OUTPUT_VIEW_FORMAT, SOURCE_VIEW_FORMAT } from '../gpu/formats.ts';
import { ComicStylePipeline } from '../style/comic-style-pipeline.ts';
import { resolveComicParams, type ComicControls, type StyleQuality } from '../style/comic-params.ts';
import type { Dimensions } from './resolution.ts';
import { shortEdge } from './resolution.ts';
import colorWgsl from '../style/wgsl/color.wgsl?raw';
import compositeWgsl from './wgsl/composite.wgsl?raw';

export interface CompositeRequest {
  /** rgba8unorm, created with SOURCE_VIEW_FORMAT in viewFormats. */
  readonly sourceTexture: GPUTexture;
  readonly sourceSize: Dimensions;
  readonly outputSize: Dimensions;
  readonly maskTexture: GPUTexture;
  readonly controls: ComicControls;
  readonly quality: StyleQuality;
}

/**
 * Style chain plus composite, producing the image that export writes and the
 * display pass shows.
 *
 * Used by both paths with the same code and the same parameters, which is what
 * makes "export matches preview" structural rather than a property to test for
 * and hope holds. Export differs only in output resolution and quality tier,
 * and both of those are defined to leave composition unchanged.
 */
export class CompositeRenderer {
  readonly #device: GPUDevice;
  readonly #style: ComicStylePipeline;
  readonly #pass: FullscreenPass;
  readonly #layout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;
  readonly #uniforms: GPUBuffer;

  #styledCache: GPUTexture | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#style = new ComicStylePipeline(device);
    this.#sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.#uniforms = device.createBuffer({
      label: 'composite-uniforms',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    this.#pass = new FullscreenPass({
      label: 'composite',
      device,
      fragmentWgsl: `${colorWgsl}\n${compositeWgsl}`,
      bindGroupLayout: this.#layout,
      // Written through an sRGB view: the hardware performs the linear -> sRGB
      // encode, so the stored bytes match the source exactly wherever coverage
      // is zero.
      targetFormat: OUTPUT_VIEW_FORMAT,
    });
  }

  /**
   * Re-run the style chain. Expensive; the result is cached until the source or
   * the style controls change — notably NOT when the selection changes, which
   * is why brushing stays responsive.
   */
  renderStyle(encoder: GPUCommandEncoder, request: CompositeRequest): void {
    const params = resolveComicParams(request.controls, shortEdge(request.outputSize), request.quality);
    this.#styledCache = this.#style.render(
      encoder,
      request.sourceTexture.createView({ format: SOURCE_VIEW_FORMAT }),
      request.sourceSize,
      request.outputSize,
      params,
    );
  }

  /**
   * Blend the cached styled layer into the source through the mask.
   *
   * One pass over the output. This is what re-runs on every brush movement.
   */
  composite(encoder: GPUCommandEncoder, request: CompositeRequest, targetView: GPUTextureView): void {
    const styled = this.#styledCache;
    if (!styled) throw new Error('CompositeRenderer: renderStyle() must run before composite()');

    const params = resolveComicParams(request.controls, shortEdge(request.outputSize), request.quality);
    this.#device.queue.writeBuffer(this.#uniforms, 0, new Float32Array([params.styleMix, 0, 0, 0]));

    const bindGroup = this.#device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: request.sourceTexture.createView({ format: SOURCE_VIEW_FORMAT }) },
        { binding: 1, resource: styled.createView() },
        { binding: 2, resource: request.maskTexture.createView() },
        { binding: 3, resource: this.#sampler },
        { binding: 4, resource: { buffer: this.#uniforms } },
      ],
    });

    this.#pass.run(encoder, targetView, bindGroup);
  }

  dispose(): void {
    this.#style.dispose();
    this.#uniforms.destroy();
    this.#styledCache = undefined;
  }
}
