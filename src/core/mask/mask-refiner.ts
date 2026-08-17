import { FullscreenPass, UniformRing } from '../gpu/fullscreen-pass.ts';
import { ResourcePool } from '../gpu/resource-pool.ts';
import { MASK_FORMAT } from '../gpu/formats.ts';
import { bufferSizeForShortEdge, shortEdge, type Dimensions } from '../render/resolution.ts';
import { resolveRefineParams, type RefineParams, type RefineSettings } from './refine-params.ts';

import colorWgsl from '../style/wgsl/color.wgsl?raw';
import guidedGuideWgsl from './wgsl/guided-guide.wgsl?raw';
import guidedMomentsWgsl from './wgsl/guided-moments.wgsl?raw';
import boxBlurWgsl from './wgsl/box-blur.wgsl?raw';
import guidedCoefficientsWgsl from './wgsl/guided-coefficients.wgsl?raw';
import guidedApplyWgsl from './wgsl/guided-apply.wgsl?raw';

/**
 * The bridge between what a segmentation engine produces and what the renderer
 * can use: a guided filter (He, Sun and Tang) in its fast form, with the local
 * linear model fitted in a derived working buffer and evaluated against the
 * image at output resolution.
 *
 * WHY THIS EXISTS. An engine mask is 256 px square whatever the photograph is.
 * Magnifying it is the obvious thing and it is visibly wrong in both available
 * directions: a nearest tap staircases along every boundary, and a bilinear tap
 * trades the staircase for a sixteen-pixel ramp that follows the mask's texel
 * grid rather than the object. Neither has any way to know where the edge
 * really is. This does — the photograph is the guide, so the matte transitions
 * where the photograph transitions.
 *
 * WHY IT RUNS DURING REPLAY, NOT ONCE AT THE CLICK. Refining once and storing
 * the result would put a full-resolution mask in the command log: 12 MB per
 * click at 12 megapixels, and a preview-resolution matte that export would then
 * have to magnify, which is the problem this class exists to solve. The command
 * carries the engine's own 256 px answer, and the boundary is reconstructed
 * against whatever resolution is being rendered.
 *
 * TWO FRAME-LIFETIME RULES, both learned elsewhere in this codebase and both
 * live here because a replay can record SEVERAL refinements into one frame:
 *
 *   Uniform slots are never rewritten within a frame. `queue.writeBuffer` is
 *   ordered against submission, so a second refinement rewriting the first's
 *   slots would silently give both its own parameters. Each refinement takes a
 *   fresh block of slots, and the ring grows rather than wrapping.
 *
 *   Working buffers are released a frame late. A pool that a recorded pass
 *   still references cannot be freed on `onSubmittedWorkDone` at the moment it
 *   is replaced, because the frame holding that reference has not been
 *   submitted yet and the fence would resolve straight through it.
 */

const SLOT = {
  guide: 0,
  moments0: 1,
  moments1: 2,
  moments2: 3,
  blurX: 4,
  blurY: 5,
  coefficients: 6,
  apply: 7,
} as const;

/** Uniform slots one refinement consumes. */
const SLOTS_PER_REFINE = Object.keys(SLOT).length;

/** Statistics carried at full float; see #ensureStages for why half is not enough. */
const STATISTIC_FORMAT = 'rgba32float' satisfies GPUTextureFormat;
/** The fitted model, which is magnified and therefore has to be filterable. */
const MODEL_FORMAT = 'rgba16float' satisfies GPUTextureFormat;

export interface RefineRequest {
  /** An sRGB view of the full-resolution source, so the guide is linear light. */
  readonly guideView: GPUTextureView;
  readonly guideSize: Dimensions;
  /** The engine's own answer, at its own resolution. */
  readonly coarse: GPUTexture;
  /** Where refined coverage lands: MASK_FORMAT, at output resolution. */
  readonly target: GPUTextureView;
  readonly targetSize: Dimensions;
  readonly settings: RefineSettings;
}

/**
 * A stage buffer and its view.
 *
 * The view is created once with the texture rather than per pass. A refinement
 * touches these buffers about thirty times, and `createView` is not free: it
 * allocates a native object whose lifetime is the garbage collector's problem,
 * which turns a replay holding several engine masks into a few hundred objects
 * per frame for data that never changes.
 */
