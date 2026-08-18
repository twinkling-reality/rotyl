import { FullscreenPass, UniformRing } from '../../gpu/fullscreen-pass.ts';
import { DeferredRelease, ResourcePool } from '../../gpu/resource-pool.ts';
import { WORKING_FORMAT } from '../../gpu/formats.ts';
import { POSTER_CONTROLS, resolvePosterParams, type PosterParams } from './poster-params.ts';
import { bufferSizeForShortEdge, shortEdge, type Dimensions } from '../../render/resolution.ts';
import type { StyleControls, StyleDefinition, StylePipeline, StyleQuality, StyledLayer } from '../style.ts';

import colorWgsl from '../../color/color.wgsl?raw';
import paletteWgsl from '../wgsl/palette.wgsl?raw';
import downsampleWgsl from '../wgsl/downsample.wgsl?raw';
import bilateralWgsl from '../wgsl/bilateral.wgsl?raw';
import levelsWgsl from '../wgsl/levels.wgsl?raw';
import posterWgsl from './wgsl/poster.wgsl?raw';

/**
 * The poster style, as a chain of fullscreen passes.
 *
 *   flatten buffer   downsample -> [bilateral x, bilateral y] x3
 *   1x1              the picture's own lightness range, for fitting a palette
 *   output buffer    quantise, palette, and a line where two regions meet
 *
 * Nine passes, one of them at output resolution, and four of the nine are
 * shared code: the downsample the print style also uses, and the palette
 * operators the comic style also uses. That is the claim the style seam makes,
 * tested a third time - nothing in the compositor, the engine, the export path
 * or the panel changed to add this.
 *
 * Nothing in this chain reads the selection mask. Every stage runs over the
 * whole image, which is required for correctness: kernels that reach across a
 * mask boundary would sample zeroed neighbours and draw a halo just inside
 * every selection edge.
 *
 * UNIFORM SLOTS ARE NEVER REUSED WITHIN A FRAME. `queue.writeBuffer` is ordered
 * against submissions rather than against the encoder, so every write in a
 * frame lands before any recorded pass executes - two passes sharing a slot
 * would both read whichever value was written last. The bilateral runs six
 * times with six different steps, so it takes six slots.
 */

const BILATERAL_PASSES = 6;

const SLOT = {
  downsample: 0,
  bilateral: 1,
  poster: 1 + BILATERAL_PASSES,
} as const;

const SLOT_COUNT = SLOT.poster + 1;

const PALETTE_STOPS = 5;
/** texel, then twelve scalars, then the palette on its own 16-byte boundary. */
const POSTER_FLOATS = 16 + PALETTE_STOPS * 4;

interface StageTextures {
  readonly flatten: Dimensions;
  readonly output: Dimensions;
  readonly flat: readonly [GPUTexture, GPUTexture];
  /** 1x1, holding what the levels pass measured about this frame. */
  readonly levels: GPUTexture;
  readonly styled: GPUTexture;
  readonly pool: ResourcePool;
}

function sameSize(a: Dimensions, b: Dimensions): boolean {
  return a.width === b.width && a.height === b.height;
}

export class PosterStylePipeline implements StylePipeline {
  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #uniforms: UniformRing;
  readonly #layout: GPUBindGroupLayout;
  readonly #levelsLayout: GPUBindGroupLayout;
  readonly #posterLayout: GPUBindGroupLayout;

