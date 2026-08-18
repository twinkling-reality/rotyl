// Somewhere to put a picture, run a style over it, and get the bytes back.
//
// The style chain is driven through the REAL CompositeRenderer with a mask of
// full coverage, so what comes back is the same texture export writes: the
// style's own fade folded in, written through an sRGB view, one byte per
// channel. Reimplementing the composite here would measure a different picture
// from the one the product makes, which is the one failure a bench of this kind
// cannot afford.
//
// Every number taken through this file is fenced with onSubmittedWorkDone on
// the device that did the work. rAF appears nowhere; see video-bench/util.ts.

import { CompositeRenderer } from '../../src/core/render/composite-renderer.ts';
import {
  MASK_FORMAT,
  OUTPUT_FORMAT,
  OUTPUT_VIEW_FORMAT,
  SOURCE_FORMAT,
  SOURCE_VIEW_FORMAT,
} from '../../src/core/gpu/formats.ts';
import type { Dimensions } from '../../src/core/render/resolution.ts';
import type { StyleControls, StyleDefinition, StyleQuality } from '../../src/core/style/style.ts';

export const CLIPS = '/tools/style-bench/clips';
export const SCENE = `${CLIPS}/scene.png`;

/** copyTextureToBuffer wants a row stride that is a multiple of 256. */
const ROW_ALIGN = 256;

export class StyleStage {
  readonly size: Dimensions;

  readonly #device: GPUDevice;
  readonly #source: GPUTexture;
  readonly #mask: GPUTexture;
  readonly #output: GPUTexture;
  readonly #composite: CompositeRenderer;
  readonly #readback: GPUBuffer;
  readonly #paddedRow: number;

