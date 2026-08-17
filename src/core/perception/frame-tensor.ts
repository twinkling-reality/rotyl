import { FullscreenPass } from '../gpu/fullscreen-pass.ts';
import { ResourcePool } from '../gpu/resource-pool.ts';
import type { Dimensions } from '../render/resolution.ts';
import colorWgsl from '../color/color.wgsl?raw';
import frameTensorWgsl from './wgsl/frame-tensor.wgsl?raw';

/**
 * The image as a model input tensor, built on the GPU.
 *
 * The alternative is the usual one: draw the image into a canvas at the model's
 * resolution, read the pixels back, and normalise them in JavaScript. That
 * costs a full-resolution CPU resize of a photograph that is already sitting in
 * GPU memory, and then twelve megabytes of upload to put the result back. Doing
 * it here is a single fullscreen pass over a million pixels and one buffer that
 * never leaves the device.
 *
 * Keeping it in `core` is what makes it testable: the layout, the colour space
 * and the normalisation are the three things that are silently wrong if they
 * are wrong, and all three can be checked by running the real shader.
 */

/** The single-channel planes; see the shader for why the tensor is not interleaved. */
const PLANE_FORMAT = 'r32float' satisfies GPUTextureFormat;
const BYTES_PER_FLOAT = 4;

export interface FrameTensorLayout {
  /** Square edge the model expects, e.g. 1024. */
  readonly size: number;
  /** Per-channel normalisation, in sRGB-encoded [0,1] units. */
  readonly mean: readonly [number, number, number];
  readonly std: readonly [number, number, number];
}

export class FrameTensorEncoder {
  readonly layout: FrameTensorLayout;
  /** Element count of the tensor this produces, as [1, 3, size, size]. */
  readonly dimensions: readonly [number, number, number, number];

  readonly #device: GPUDevice;
  readonly #pool = new ResourcePool();
  readonly #planes: readonly GPUTextureView[];
  readonly #planeTextures: readonly GPUTexture[];
  readonly #pass: FullscreenPass;
  readonly #bindGroupLayout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;
  readonly #uniforms: GPUBuffer;
  readonly #tensor: GPUBuffer;

  constructor(device: GPUDevice, layout: FrameTensorLayout) {
    // Texture-to-buffer copies require a row stride that is a multiple of 256.
    // Every model size worth using satisfies it, and the failure otherwise is a
    // validation message about alignment several layers from the cause.
    if ((layout.size * BYTES_PER_FLOAT) % 256 !== 0) {
      throw new Error(`FrameTensorEncoder: a size of ${String(layout.size)} does not give a 256-byte row`);
    }

    this.#device = device;
    this.layout = layout;
    this.dimensions = [1, 3, layout.size, layout.size];

    const planes = [0, 1, 2].map((index) =>
      this.#pool.texture(device, {
        label: `frame-tensor:plane-${String(index)}`,
        size: { width: layout.size, height: layout.size },
        format: PLANE_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      }),
    );
    this.#planeTextures = planes;
    this.#planes = planes.map((texture) => texture.createView());

    // Mappable, because the tensor has to be read out. A runtime sharing this
    // device could have bound it directly; the one used here creates its own
    // device whatever it is handed, so a buffer of ours is not a buffer it can
    // see. Crossing back to the CPU costs twelve megabytes and saves a
    // full-resolution resize of the photograph in JavaScript, which is why this
    // pass still earns its place.
    this.#tensor = this.#pool.buffer(device, {
      label: 'frame-tensor',
      size: 3 * layout.size * layout.size * BYTES_PER_FLOAT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.#uniforms = this.#pool.buffer(device, {
      label: 'frame-tensor-uniforms',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.#bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    this.#pass = new FullscreenPass({
      label: 'frame-tensor',
      device,
      fragmentWgsl: `${colorWgsl}\n${frameTensorWgsl}`,
      bindGroupLayout: this.#bindGroupLayout,
      targetFormat: [PLANE_FORMAT, PLANE_FORMAT, PLANE_FORMAT],
    });
  }

  /**
   * The encoded tensor, as the runtime wants it.
   *
   * Mapping waits for the submitted work by definition, so there is no separate
   * fence to get wrong. Copying out of the mapped range is not optional: the
   * range is detached on unmap, and a runtime holding it would be reading freed
   * memory.
   */
  async read(): Promise<Float32Array> {
    await this.#tensor.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(this.#tensor.getMappedRange().slice(0));
    this.#tensor.unmap();
    return values;
  }

  /**
   * Record the encode.
   *
   * ONE ENCODE PER FRAME. The uniform buffer is written here, and
   * `queue.writeBuffer` is ordered against submission rather than against the
   * encoder, so a second encode in the same frame would give both passes the
   * second image's footprint. Encoding happens once when an image is loaded, so
   * this costs nothing to honour and everything to get wrong.
   */
  encode(encoder: GPUCommandEncoder, sourceView: GPUTextureView, sourceSize: Dimensions): void {
    const { size, mean, std } = this.layout;
    this.#device.queue.writeBuffer(
      this.#uniforms,
      0,
      new Float32Array([
        sourceSize.width / size,
        sourceSize.height / size,
        1 / sourceSize.width,
        1 / sourceSize.height,
        mean[0],
        mean[1],
        mean[2],
        0,
        1 / std[0],
        1 / std[1],
        1 / std[2],
        0,
      ]),
    );

    this.#pass.runTargets(
      encoder,
      this.#planes,
      this.#device.createBindGroup({
        layout: this.#bindGroupLayout,
        entries: [
          { binding: 0, resource: sourceView },
          { binding: 1, resource: this.#sampler },
          { binding: 2, resource: { buffer: this.#uniforms } },
        ],
      }),
    );

    // Three copies, one per plane, into the contiguous NCHW layout. The row
    // stride is size * 4 bytes, which is a multiple of 256 for every model size
    // worth using, so no de-padding is needed on the far side.
    const planeBytes = size * size * BYTES_PER_FLOAT;
    this.#planeTextures.forEach((texture, index) => {
      encoder.copyTextureToBuffer(
        { texture },
        {
          buffer: this.#tensor,
          offset: index * planeBytes,
          bytesPerRow: size * BYTES_PER_FLOAT,
          rowsPerImage: size,
        },
        { width: size, height: size },
      );
    });
  }

  dispose(): void {
    this.#pool.dispose();
  }
}
