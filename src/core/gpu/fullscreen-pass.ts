import fullscreenVertexWgsl from './fullscreen-vertex.wgsl?raw';

/**
 * Every stage of the style chain is the same shape: read some textures, write
 * one, one fragment per output pixel. This is that shape.
 *
 * A fullscreen *triangle*, not a quad: a quad's diagonal seam makes the GPU
 * run helper invocations twice along it for no benefit. Three vertices are
 * generated from the vertex index, so there is no vertex buffer, no index
 * buffer and no geometry to keep in sync with anything.
 *
 * Pipeline layouts are explicit rather than `'auto'`. Auto-generated layouts
 * are private to the pipeline that created them, which silently prevents one
 * bind group from serving several passes and forces per-pass duplicates.
 */
export interface FullscreenPassOptions {
  readonly label: string;
  readonly device: GPUDevice;
  /** Fragment WGSL. The shared vertex stage is prepended automatically. */
  readonly fragmentWgsl: string;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly targetFormat: GPUTextureFormat;
  readonly entryPoint?: string;
}

export class FullscreenPass {
  readonly pipeline: GPURenderPipeline;
  readonly #label: string;

  constructor(options: FullscreenPassOptions) {
    const { device, label, fragmentWgsl, bindGroupLayout, targetFormat } = options;
    this.#label = label;

    const module = device.createShaderModule({
      label: `${label}:module`,
      code: `${fullscreenVertexWgsl}\n${fragmentWgsl}`,
    });

    this.pipeline = device.createRenderPipeline({
      label,
      layout: device.createPipelineLayout({
        label: `${label}:layout`,
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: {
        module,
        entryPoint: options.entryPoint ?? 'fragmentMain',
        targets: [{ format: targetFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  /**
   * `loadOp` is always `'clear'`: the pass covers every pixel of its target, so
   * asking the tiler to read the previous contents first is pure waste.
   */
  run(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    bindGroup: GPUBindGroup,
    dynamicOffsets?: readonly number[],
  ): void {
    const pass = encoder.beginRenderPass({
      label: this.#label,
      colorAttachments: [
        {
          view: targetView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    if (dynamicOffsets) {
      pass.setBindGroup(0, bindGroup, [...dynamicOffsets]);
    } else {
      pass.setBindGroup(0, bindGroup);
    }
    pass.draw(3);
    pass.end();
  }
}

/** Uniform buffer slots must start on a 256-byte boundary. */
const SLOT_BYTES = 256;
const FLOATS_PER_SLOT = SLOT_BYTES / 4;

/**
 * One uniform buffer, one write per frame, a 256-byte slot per pass.
 *
 * The alternative — a buffer per pass, or a write per pass — turns a
 * nineteen-stage chain into nineteen queue operations per frame for data that
 * totals under five kilobytes.
 */
export class UniformRing {
  readonly buffer: GPUBuffer;
  readonly #staging: Float32Array;

  constructor(device: GPUDevice, slots: number, label = 'uniforms') {
    this.buffer = device.createBuffer({
      label,
      size: slots * SLOT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#staging = new Float32Array(slots * FLOATS_PER_SLOT);
  }

  write(slot: number, values: readonly number[]): void {
    if (values.length > FLOATS_PER_SLOT) {
      throw new Error(`UniformRing: ${values.length} floats exceeds the ${FLOATS_PER_SLOT}-float slot`);
    }
    this.#staging.set(values, slot * FLOATS_PER_SLOT);
  }

  offsetOf(slot: number): number {
    return slot * SLOT_BYTES;
  }

  flush(queue: GPUQueue): void {
    queue.writeBuffer(this.buffer, 0, this.#staging);
  }

  destroy(): void {
    this.buffer.destroy();
  }
}