  constructor(device: GPUDevice, size: Dimensions) {
    this.#device = device;
    this.size = size;
    this.#composite = new CompositeRenderer(device);

    this.#source = device.createTexture({
      label: 'bench:source',
      size: { width: size.width, height: size.height },
      format: SOURCE_FORMAT,
      viewFormats: [SOURCE_VIEW_FORMAT],
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#output = device.createTexture({
      label: 'bench:output',
      size: { width: size.width, height: size.height },
      format: OUTPUT_FORMAT,
      viewFormats: [OUTPUT_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    // Full coverage everywhere: this bench is about what a style produces, and
    // the selection is measured elsewhere.
    this.#mask = device.createTexture({
      label: 'bench:mask',
      size: { width: size.width, height: size.height },
      format: MASK_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const row = new Uint8Array(size.width).fill(255);
    const block = new Uint8Array(size.width * 64).fill(255);
    for (let y = 0; y < size.height; y += 64) {
      const rows = Math.min(64, size.height - y);
      device.queue.writeTexture(
        { texture: this.#mask, origin: { x: 0, y } },
        block.subarray(0, row.length * rows),
        { bytesPerRow: size.width, rowsPerImage: rows },
        { width: size.width, height: rows },
      );
    }

    this.#paddedRow = Math.ceil((size.width * 4) / ROW_ALIGN) * ROW_ALIGN;
    this.#readback = device.createBuffer({
      label: 'bench:readback',
      size: this.#paddedRow * size.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  uploadImage(source: ImageBitmap | VideoFrame): void {
    this.#device.queue.copyExternalImageToTexture(
      { source, flipY: false },
      { texture: this.#source, premultipliedAlpha: false },
      { width: this.size.width, height: this.size.height },
    );
  }

  /** Bytes straight in, for a perturbation whose exact size has to be known. */
  uploadBytes(rgba: Uint8Array): void {
    this.#device.queue.writeTexture(
      { texture: this.#source },
      rgba,
      { bytesPerRow: this.size.width * 4, rowsPerImage: this.size.height },
      { width: this.size.width, height: this.size.height },
    );
  }

  /**
   * One render, submitted and fenced.
   *
   * `composite` is off for a pure timing of the style chain, which is what the
   * README's table means, and on when the bytes are going to be read.
   */
  async render(
    style: StyleDefinition,
    controls: StyleControls,
    quality: StyleQuality,
    composite = false,
  ): Promise<void> {
    const encoder = this.#device.createCommandEncoder({ label: 'bench:frame' });
    this.#composite.renderStyle(encoder, {
      sourceTexture: this.#source,
      sourceSize: this.size,
      outputSize: this.size,
      style,
      controls,
      quality,
    });
    if (composite) {
      this.#composite.composite(
        encoder,
        this.#source,
        this.#mask,
        this.#output.createView({ format: OUTPUT_VIEW_FORMAT }),
      );
    }
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
  }

  /** The composited result, tightly packed RGBA. */
  async readOutput(): Promise<Uint8Array> {
    return this.#read(this.#output);
  }

  /** The source as the chain saw it, for the denominator of an amplification. */
  async readSource(): Promise<Uint8Array> {
    return this.#read(this.#source);
  }

  async #read(texture: GPUTexture): Promise<Uint8Array> {
    const encoder = this.#device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: this.#readback, bytesPerRow: this.#paddedRow, rowsPerImage: this.size.height },
      { width: this.size.width, height: this.size.height },
    );
    this.#device.queue.submit([encoder.finish()]);
    await this.#readback.mapAsync(GPUMapMode.READ);

    const padded = new Uint8Array(this.#readback.getMappedRange());
    const tight = new Uint8Array(this.size.width * this.size.height * 4);
    const rowBytes = this.size.width * 4;
    for (let y = 0; y < this.size.height; y++) {
      tight.set(padded.subarray(y * this.#paddedRow, y * this.#paddedRow + rowBytes), y * rowBytes);
    }
    this.#readback.unmap();
    return tight;
  }

  dispose(): void {
    this.#composite.dispose();
    this.#source.destroy();
    this.#output.destroy();
    this.#mask.destroy();
    this.#readback.destroy();
  }
}

/**
 * How far two renders of the same scene are apart, in output codes.
 *
 * Per pixel, the largest of the three channel differences: a band that flips or
 * a line that moves is a large change on one or two channels, and averaging
 * across channels would divide exactly the signal being looked for by three.
 *
 * `mean` is what a difference metric usually reports and is the least useful
 * number here — boiling is a small proportion of pixels moving a long way, not
 * every pixel moving a little. `p99` and `flicker` are the ones to read.
 */
export interface Difference {
  /** Mean per-pixel difference, in 8-bit codes. */
  readonly mean: number;
  /** 99th percentile of the same. */
  readonly p99: number;
  /** Percentage of pixels moving more than 8 codes, which is plainly visible. */
  readonly flicker: number;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

export function difference(a: Uint8Array, b: Uint8Array): Difference {
  const histogram = new Float64Array(256);
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)),
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)),
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)),
    );
    histogram[d] = (histogram[d] ?? 0) + 1;
  }

  const pixels = a.length / 4;
  let total = 0;
  let seen = 0;
  let p99 = 0;
  let flicker = 0;
  for (let d = 0; d < 256; d++) {
    const count = histogram[d] ?? 0;
    total += d * count;
    seen += count;
    if (p99 === 0 && seen >= pixels * 0.99) p99 = d;
    if (d > 8) flicker += count;
  }

  return {
    mean: round(total / pixels),
    p99,
    flicker: round((flicker / pixels) * 100),
  };
}

/** How much more a style moved than its input did. */
export function amplification(styled: Difference, source: Difference): Record<string, number> {
  const ratio = (a: number, b: number): number => (b === 0 ? 0 : round(a / b));
  return {
    mean: ratio(styled.mean, source.mean),
    p99: ratio(styled.p99, source.p99),
  };
}

export async function loadScene(width: number, height: number): Promise<ImageBitmap> {
  const blob = await (await fetch(SCENE)).blob();
  return createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
}

/** The scene as bytes, so a perturbation can be applied and measured exactly. */
export async function sceneBytes(width: number, height: number): Promise<Uint8Array> {
  const bitmap = await loadScene(width, height);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
}
