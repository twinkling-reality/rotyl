import { FullscreenPass } from '../gpu/fullscreen-pass.ts';
import { DeferredRelease } from '../gpu/resource-pool.ts';
import { OUTPUT_VIEW_FORMAT, SOURCE_FORMAT, SOURCE_VIEW_FORMAT } from '../gpu/formats.ts';
import type {
  StyleControls,
  StyleDefinition,
  StylePipeline,
  StyleQuality,
  StyledLayer,
} from '../style/style.ts';
import type { Dimensions } from './resolution.ts';
import colorWgsl from '../color/color.wgsl?raw';
import compositeWgsl from './wgsl/composite.wgsl?raw';

/**
 * How the composite samples a styled layer.
 *
 * Style chains write linear working buffers. A hosted still is an 8-bit sRGB
 * JPEG uploaded as rgba8unorm, so it has to be decoded at sample time or the
 * mix happens in the wrong space and the selection reads as a pasted sticker.
 */
function layerView(texture: GPUTexture): GPUTextureView {
  return texture.format === SOURCE_FORMAT
    ? texture.createView({ format: SOURCE_VIEW_FORMAT })
    : texture.createView();
}

export interface StyleRequest {
  /** rgba8unorm, created with SOURCE_VIEW_FORMAT in viewFormats. */
  readonly sourceTexture: GPUTexture;
  readonly sourceSize: Dimensions;
  readonly outputSize: Dimensions;
  readonly style: StyleDefinition;
  readonly controls: StyleControls;
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
 *
 * NOTHING HERE KNOWS WHICH STYLE IS RUNNING. A style hands back a texture and a
 * mix; the composite reads the mask and blends. That is the whole seam, and it
 * is why a second style needed no change to this file.
 */
export class CompositeRenderer {
  readonly #device: GPUDevice;
  readonly #pass: FullscreenPass;
  readonly #layout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;
  readonly #uniforms: GPUBuffer;
  readonly #retired: DeferredRelease;

  #active: { readonly id: string; readonly pipeline: StylePipeline } | undefined;
  #layer: StyledLayer | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#retired = new DeferredRelease(device);
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
   * The pipeline for a style, built on first use and kept until the style
   * changes.
   *
   * Only one is held. A style's stage buffers include a styled layer at output
   * resolution, which is 192 MB for a 24 megapixel photograph, so keeping every
   * style ever selected resident to save a few milliseconds of pipeline
   * creation is the wrong trade by two orders of magnitude.
   *
   * The outgoing pipeline is released on the queue rather than immediately: the
   * frame that last used it has been submitted, and a submitted frame's
   * resources are read at submit rather than at record. The frame being
   * recorded when a switch happens does not reference it. That is what makes
   * fencing here, rather than one frame later, correct.
   */
  #pipelineFor(style: StyleDefinition): StylePipeline {
    const active = this.#active;
    if (active && active.id === style.id) return active.pipeline;

    if (active) {
      this.#layer = undefined;
      this.#retired.after(() => active.pipeline.dispose());
    }

    const pipeline = style.create(this.#device);
    this.#active = { id: style.id, pipeline };
    return pipeline;
  }

  /**
   * Re-run the style chain. Expensive; the result is cached until the source,
   * the style or its controls change. Notably NOT when the selection changes,
   * which is why brushing stays responsive.
   */
  renderStyle(encoder: GPUCommandEncoder, request: StyleRequest): void {
    this.#layer = this.#pipelineFor(request.style).render(
      encoder,
      request.sourceTexture.createView({ format: SOURCE_VIEW_FORMAT }),
      request.sourceSize,
      request.outputSize,
      request.controls,
      request.quality,
    );
  }

  /**
   * Use a layer that was not produced by a style chain.
   *
   * The hosted illustrated still is the only caller. It is a texture and a mix,
   * which is all the composite knows how to read. A style pipeline already
   * resident is left alone: clearing the illustrated layer has to be able to
   * go back to Comic without rebuilding that chain.
   *
   * An 8-bit still is sRGB-encoded, so composite() samples it through an sRGB
   * view. A style's working buffer is already linear and keeps its own view.
   */
  adoptLayer(texture: GPUTexture, mix: number): void {
    this.#layer = { texture, mix };
  }

  /**
   * Blend the cached styled layer into the source through the mask.
   *
   * One pass over the output. This is what re-runs on every brush movement.
   *
   * The mask texture is passed rather than remembered because its identity can
   * change between frames: a whole-mask operation such as invert ping-pongs
   * between two targets.
   */
  composite(
    encoder: GPUCommandEncoder,
    sourceTexture: GPUTexture,
    maskTexture: GPUTexture,
    targetView: GPUTextureView,
  ): void {
    const layer = this.#layer;
    if (!layer) throw new Error('CompositeRenderer: renderStyle() must run before composite()');

    // Read from the cached layer rather than resolved again from the controls,
    // so the crossfade can never describe a styled texture other than the one
    // being blended.
    this.#device.queue.writeBuffer(this.#uniforms, 0, new Float32Array([layer.mix, 0, 0, 0]));

    const bindGroup = this.#device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: sourceTexture.createView({ format: SOURCE_VIEW_FORMAT }) },
        { binding: 1, resource: layerView(layer.texture) },
        { binding: 2, resource: maskTexture.createView() },
        { binding: 3, resource: this.#sampler },
        { binding: 4, resource: { buffer: this.#uniforms } },
      ],
    });

    this.#pass.run(encoder, targetView, bindGroup);
  }

  dispose(): void {
    this.#retired.dispose();
    this.#active?.pipeline.dispose();
    this.#active = undefined;
    this.#layer = undefined;
    this.#uniforms.destroy();
  }
}