  readonly #passes: {
    readonly downsample: FullscreenPass;
    readonly bilateral: FullscreenPass;
    readonly levels: FullscreenPass;
    readonly poster: FullscreenPass;
  };

  #stages: StageTextures | undefined;
  readonly #retired: DeferredRelease;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#retired = new DeferredRelease(device);
    this.#sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.#uniforms = new UniformRing(device, SLOT_COUNT, 'poster-uniforms');

    // Every pass in this chain reads one texture and one uniform slot, so one
    // layout serves all three.
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
      ],
    });

    // The levels pass reads no parameters at all - it only measures - and a
    // layout declaring a dynamic uniform it never binds an offset for is a
    // validation error rather than an unused entry.
    this.#levelsLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    // The poster pass reads a second texture: the 1x1 the levels pass wrote.
    this.#posterLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    const pass = (
      label: string,
      fragmentWgsl: string,
      bindGroupLayout: GPUBindGroupLayout = this.#layout,
    ): FullscreenPass =>
      new FullscreenPass({ label, device, fragmentWgsl, bindGroupLayout, targetFormat: WORKING_FORMAT });

    this.#passes = {
      downsample: pass('poster:downsample', downsampleWgsl),
      bilateral: pass('poster:bilateral', bilateralWgsl),
      // WGSL has no include mechanism, so shared functions are prepended.
      levels: pass('poster:levels', `${colorWgsl}\n${levelsWgsl}`, this.#levelsLayout),
      poster: pass('poster:poster', `${colorWgsl}\n${paletteWgsl}\n${posterWgsl}`, this.#posterLayout),
    };
  }

  #bindGroup(texture: GPUTextureView): GPUBindGroup {
    return this.#device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: texture },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: { buffer: this.#uniforms.buffer, size: 256 } },
      ],
    });
  }

  #levelsBindGroup(texture: GPUTextureView): GPUBindGroup {
    return this.#device.createBindGroup({
      layout: this.#levelsLayout,
      entries: [
        { binding: 0, resource: texture },
        { binding: 1, resource: this.#sampler },
      ],
    });
  }

  #posterBindGroup(flat: GPUTextureView, levels: GPUTextureView): GPUBindGroup {
    return this.#device.createBindGroup({
      layout: this.#posterLayout,
      entries: [
        { binding: 0, resource: flat },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: { buffer: this.#uniforms.buffer, size: 256 } },
        { binding: 3, resource: levels },
      ],
    });
  }

  #ensureStages(source: Dimensions, output: Dimensions, params: PosterParams): StageTextures {
    const flatten = bufferSizeForShortEdge(source, params.flattenShortEdge);

    const existing = this.#stages;
    if (existing && sameSize(existing.flatten, flatten) && sameSize(existing.output, output)) {
      return existing;
    }

    // Changing the Detail slider changes the flatten buffer's size, and the
    // frame that last used it has been submitted but not necessarily executed.
    if (existing) this.#retired.after(() => existing.pool.dispose());

    const pool = new ResourcePool();
    const make = (label: string, size: Dimensions): GPUTexture =>
      pool.texture(this.#device, {
        label,
        size: { width: size.width, height: size.height },
        format: WORKING_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });

    const stages: StageTextures = {
      flatten,
      output,
      flat: [make('poster:flat-a', flatten), make('poster:flat-b', flatten)],
      levels: make('poster:levels', { width: 1, height: 1 }),
      styled: make('poster:styled', output),
      pool,
    };
    this.#stages = stages;
    return stages;
  }

  #writePosterUniforms(params: PosterParams, output: Dimensions): void {
    const short = shortEdge(output);
    const values = Array.from({ length: POSTER_FLOATS }, () => 0);
    const put = (at: number, ...floats: number[]): void => {
      for (const [index, value] of floats.entries()) values[at + index] = value;
    };

    // The line's width arrives as a fraction of the SHORT edge and is converted
    // to uv here, where the image's shape is known - so a line is the same
    // physical weight on both axes rather than stretched by the aspect ratio.
    put(
      0,
      1 / output.width,
      1 / output.height,
      (params.lineFraction * short) / output.width,
      (params.lineFraction * short) / output.height,
    );
    put(
      4,
      params.levels,
      params.chromaStep,
      params.saturation,
      params.paletteAmount,
      params.lineWeight,
      params.lineThreshold,
      params.lineSoftness,
      params.paletteChroma,
    );
    put(12, params.paletteMeanLightness, params.paletteLightnessSpread);
    put(16, ...params.paletteStops);

    this.#uniforms.write(SLOT.poster, values);
  }

  render(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    source: Dimensions,
    output: Dimensions,
    controls: StyleControls,
    quality: StyleQuality,
  ): StyledLayer {
    const params = resolvePosterParams(controls, shortEdge(output), quality);
    const stages = this.#ensureStages(source, output, params);
    const { flatten } = stages;

    this.#uniforms.write(SLOT.downsample, [
      source.width / flatten.width,
      source.height / flatten.height,
      1 / source.width,
      1 / source.height,
    ]);
    for (let pass = 0; pass < BILATERAL_PASSES; pass++) {
      const horizontal = pass % 2 === 0;
      this.#uniforms.write(SLOT.bilateral + pass, [
        horizontal ? 1 / flatten.width : 0,
        horizontal ? 0 : 1 / flatten.height,
        params.sigmaSpatial,
        params.sigmaRange,
      ]);
    }
    this.#writePosterUniforms(params, output);

    this.#passes.downsample.run(encoder, stages.flat[0].createView(), this.#bindGroup(sourceView), [
      this.#uniforms.offsetOf(SLOT.downsample),
    ]);

    let read = stages.flat[0];
    let write = stages.flat[1];
    for (let pass = 0; pass < BILATERAL_PASSES; pass++) {
      this.#passes.bilateral.run(encoder, write.createView(), this.#bindGroup(read.createView()), [
        this.#uniforms.offsetOf(SLOT.bilateral + pass),
      ]);
      const swap = read;
      read = write;
      write = swap;
    }

    // Measured from the flattened picture rather than the source, so what the
    // palette is fitted to is what the palette will be applied to.
    this.#passes.levels.run(encoder, stages.levels.createView(), this.#levelsBindGroup(read.createView()));

    this.#passes.poster.run(
      encoder,
      stages.styled.createView(),
      this.#posterBindGroup(read.createView(), stages.levels.createView()),
      [this.#uniforms.offsetOf(SLOT.poster)],
    );

    this.#uniforms.flush(this.#device.queue);
    return { texture: stages.styled, mix: params.styleMix };
  }

  dispose(): void {
    this.#retired.dispose();
    this.#stages?.pool.dispose();
    this.#stages = undefined;
    this.#uniforms.destroy();
  }
}

export const POSTER_STYLE: StyleDefinition = {
  id: 'poster',
  name: 'Poster',
  controls: POSTER_CONTROLS,
  create: (device) => new PosterStylePipeline(device),
};