interface Stage {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
}

interface Stages {
  readonly size: Dimensions;
  /** (L, a, b, coarse), and its own local means once blurred. */
  readonly guide: Stage;
  /** The nine remaining products; three of the twelve channels are unused. */
  readonly planes: readonly [Stage, Stage, Stage];
  readonly scratch: Stage;
  readonly model: Stage;
  readonly pool: ResourcePool;
}

const unfilterable = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: 'unfilterable-float' },
});
const filterable = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: 'float' },
});
const samplerEntry = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.FRAGMENT,
  sampler: { type: 'filtering' },
});
const uniformEntry = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.FRAGMENT,
  buffer: { type: 'uniform', hasDynamicOffset: true },
});

interface Pipelines {
  readonly sampler: GPUSampler;
  readonly uniforms: UniformRing;
  readonly layouts: {
    readonly guide: GPUBindGroupLayout;
    readonly moments: GPUBindGroupLayout;
    readonly blur: GPUBindGroupLayout;
    readonly coefficients: GPUBindGroupLayout;
    readonly apply: GPUBindGroupLayout;
  };
  readonly passes: {
    readonly guide: FullscreenPass;
    readonly moments: FullscreenPass;
    readonly blur: FullscreenPass;
    /** The one blur that writes the model, which is a different format. */
    readonly blurToModel: FullscreenPass;
    readonly coefficients: FullscreenPass;
    readonly apply: FullscreenPass;
  };
}

export class MaskRefiner {
  readonly #device: GPUDevice;

  /**
   * Built on the first refinement, not in the constructor.
   *
   * Six pipelines is a real compilation cost, and most sessions never segment
   * anything — the brush needs none of this. Paying it at startup for a feature
   * that may go unused is the wrong trade in the browser, and in the Node test
   * suite it was worse than that: pipelines compile on a background thread, the
   * queue fence at teardown does not cover them, and a file that constructed a
   * refiner without ever using one aborted its worker about one run in eight.
   */
  #pipelines: Pipelines | undefined;

  /** Set only once the initial ring in #pipelines has been outgrown. */
  #ring: UniformRing | undefined;
  #uniformCapacity = 4;
  #uniformCursor = 0;

