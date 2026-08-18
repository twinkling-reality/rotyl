import { MASK_FORMAT } from '../gpu/formats.ts';
import { ResourcePool } from '../gpu/resource-pool.ts';
import { FullscreenPass } from '../gpu/fullscreen-pass.ts';
import type { BrushStroke, SelectionCommand, SelectionRect } from '../document/selection-command.ts';
import type { Dimensions } from '../render/resolution.ts';
import type { MaskRefiner } from './mask-refiner.ts';
import colorWgsl from '../color/color.wgsl?raw';
import brushStampWgsl from './wgsl/brush-stamp.wgsl?raw';
import rectStampWgsl from './wgsl/rect-stamp.wgsl?raw';
import maskOpWgsl from './wgsl/mask-op.wgsl?raw';

/**
 * What a replay needs in order to reconstruct an engine mask's boundary.
 *
 * The refiner is borrowed rather than owned, for the reason export borrows the
 * composite renderer: a second copy is a duplicate of every pipeline in it, and
 * building one per export churned Dawn hard enough to destabilise it.
 */
export interface MaskReplayContext {
  readonly refiner: MaskRefiner;
  /** An sRGB view of the full-resolution source. */
  readonly guideView: GPUTextureView;
  readonly guideSize: Dimensions;
}

/** segment (x0, y0, x1, y1) followed by brush (radius, hardness, polarity, unused). */
const FLOATS_PER_INSTANCE = 8;
const INSTANCE_BYTES = FLOATS_PER_INSTANCE * 4;

const OPERATION = { invert: 0, replace: 1, add: 2, subtract: 3 } as const;
type OperationName = keyof typeof OPERATION;

/**
 * The selection, as GPU-resident coverage at output resolution.
 *
 * Rebuilt by replaying the command log rather than mutated in place. That makes
 * undo, redo and recovery from a lost GPU device the same operation, and means
 * no edit ever costs a full-resolution snapshot.
 *
 * A stroke in progress is stamped incrementally on top of what is already
 * there — correct precisely because `max` blending is idempotent, so
 * re-stamping a segment already present changes nothing.
 *
 * WRITES WITHIN A FRAME NEVER OVERLAP. Every stamp appends to a fresh region of
 * the instance buffer and every operation binds a uniform written once at
 * construction, because `queue.writeBuffer` is ordered against submission
 * rather than against the encoder: rewriting one range between two recorded
 * draws would give both draws the second value.
 */
export class SelectionMask {
  /** Texture dimensions: the output resolution the composite runs at. */
  readonly width: number;
  readonly height: number;
  /**
   * Dimensions of the space stroke coordinates are expressed in — always SOURCE
   * pixels, which differ from the texture size when a large image is previewed
   * below its native resolution.
   *
   * Keeping the two apart is what lets export replay the same commands into a
   * larger mask with no rescaling: a stroke's position and radius are
   * resolution-independent facts about the photograph.
   */
  readonly imageWidth: number;
  readonly imageHeight: number;

  readonly #device: GPUDevice;
  readonly #pool = new ResourcePool();
  /** Two targets: a whole-mask operation cannot read and write one texture. */
  readonly #textures: readonly [GPUTexture, GPUTexture];
  #current = 0;

  readonly #brushPipelines: { readonly paint: GPURenderPipeline; readonly erase: GPURenderPipeline };
  /**
   * Built on the first rectangle, not in the constructor.
   *
   * Most documents never hold one, and a SelectionMask is constructed per
   * image, per export and per test case — so two pipelines nobody asked for is
   * exactly the churn the Dawn Node bindings are least stable under. The mask
   * refiner compiles its own the same way and for the same reason.
   */
  #rectPipelines: { readonly paint: GPURenderPipeline; readonly erase: GPURenderPipeline } | undefined;
  readonly #brushPipelineLayout: GPUPipelineLayout;
  readonly #brushBindGroup: GPUBindGroup;

  #instanceBuffer: GPUBuffer;
  #instanceCapacity: number;
  #instanceCursor = 0;
  /**
   * Resources a recorded command still references.
   *
   * Recording a command does not consume its inputs — they are read when the
   * command buffer is submitted. Destroying anything here before the frame is
   * submitted fails validation with "destroyed texture used in a submit", so
   * they are held until the next frame begins.
   */
  #retired: { destroy(): void }[] = [];

