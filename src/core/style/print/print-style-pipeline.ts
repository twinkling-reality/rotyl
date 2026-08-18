import { FullscreenPass, UniformRing } from '../../gpu/fullscreen-pass.ts';
import { DeferredRelease, ResourcePool } from '../../gpu/resource-pool.ts';
import { WORKING_FORMAT } from '../../gpu/formats.ts';
import { PRINT_CONTROLS, resolvePrintParams, type PrintParams } from './print-params.ts';
import { bufferSizeForShortEdge, shortEdge, type Dimensions } from '../../render/resolution.ts';
import type { StyleControls, StyleDefinition, StylePipeline, StyleQuality, StyledLayer } from '../style.ts';

import colorWgsl from '../../color/color.wgsl?raw';
import downsampleWgsl from '../wgsl/downsample.wgsl?raw';
import separateWgsl from './wgsl/separate.wgsl?raw';
import screenWgsl from './wgsl/screen.wgsl?raw';

/**
 * The print style, as a chain of fullscreen passes.
 *
 *   tone buffer     downsample -> separate into four ink densities
 *   output buffer   four rotated screens, printed over paper
 *
 * Three passes against the comic style's nineteen, and only the last of them
 * runs at output resolution. That is not a shortcut: a screen carries no detail
 * finer than its own cell, so the photograph is read at a few samples per cell
 * and everything after that is geometry. See print-params for why the tone
 * buffer's resolution is derived from the screen pitch rather than chosen.
 *
 * Nothing here reads the selection mask, and nothing here needed a change to
 * the compositor. A style is a texture and a mix; that is the whole contract.
 *
 * UNIFORM SLOTS ARE NEVER REUSED WITHIN A FRAME. `queue.writeBuffer` is ordered
 * against submissions, not against the encoder, so every write in a frame lands
 * before any recorded pass executes.
 */

const SLOT = {
  downsample: 0,
  separate: 1,
  screen: 2,
} as const;

const SLOT_COUNT = Object.keys(SLOT).length;

const INK_COUNT = 4;
/** cells (vec2) and its padding, then paper (vec4), then INK_COUNT * 2 vec4s. */
const SCREEN_FLOATS = 8 + INK_COUNT * 8;

interface StageTextures {
  readonly tone: Dimensions;
  readonly output: Dimensions;
  /** The photograph, averaged down to a few samples per screen cell. */
  readonly toned: GPUTexture;
  /** Cyan, magenta and yellow densities in rgb; black in alpha. */
  readonly density: GPUTexture;
  readonly styled: GPUTexture;
  readonly pool: ResourcePool;
}

function sameSize(a: Dimensions, b: Dimensions): boolean {
  return a.width === b.width && a.height === b.height;
}

export class PrintStylePipeline implements StylePipeline {
  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #uniforms: UniformRing;
  readonly #layout: GPUBindGroupLayout;

  readonly #passes: {
    readonly downsample: FullscreenPass;
    readonly separate: FullscreenPass;
    readonly screen: FullscreenPass;
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
    this.#uniforms = new UniformRing(device, SLOT_COUNT, 'print-uniforms');

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

    const pass = (label: string, fragmentWgsl: string): FullscreenPass =>
      new FullscreenPass({
        label,
        device,
        fragmentWgsl,
        bindGroupLayout: this.#layout,
        targetFormat: WORKING_FORMAT,
      });

    this.#passes = {
      downsample: pass('print:downsample', downsampleWgsl),
      separate: pass('print:separate', `${colorWgsl}\n${separateWgsl}`),
      screen: pass('print:screen', screenWgsl),
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

  #ensureStages(source: Dimensions, output: Dimensions, params: PrintParams): StageTextures {
    const tone = bufferSizeForShortEdge(source, params.toneShortEdge);

    const existing = this.#stages;
    if (existing && sameSize(existing.tone, tone) && sameSize(existing.output, output)) {
      return existing;
    }

    // Changing the Coarseness slider changes the tone buffer's size, and the
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
      tone,
      output,
      toned: make('print:tone', tone),
      density: make('print:density', tone),
      styled: make('print:styled', output),
      pool,
    };
    this.#stages = stages;
    return stages;
  }

  /**
   * The screen pass's uniform block, laid out to match its WGSL struct.
   *
   * Registration offsets arrive as fractions of the SHORT edge and are
   * converted to uv here, where the image's dimensions are known, so a
   * misregistration is the same physical distance on both axes rather than
   * being stretched by the aspect ratio.
   */
  #writeScreenUniforms(params: PrintParams, output: Dimensions): void {
    const short = shortEdge(output);
    const pitch = short * params.pitchFraction;

    const values = Array.from({ length: SCREEN_FLOATS }, () => 0);
    const put = (at: number, ...floats: number[]): void => {
      for (const [index, value] of floats.entries()) values[at + index] = value;
    };

    put(0, output.width / pitch, output.height / pitch);
    put(4, ...params.paper);

    params.inks.slice(0, INK_COUNT).forEach((ink, index) => {
      const base = 8 + index * 8;
      put(
        base,
        Math.cos(ink.angle),
        Math.sin(ink.angle),
        (ink.offset[0] * short) / output.width,
        (ink.offset[1] * short) / output.height,
      );
      put(base + 4, ...ink.colour);
    });

    this.#uniforms.write(SLOT.screen, values);
  }

  render(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    source: Dimensions,
    output: Dimensions,
    controls: StyleControls,
    quality: StyleQuality,
  ): StyledLayer {
    const params = resolvePrintParams(controls, shortEdge(output), quality);
    const stages = this.#ensureStages(source, output, params);
    const { tone } = stages;

    this.#uniforms.write(SLOT.downsample, [
      source.width / tone.width,
      source.height / tone.height,
      1 / source.width,
      1 / source.height,
    ]);
    this.#uniforms.write(SLOT.separate, [params.colour, params.blackPoint, params.gain, 0]);
    this.#writeScreenUniforms(params, output);

    this.#passes.downsample.run(encoder, stages.toned.createView(), this.#bindGroup(sourceView), [
      this.#uniforms.offsetOf(SLOT.downsample),
    ]);
    this.#passes.separate.run(
      encoder,
      stages.density.createView(),
      this.#bindGroup(stages.toned.createView()),
      [this.#uniforms.offsetOf(SLOT.separate)],
    );
    this.#passes.screen.run(
      encoder,
      stages.styled.createView(),
      this.#bindGroup(stages.density.createView()),
      [this.#uniforms.offsetOf(SLOT.screen)],
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

export const PRINT_STYLE: StyleDefinition = {
  id: 'print',
  name: 'Print',
  controls: PRINT_CONTROLS,
  create: (device) => new PrintStylePipeline(device),
};