  #stages: Stages | undefined;
  /** Replaced this frame; still referenced by commands not yet submitted. */
  #superseded: (ResourcePool | UniformRing)[] = [];
  /** Awaiting a fence that is known to cover the frame that used them. */
  readonly #retired = new Set<ResourcePool | UniformRing>();

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  #ensurePipelines(): Pipelines {
    if (this.#pipelines) return this.#pipelines;
    const device = this.#device;

    const layouts = {
      guide: device.createBindGroupLayout({
        entries: [filterable(0), filterable(1), samplerEntry(2), uniformEntry(3)],
      }),
      moments: device.createBindGroupLayout({ entries: [unfilterable(0), uniformEntry(1)] }),
      blur: device.createBindGroupLayout({ entries: [unfilterable(0), uniformEntry(1)] }),
      coefficients: device.createBindGroupLayout({
        entries: [unfilterable(0), unfilterable(1), unfilterable(2), unfilterable(3), uniformEntry(4)],
      }),
      apply: device.createBindGroupLayout({
        entries: [filterable(0), filterable(1), samplerEntry(2), uniformEntry(3)],
      }),
    };

    const blur = {
      label: 'refine:box-blur',
      device,
      fragmentWgsl: boxBlurWgsl,
      bindGroupLayout: layouts.blur,
    };

    this.#pipelines = {
      sampler: device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      uniforms: this.#createUniforms(this.#uniformCapacity),
      layouts,
      passes: {
        guide: new FullscreenPass({
          label: 'refine:guide',
          device,
          fragmentWgsl: `${colorWgsl}\n${guidedGuideWgsl}`,
          bindGroupLayout: layouts.guide,
          targetFormat: STATISTIC_FORMAT,
        }),
        moments: new FullscreenPass({
          label: 'refine:moments',
          device,
          fragmentWgsl: guidedMomentsWgsl,
          bindGroupLayout: layouts.moments,
          targetFormat: STATISTIC_FORMAT,
        }),
        blur: new FullscreenPass({ ...blur, targetFormat: STATISTIC_FORMAT }),
        blurToModel: new FullscreenPass({ ...blur, targetFormat: MODEL_FORMAT }),
        coefficients: new FullscreenPass({
          label: 'refine:coefficients',
          device,
          fragmentWgsl: guidedCoefficientsWgsl,
          bindGroupLayout: layouts.coefficients,
          targetFormat: STATISTIC_FORMAT,
        }),
        apply: new FullscreenPass({
          label: 'refine:apply',
          device,
          fragmentWgsl: `${colorWgsl}\n${guidedApplyWgsl}`,
          bindGroupLayout: layouts.apply,
          targetFormat: MASK_FORMAT,
        }),
      },
    };
    return this.#pipelines;
  }

  #createUniforms(refines: number): UniformRing {
    return new UniformRing(this.#device, refines * SLOTS_PER_REFINE, 'refine-uniforms');
  }

  /**
   * Start recording a frame.
   *
   * Resets the uniform cursor, and only now hands the previous frame's
   * superseded resources to a fence — by this point that frame has been
   * submitted, so `onSubmittedWorkDone` genuinely covers it. Freeing them at
   * the moment they were replaced would have raced the submission that still
   * referenced them.
   */
  beginFrame(): void {
    this.#uniformCursor = 0;
    for (const resource of this.#superseded) this.#retire(resource);
    this.#superseded.length = 0;
  }

  #retire(resource: ResourcePool | UniformRing): void {
    this.#retired.add(resource);
    void this.#device.queue.onSubmittedWorkDone().then(() => {
      if (!this.#retired.delete(resource)) return;
      release(resource);
    });
  }

  /**
   * Statistics are rgba32float, deliberately.
   *
   * Every variance here is a difference between two means of similar
   * magnitude, and at half precision that subtraction leaves roughly 1e-4 of
   * noise — the same order as the regularisation constant, so flat regions
   * would fit a random linear model and the matte would crawl. The fitted model
   * afterwards is fine at half precision, and has to be: it is the one buffer
   * that gets magnified, and magnification needs a filterable format.
   */
  #ensureStages(size: Dimensions): Stages {
    const existing = this.#stages;
    if (existing && existing.size.width === size.width && existing.size.height === size.height) {
      return existing;
    }
    if (existing) this.#superseded.push(existing.pool);

    const pool = new ResourcePool();
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const make = (label: string, format: GPUTextureFormat): Stage => {
      const texture = pool.texture(this.#device, {
        label,
        size: { width: size.width, height: size.height },
        format,
        usage,
      });
      return { texture, view: texture.createView({ label }) };
    };

    const stages: Stages = {
      size,
      guide: make('refine:guide', STATISTIC_FORMAT),
      planes: [
        make('refine:plane-1', STATISTIC_FORMAT),
        make('refine:plane-2', STATISTIC_FORMAT),
        make('refine:plane-3', STATISTIC_FORMAT),
      ],
      scratch: make('refine:scratch', STATISTIC_FORMAT),
      model: make('refine:model', MODEL_FORMAT),
      pool,
    };
    this.#stages = stages;
    return stages;
  }

  /** Reserve a block of uniform slots, growing without disturbing recorded passes. */
  #reserveSlots(pipelines: Pipelines): { ring: UniformRing; base: number } {
    let ring = this.#ring ?? pipelines.uniforms;
    if (this.#uniformCursor >= this.#uniformCapacity) {
      // The passes already recorded this frame keep binding the old ring, whose
      // contents are already flushed and therefore already correct.
      this.#superseded.push(ring);
      this.#uniformCapacity *= 2;
      ring = this.#createUniforms(this.#uniformCapacity);
      this.#ring = ring;
      this.#uniformCursor = 0;
    }
    const base = this.#uniformCursor * SLOTS_PER_REFINE;
    this.#uniformCursor++;
    return { ring, base };
  }

  #bindGroup(layout: GPUBindGroupLayout, resources: readonly GPUBindingResource[]): GPUBindGroup {
    return this.#device.createBindGroup({
      layout,
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
  }

  /** Record the refinement of one engine mask. Submits nothing. */
  refine(encoder: GPUCommandEncoder, request: RefineRequest): void {
    const { passes, layouts, sampler } = this.#ensurePipelines();
    const params: RefineParams = resolveRefineParams(request.settings, shortEdge(request.targetSize));
    const stages = this.#ensureStages(bufferSizeForShortEdge(request.guideSize, params.workingShortEdge));
    const { width, height } = stages.size;

    const { ring, base } = this.#reserveSlots(this.#ensurePipelines());
    const slot = (offset: number): number => ring.offsetOf(base + offset);
    const binding = (): GPUBufferBinding => ({ buffer: ring.buffer, size: 256 });

    ring.write(base + SLOT.guide, [
      request.guideSize.width / width,
      request.guideSize.height / height,
      1 / request.guideSize.width,
      1 / request.guideSize.height,
    ]);
    ring.write(base + SLOT.moments0, [0, 0, 0, 0]);
    ring.write(base + SLOT.moments1, [1, 0, 0, 0]);
    ring.write(base + SLOT.moments2, [2, 0, 0, 0]);
    ring.write(base + SLOT.blurX, [1, 0, params.radius, 0]);
    ring.write(base + SLOT.blurY, [0, 1, params.radius, 0]);
    ring.write(base + SLOT.coefficients, [params.epsilon, 0, 0, 0]);
    ring.write(base + SLOT.apply, [params.firmness, 0, 0, 0]);
    ring.flush(this.#device.queue);

    passes.guide.run(
      encoder,
      stages.guide.view,
      this.#bindGroup(layouts.guide, [request.guideView, request.coarse.createView(), sampler, binding()]),
      [slot(SLOT.guide)],
    );

    const momentSlots = [SLOT.moments0, SLOT.moments1, SLOT.moments2];
    stages.planes.forEach((plane, index) => {
      passes.moments.run(
        encoder,
        plane.view,
        this.#bindGroup(layouts.moments, [stages.guide.view, binding()]),
        [slot(momentSlots[index] ?? SLOT.moments0)],
      );
    });

    // Passes recorded into one encoder execute in order, which is what lets a
    // single scratch buffer serve all four blurs.
    const blurInPlace = (stage: Stage): void => {
      passes.blur.run(encoder, stages.scratch.view, this.#bindGroup(layouts.blur, [stage.view, binding()]), [
        slot(SLOT.blurX),
      ]);
      passes.blur.run(encoder, stage.view, this.#bindGroup(layouts.blur, [stages.scratch.view, binding()]), [
        slot(SLOT.blurY),
      ]);
    };
    for (const stage of [stages.guide, ...stages.planes]) blurInPlace(stage);

    passes.coefficients.run(
      encoder,
      stages.scratch.view,
      this.#bindGroup(layouts.coefficients, [
        stages.guide.view,
        stages.planes[0].view,
        stages.planes[1].view,
        stages.planes[2].view,
        binding(),
      ]),
      [slot(SLOT.coefficients)],
    );

    // The model is smoothed the way the statistics were, which is what stops
    // neighbouring windows disagreeing about the boundary and leaving a tile
    // pattern along it. The guide buffer is free to reuse by this point.
    passes.blur.run(
      encoder,
      stages.guide.view,
      this.#bindGroup(layouts.blur, [stages.scratch.view, binding()]),
      [slot(SLOT.blurX)],
    );
    passes.blurToModel.run(
      encoder,
      stages.model.view,
      this.#bindGroup(layouts.blur, [stages.guide.view, binding()]),
      [slot(SLOT.blurY)],
    );

    passes.apply.run(
      encoder,
      request.target,
      this.#bindGroup(layouts.apply, [stages.model.view, request.guideView, sampler, binding()]),
      [slot(SLOT.apply)],
    );
  }

  dispose(): void {
    const retired = [...this.#retired];
    this.#retired.clear();
    for (const resource of [...retired, ...this.#superseded]) release(resource);
    this.#superseded.length = 0;
    this.#stages?.pool.dispose();
    this.#stages = undefined;
    this.#ring?.destroy();
    this.#ring = undefined;
    this.#pipelines?.uniforms.destroy();
    this.#pipelines = undefined;
  }
}

function release(resource: ResourcePool | UniformRing): void {
  if (resource instanceof ResourcePool) resource.dispose();
  else resource.destroy();
}
