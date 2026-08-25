import { FullscreenPass, UniformRing } from '../../gpu/fullscreen-pass.ts';
import { DeferredRelease, ResourcePool } from '../../gpu/resource-pool.ts';
import { SCALAR_FORMAT, WORKING_FORMAT } from '../../gpu/formats.ts';
import { ANIME_CONTROLS, resolveAnimeParams, type AnimeParams } from './anime-params.ts';
import { bufferSizeForShortEdge, shortEdge, type Dimensions } from '../../render/resolution.ts';
import type { StyleControls, StyleDefinition, StylePipeline, StyleQuality, StyledLayer } from '../style.ts';

import colorWgsl from '../../color/color.wgsl?raw';
import downsampleWgsl from '../wgsl/downsample.wgsl?raw';
import levelsWgsl from '../wgsl/levels.wgsl?raw';
import inkWgsl from '../comic/wgsl/ink.wgsl?raw';
import structureTensorWgsl from '../comic/wgsl/structure-tensor.wgsl?raw';
import gaussianBlurWgsl from '../comic/wgsl/gaussian-blur.wgsl?raw';
import kuwaharaWgsl from '../comic/wgsl/anisotropic-kuwahara.wgsl?raw';
import luminanceWgsl from '../comic/wgsl/luminance.wgsl?raw';
import flowDogEdgeWgsl from '../comic/wgsl/flow-dog-edge.wgsl?raw';
import flowDogStreamlineWgsl from '../comic/wgsl/flow-dog-streamline.wgsl?raw';
import animeWgsl from './wgsl/anime.wgsl?raw';

/**
 * The anime style: a hue-preserving cel pass over the selected person.
 *
 *   flatten buffer   downsample -> [tensor -> blur -> Kuwahara] x2
 *   ink buffer       lightness -> [DoG across the field -> integrate] x2
 *   1x1              the picture's lightness range, for keyed lighting
 *   output buffer    cel bands, split-tone, chroma reshape, hair specular, ink
 *
 * The flatten and ink stages are the same operators the comic style uses,
 * because those operators are what make a per-frame chain hold still on video.
 * The look is not shared. Comic optionally replaces hue with a palette. This
 * chain keeps hue, which is where a face stays the same face, and spends its
 * last pass on lighting, banding and line.
 *
 * Nothing here reads the selection mask. Every stage runs over the whole
 * image, which is required for correctness: kernels that reach across a mask
 * boundary would sample zeroed neighbours and draw a halo just inside every
 * selection edge. The compositor is what makes the treatment selective.
 *
 * UNIFORM SLOTS ARE NEVER REUSED WITHIN A FRAME. `queue.writeBuffer` is ordered
 * against submissions, not against the encoder.
 */

const SLOT = {
  downsample: 0,
  tensor: 1,
  blurTensorX: 2,
  blurTensorY: 3,
  kuwahara: 4,
  blurFlowX: 5,
  blurFlowY: 6,
  edgeFirst: 7,
  edgeSecond: 8,
  streamline: 9,
  anime: 10,
} as const;

const SLOT_COUNT = Object.keys(SLOT).length;

interface StageTextures {
  readonly flatten: Dimensions;
  readonly ink: Dimensions;
  readonly output: Dimensions;
  readonly flat: readonly [GPUTexture, GPUTexture];
  readonly tensor: readonly [GPUTexture, GPUTexture];
  readonly luminance: GPUTexture;
  readonly inkPair: readonly [GPUTexture, GPUTexture];
  readonly levels: GPUTexture;
  readonly styled: GPUTexture;
  readonly pool: ResourcePool;
}

function sameSize(a: Dimensions, b: Dimensions): boolean {
  return a.width === b.width && a.height === b.height;
}

const tex = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: 'float' },
});
const samp = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.FRAGMENT,
  sampler: { type: 'filtering' },
});
const uni = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.FRAGMENT,
  buffer: { type: 'uniform', hasDynamicOffset: true },
});