  readonly #opPass: FullscreenPass;
  readonly #opBindGroupLayout: GPUBindGroupLayout;
  readonly #opUniforms: Record<OperationName, GPUBuffer>;
  readonly #sampler: GPUSampler;
  /** Bound in the `source` slot when an operation does not use one. */
  readonly #placeholder: GPUTexture;

  constructor(device: GPUDevice, width: number, height: number, imageWidth = width, imageHeight = height) {
    this.#device = device;
    this.width = width;
    this.height = height;
    this.imageWidth = imageWidth;
    this.imageHeight = imageHeight;

    const descriptor: GPUTextureDescriptor = {
      label: 'selection-mask',
      size: { width, height },
      format: MASK_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    };
    this.#textures = [this.#pool.texture(device, descriptor), this.#pool.texture(device, descriptor)];

    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.#placeholder = this.#pool.texture(device, {
      label: 'mask-placeholder',
      size: { width: 1, height: 1 },
      format: MASK_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // --- brush stamping ---
    const brushUniforms = this.#pool.buffer(device, {
      label: 'brush-uniforms',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Written once: the image size cannot change for a loaded document.
    device.queue.writeBuffer(brushUniforms, 0, new Float32Array([imageWidth, imageHeight, 0, 0]));

    this.#instanceCapacity = 4096;
    this.#instanceBuffer = this.#createInstanceBuffer(this.#instanceCapacity);

    const brushLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.#brushBindGroup = device.createBindGroup({
      layout: brushLayout,
      entries: [{ binding: 0, resource: { buffer: brushUniforms } }],
    });

    const brushModule = device.createShaderModule({ label: 'brush-stamp', code: brushStampWgsl });
    const brushPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [brushLayout] });
    this.#brushPipelineLayout = brushPipelineLayout;
    const makeBrushPipeline = (operation: GPUBlendOperation): GPURenderPipeline =>
      device.createRenderPipeline({
        label: `brush-stamp-${operation}`,
        layout: brushPipelineLayout,
        vertex: {
          module: brushModule,
          entryPoint: 'vertexMain',
          buffers: [
            {
              arrayStride: INSTANCE_BYTES,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x4' },
                { shaderLocation: 1, offset: 16, format: 'float32x4' },
              ],
            },
          ],
        },
        fragment: {
          module: brushModule,
          entryPoint: 'fragmentMain',
          targets: [
            {
              format: MASK_FORMAT,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation },
                alpha: { srcFactor: 'one', dstFactor: 'one', operation },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
      });

    this.#brushPipelines = { paint: makeBrushPipeline('max'), erase: makeBrushPipeline('min') };

    // --- whole-mask operations ---
    // One buffer per operation, each written once, so several operations can be
    // recorded into a single frame without overwriting one another.
    const makeOpUniform = (name: OperationName): GPUBuffer => {
      const buffer = this.#pool.buffer(device, {
        label: `mask-op-${name}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buffer, 0, new Float32Array([OPERATION[name], 0, 0, 0]));
      return buffer;
    };
    this.#opUniforms = {
      invert: makeOpUniform('invert'),
      replace: makeOpUniform('replace'),
      add: makeOpUniform('add'),
      subtract: makeOpUniform('subtract'),
    };

    this.#opBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.#opPass = new FullscreenPass({
      label: 'mask-op',
      device,
      fragmentWgsl: `${colorWgsl}\n${maskOpWgsl}`,
      bindGroupLayout: this.#opBindGroupLayout,
      targetFormat: MASK_FORMAT,
    });
  }

  get texture(): GPUTexture {
    const [a, b] = this.#textures;
    return this.#current === 0 ? a : b;
  }

  #back(): GPUTexture {
    const [a, b] = this.#textures;
    return this.#current === 0 ? b : a;
  }

  #createInstanceBuffer(capacity: number): GPUBuffer {
    return this.#device.createBuffer({
      label: 'brush-instances',
      size: capacity * INSTANCE_BYTES,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Start recording a new frame.
   *
   * Resets the instance cursor and releases the resources the previous frame's
   * commands referenced, now that those commands have been submitted.
   */
  beginFrame(): void {
    this.#instanceCursor = 0;
    for (const resource of this.#retired) resource.destroy();
    this.#retired.length = 0;
  }

  #reserve(instances: number): number {
    if (this.#instanceCursor + instances > this.#instanceCapacity) {
      // Grow without invalidating draws already recorded this frame.
      this.#retired.push(this.#instanceBuffer);
      this.#instanceCapacity = Math.max(this.#instanceCursor + instances, this.#instanceCapacity * 2);
      this.#instanceBuffer = this.#createInstanceBuffer(this.#instanceCapacity);
      this.#instanceCursor = 0;
    }
    const offset = this.#instanceCursor;
    this.#instanceCursor += instances;
    return offset;
  }

  /** Wipe coverage to zero. */
  clear(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginRenderPass({
      label: 'mask-clear',
      colorAttachments: [
        {
          view: this.texture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.end();
  }

  /**
   * Stamp stroke segments.
   *
   * `from` lets a live stroke contribute only the samples added since the last
   * frame, leaving the already-stamped prefix alone.
   */
  stamp(encoder: GPUCommandEncoder, stroke: BrushStroke, mode: 'paint' | 'erase', from = 0): void {
    const points = stroke.points;
    if (points.length === 0) return;

    const start = Math.max(0, from - 1);
    if (points.length > 1 && start >= points.length - 1) return;
    // A single sample is a dot, expressed as a degenerate segment, so that a
    // tap still marks the image.
    const segmentCount = points.length === 1 ? 1 : points.length - 1 - start;

    const base = this.#reserve(segmentCount);
    const polarity = mode === 'paint' ? 1 : -1;
    const data = new Float32Array(segmentCount * FLOATS_PER_INSTANCE);

    for (let i = 0; i < segmentCount; i++) {
      const a = points[start + i];
      if (!a) continue;
      const b = points[start + i + 1] ?? a;
      data.set([a.x, a.y, b.x, b.y, stroke.radius, stroke.hardness, polarity, 0], i * FLOATS_PER_INSTANCE);
    }
    this.#device.queue.writeBuffer(this.#instanceBuffer, base * INSTANCE_BYTES, data);

    const pass = encoder.beginRenderPass({
      label: `brush-${mode}`,
      colorAttachments: [{ view: this.texture.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.#brushPipelines[mode]);
    pass.setBindGroup(0, this.#brushBindGroup);
    pass.setVertexBuffer(0, this.#instanceBuffer, base * INSTANCE_BYTES, segmentCount * INSTANCE_BYTES);
    pass.draw(6, segmentCount);
    pass.end();
  }

  /**
   * A rectangle is the brush's machinery with a different distance function, so
   * it borrows the vertex layout, the uniform, the bind group and the two blend
   * modes, and brings only its own shader.
   */
  #ensureRectPipelines(): { readonly paint: GPURenderPipeline; readonly erase: GPURenderPipeline } {
    const existing = this.#rectPipelines;
    if (existing) return existing;

    const device = this.#device;
    const rectModule = device.createShaderModule({ label: 'rect-stamp', code: rectStampWgsl });
    const makeRectPipeline = (operation: GPUBlendOperation): GPURenderPipeline =>
      device.createRenderPipeline({
        label: `rect-stamp-${operation}`,
        layout: this.#brushPipelineLayout,
        vertex: {
          module: rectModule,
          entryPoint: 'vertexMain',
          buffers: [
            {
              arrayStride: INSTANCE_BYTES,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x4' },
                { shaderLocation: 1, offset: 16, format: 'float32x4' },
              ],
            },
          ],
        },
        fragment: {
          module: rectModule,
          entryPoint: 'fragmentMain',
          targets: [
            {
              format: MASK_FORMAT,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation },
                alpha: { srcFactor: 'one', dstFactor: 'one', operation },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
      });

    const pipelines = { paint: makeRectPipeline('max'), erase: makeRectPipeline('min') };
    this.#rectPipelines = pipelines;
    return pipelines;
  }

  /** Stamp one rectangle. Shares the brush's instance ring, so it is fenced with it. */
  stampRect(encoder: GPUCommandEncoder, rect: SelectionRect, mode: 'paint' | 'erase'): void {
    const base = this.#reserve(1);
    const polarity = mode === 'paint' ? 1 : -1;
    this.#device.queue.writeBuffer(
      this.#instanceBuffer,
      base * INSTANCE_BYTES,
      new Float32Array([rect.x0, rect.y0, rect.x1, rect.y1, 0, 0, polarity, 0]),
    );

    const pass = encoder.beginRenderPass({
      label: `rect-${mode}`,
      colorAttachments: [{ view: this.texture.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.#ensureRectPipelines()[mode]);
    pass.setBindGroup(0, this.#brushBindGroup);
    pass.setVertexBuffer(0, this.#instanceBuffer, base * INSTANCE_BYTES, INSTANCE_BYTES);
    pass.draw(6, 1);
    pass.end();
  }

  #runOperation(encoder: GPUCommandEncoder, operation: OperationName, source?: GPUTexture): void {
    const bindGroup = this.#device.createBindGroup({
      layout: this.#opBindGroupLayout,
      entries: [
        { binding: 0, resource: this.texture.createView() },
        { binding: 1, resource: (source ?? this.#placeholder).createView() },
        { binding: 2, resource: this.#sampler },
        { binding: 3, resource: { buffer: this.#opUniforms[operation] } },
      ],
    });
    this.#opPass.run(encoder, this.#back().createView(), bindGroup);
    this.#current = 1 - this.#current;
  }

  invert(encoder: GPUCommandEncoder): void {
    this.#runOperation(encoder, 'invert');
  }

  /**
   * The one route from an externally produced mask into the render mask.
   *
   * A segmentation or tracking engine analyses the whole scene and may know
   * about objects the user has not selected. None of that reaches the renderer
   * except through this call, applied deliberately and recorded in the command
   * log like any other edit.
   *
   * An engine mask is a few hundred pixels square whatever the photograph is,
   * so something has to decide where its boundary really lies. With `refine`
   * set that is the guided filter, reading the image itself; without it the
   * sampler simply magnifies, which is correct for a mask that already has the
   * resolution it needs.
   */
  applyCoverage(
    encoder: GPUCommandEncoder,
    command: Extract<SelectionCommand, { kind: 'applyMask' }>,
    context?: MaskReplayContext,
  ): void {
    const { mask, op, refine } = command;
    const staging = this.#device.createTexture({
      label: 'applied-coverage',
      size: { width: mask.width, height: mask.height },
      format: MASK_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.writeTexture(
      { texture: staging },
      mask.coverage,
      { bytesPerRow: mask.width, rowsPerImage: mask.height },
      { width: mask.width, height: mask.height },
    );
    // Held until the next frame: the passes below read these textures when the
    // command buffer is submitted, not when it is recorded.
    this.#retired.push(staging);

    let incoming = staging;
    if (refine) {
      if (!context) {
        // Silently magnifying instead would produce a plausible mask with the
        // wrong boundary, which is far worse than refusing.
        throw new Error('SelectionMask: a refined mask needs a replay context to refine against');
      }
      const refined = this.#device.createTexture({
        label: 'refined-coverage',
        size: { width: this.width, height: this.height },
        format: MASK_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.#retired.push(refined);
      context.refiner.refine(encoder, {
        guideView: context.guideView,
        guideSize: context.guideSize,
        coarse: staging,
        target: refined.createView(),
        targetSize: { width: this.width, height: this.height },
        settings: refine,
      });
      incoming = refined;
    }

    this.#runOperation(encoder, op, incoming);
  }

  /** Rebuild the whole mask from a command log. */
  replay(
    encoder: GPUCommandEncoder,
    commands: readonly SelectionCommand[],
    context?: MaskReplayContext,
  ): void {
    this.clear(encoder);
    for (const command of commands) {
      switch (command.kind) {
        case 'paint':
          this.stamp(encoder, command.stroke, 'paint');
          break;
        case 'erase':
          this.stamp(encoder, command.stroke, 'erase');
          break;
        case 'clear':
          this.clear(encoder);
          break;
        case 'rect':
          this.stampRect(encoder, command.rect, command.mode);
          break;
        case 'invert':
          this.invert(encoder);
          break;
        case 'applyMask':
          this.applyCoverage(encoder, command, context);
          break;
      }
    }
  }

  dispose(): void {
    for (const resource of this.#retired) resource.destroy();
    this.#retired.length = 0;
    this.#instanceBuffer.destroy();
    this.#pool.dispose();
  }
}