const withColor = (source: string): string => `${colorWgsl}\n${source}`;
const withColorAndInk = (source: string): string => `${colorWgsl}\n${inkWgsl}\n${source}`;

export class AnimeStylePipeline implements StylePipeline {
  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #uniforms: UniformRing;

  readonly #layouts: {
    readonly sampled: GPUBindGroupLayout;
    readonly kuwahara: GPUBindGroupLayout;
    readonly luminance: GPUBindGroupLayout;
    readonly edge: GPUBindGroupLayout;
    readonly pair: GPUBindGroupLayout;
  };

  readonly #passes: {
    readonly downsample: FullscreenPass;
    readonly tensor: FullscreenPass;
    readonly blur: FullscreenPass;
    readonly kuwahara: FullscreenPass;
    readonly luminance: FullscreenPass;
    readonly levels: FullscreenPass;
    readonly edge: FullscreenPass;
    readonly streamline: FullscreenPass;
    readonly anime: FullscreenPass;
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
    this.#uniforms = new UniformRing(device, SLOT_COUNT, 'anime-uniforms');

    this.#layouts = {
      sampled: device.createBindGroupLayout({ entries: [tex(0), samp(1), uni(2)] }),
      kuwahara: device.createBindGroupLayout({ entries: [tex(0), tex(1), samp(2), uni(3)] }),
      luminance: device.createBindGroupLayout({ entries: [tex(0), samp(1)] }),
      edge: device.createBindGroupLayout({ entries: [tex(0), tex(1), tex(2), samp(3), uni(4)] }),
      pair: device.createBindGroupLayout({ entries: [tex(0), tex(1), samp(2), uni(3)] }),
    };

    this.#passes = {
      downsample: new FullscreenPass({
        label: 'anime:downsample',
        device,
        fragmentWgsl: downsampleWgsl,
        bindGroupLayout: this.#layouts.sampled,
        targetFormat: WORKING_FORMAT,
      }),
      tensor: new FullscreenPass({
        label: 'anime:tensor',
        device,
        fragmentWgsl: structureTensorWgsl,
        bindGroupLayout: this.#layouts.sampled,
        targetFormat: WORKING_FORMAT,
      }),
      blur: new FullscreenPass({
        label: 'anime:blur',
        device,
        fragmentWgsl: gaussianBlurWgsl,
        bindGroupLayout: this.#layouts.sampled,
        targetFormat: WORKING_FORMAT,
      }),
      kuwahara: new FullscreenPass({
        label: 'anime:kuwahara',
        device,
        fragmentWgsl: withColor(kuwaharaWgsl),
        bindGroupLayout: this.#layouts.kuwahara,
        targetFormat: WORKING_FORMAT,
      }),
      luminance: new FullscreenPass({
        label: 'anime:luminance',
        device,
        fragmentWgsl: withColor(luminanceWgsl),
        bindGroupLayout: this.#layouts.luminance,
        targetFormat: SCALAR_FORMAT,
      }),
      levels: new FullscreenPass({
        label: 'anime:levels',
        device,
        fragmentWgsl: withColor(levelsWgsl),
        bindGroupLayout: this.#layouts.luminance,
        targetFormat: WORKING_FORMAT,
      }),
      edge: new FullscreenPass({
        label: 'anime:flow-dog-edge',
        device,
        fragmentWgsl: withColorAndInk(flowDogEdgeWgsl),
        bindGroupLayout: this.#layouts.edge,
        targetFormat: SCALAR_FORMAT,
      }),
      streamline: new FullscreenPass({
        label: 'anime:flow-dog-streamline',
        device,
        fragmentWgsl: withColor(flowDogStreamlineWgsl),
        bindGroupLayout: this.#layouts.pair,
        targetFormat: SCALAR_FORMAT,
      }),
      anime: new FullscreenPass({
        label: 'anime:character',
        device,
        fragmentWgsl: withColorAndInk(animeWgsl),
        bindGroupLayout: this.#layouts.edge,
        targetFormat: WORKING_FORMAT,
      }),
    };
  }

  #bindGroup(layout: GPUBindGroupLayout, resources: readonly GPUBindingResource[]): GPUBindGroup {
    return this.#device.createBindGroup({
      layout,
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
  }

  #uniformBinding(): GPUBufferBinding {
    return { buffer: this.#uniforms.buffer, size: 256 };
  }

  #blurTensor(
    encoder: GPUCommandEncoder,
    stages: StageTextures,
    sigma: number,
    slotX: number,
    slotY: number,
  ): void {
    const [a, b] = stages.tensor;
    const { width, height } = stages.flatten;

    this.#uniforms.write(slotX, [1 / width, 0, sigma, 0]);
    this.#passes.blur.run(
      encoder,
      b.createView(),
      this.#bindGroup(this.#layouts.sampled, [a.createView(), this.#sampler, this.#uniformBinding()]),
      [this.#uniforms.offsetOf(slotX)],
    );

    this.#uniforms.write(slotY, [0, 1 / height, sigma, 0]);
    this.#passes.blur.run(
      encoder,
      a.createView(),
      this.#bindGroup(this.#layouts.sampled, [b.createView(), this.#sampler, this.#uniformBinding()]),
      [this.#uniforms.offsetOf(slotY)],
    );
  }

  #tensorOf(encoder: GPUCommandEncoder, stages: StageTextures, source: GPUTexture): void {
    this.#passes.tensor.run(
      encoder,
      stages.tensor[0].createView(),
      this.#bindGroup(this.#layouts.sampled, [source.createView(), this.#sampler, this.#uniformBinding()]),
      [this.#uniforms.offsetOf(SLOT.tensor)],
    );
  }

  #ensureStages(source: Dimensions, output: Dimensions, params: AnimeParams): StageTextures {
    const flatten = bufferSizeForShortEdge(source, params.flattenShortEdge);
    const ink = bufferSizeForShortEdge(source, params.inkShortEdge);

    const existing = this.#stages;
    if (
      existing &&
      sameSize(existing.flatten, flatten) &&
      sameSize(existing.ink, ink) &&
      sameSize(existing.output, output)
    ) {
      return existing;
    }

    if (existing) this.#retired.after(() => existing.pool.dispose());

    const pool = new ResourcePool();
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const make = (label: string, size: Dimensions, format: GPUTextureFormat): GPUTexture =>
      pool.texture(this.#device, {
        label,
        size: { width: size.width, height: size.height },
        format,
        usage,
      });

    const stages: StageTextures = {
      flatten,
      ink,
      output,
      flat: [make('anime:flat-a', flatten, WORKING_FORMAT), make('anime:flat-b', flatten, WORKING_FORMAT)],
      tensor: [
        make('anime:tensor-a', flatten, WORKING_FORMAT),
        make('anime:tensor-b', flatten, WORKING_FORMAT),
      ],
      luminance: make('anime:luminance', ink, SCALAR_FORMAT),
      inkPair: [make('anime:ink-a', ink, SCALAR_FORMAT), make('anime:ink-b', ink, SCALAR_FORMAT)],
      levels: make('anime:levels', { width: 1, height: 1 }, WORKING_FORMAT),
      styled: make('anime:styled', output, WORKING_FORMAT),
      pool,
    };
    this.#stages = stages;
    return stages;
  }

  render(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    source: Dimensions,
    output: Dimensions,
    controls: StyleControls,
    quality: StyleQuality,
  ): StyledLayer {
    const params = resolveAnimeParams(controls, shortEdge(output), quality);
    const stages = this.#ensureStages(source, output, params);
    const { flatten, ink } = stages;
    const flatA = stages.flat[0];
    const flatB = stages.flat[1];
    const tensorA = stages.tensor[0];
    const inkA = stages.inkPair[0];
    const inkB = stages.inkPair[1];

    this.#uniforms.write(SLOT.downsample, [
      source.width / flatten.width,
      source.height / flatten.height,
      1 / source.width,
      1 / source.height,
    ]);
    this.#uniforms.write(SLOT.tensor, [1 / flatten.width, 1 / flatten.height, 0, 0]);
    this.#uniforms.write(SLOT.kuwahara, [
      1 / flatten.width,
      1 / flatten.height,
      params.radius,
      params.sharpness,
    ]);
    this.#uniforms.write(SLOT.streamline, [1 / ink.width, 1 / ink.height, params.sigmaStreamline, 0]);
    this.#uniforms.write(SLOT.anime, [
      params.bins,
      params.quantSharpness,
      params.colour,
      params.inkOpacity,
      params.edgeThreshold,
      params.edgeSharpness,
      params.splitTone,
      params.chromaLift,
      params.skinHold,
      params.specular,
      0,
      0,
    ]);
    for (const [slot, reinject] of [
      [SLOT.edgeFirst, 0],
      [SLOT.edgeSecond, 1],
    ] as const) {
      this.#uniforms.write(slot, [
        1 / ink.width,
        1 / ink.height,
        params.sigmaEdge,
        params.tau,
        params.edgeThreshold,
        params.edgeSharpness,
        reinject,
        0,
      ]);
    }

    this.#passes.downsample.run(
      encoder,
      flatA.createView(),
      this.#bindGroup(this.#layouts.sampled, [sourceView, this.#sampler, this.#uniformBinding()]),
      [this.#uniforms.offsetOf(SLOT.downsample)],
    );

    let flatSource = flatA;
    let flatTarget = flatB;
    for (let iteration = 0; iteration < 2; iteration++) {
      this.#tensorOf(encoder, stages, flatSource);
      this.#blurTensor(encoder, stages, params.sigmaTensor, SLOT.blurTensorX, SLOT.blurTensorY);
      this.#passes.kuwahara.run(
        encoder,
        flatTarget.createView(),
        this.#bindGroup(this.#layouts.kuwahara, [
          flatSource.createView(),
          tensorA.createView(),
          this.#sampler,
          this.#uniformBinding(),
        ]),
        [this.#uniforms.offsetOf(SLOT.kuwahara)],
      );
      const swap = flatSource;
      flatSource = flatTarget;
      flatTarget = swap;
    }
    const flattened = flatSource;

    this.#tensorOf(encoder, stages, flattened);
    this.#blurTensor(encoder, stages, params.sigmaFlow, SLOT.blurFlowX, SLOT.blurFlowY);

    this.#passes.luminance.run(
      encoder,
      stages.luminance.createView(),
      this.#bindGroup(this.#layouts.luminance, [flattened.createView(), this.#sampler]),
    );

    for (const slot of [SLOT.edgeFirst, SLOT.edgeSecond]) {
      this.#passes.edge.run(
        encoder,
        inkA.createView(),
        this.#bindGroup(this.#layouts.edge, [
          stages.luminance.createView(),
          tensorA.createView(),
          inkB.createView(),
          this.#sampler,
          this.#uniformBinding(),
        ]),
        [this.#uniforms.offsetOf(slot)],
      );
      this.#passes.streamline.run(
        encoder,
        inkB.createView(),
        this.#bindGroup(this.#layouts.pair, [
          inkA.createView(),
          tensorA.createView(),
          this.#sampler,
          this.#uniformBinding(),
        ]),
        [this.#uniforms.offsetOf(SLOT.streamline)],
      );
    }

    this.#passes.levels.run(
      encoder,
      stages.levels.createView(),
      this.#bindGroup(this.#layouts.luminance, [flattened.createView(), this.#sampler]),
    );

    this.#passes.anime.run(
      encoder,
      stages.styled.createView(),
      this.#bindGroup(this.#layouts.edge, [
        flattened.createView(),
        inkB.createView(),
        stages.levels.createView(),
        this.#sampler,
        this.#uniformBinding(),
      ]),
      [this.#uniforms.offsetOf(SLOT.anime)],
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

export const ANIME_STYLE: StyleDefinition = {
  id: 'anime',
  name: 'Anime',
  controls: ANIME_CONTROLS,
  create: (device) => new AnimeStylePipeline(device),
};
