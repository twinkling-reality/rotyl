import { OUTPUT_FORMAT, OUTPUT_VIEW_FORMAT } from '../core/gpu/formats.ts';
import { exportDimensions, renderExport } from '../core/render/export-renderer.ts';
import { decodeImageFile } from './image-file.ts';
import { uploadImageToTexture } from './texture-upload.ts';
import { SOURCE_FORMAT, SOURCE_VIEW_FORMAT } from '../core/gpu/formats.ts';
import type { SelectionCommand } from '../core/document/selection-command.ts';
import type { StyleControls, StyleDefinition } from '../core/style/style.ts';
import type { CompositeRenderer } from '../core/render/composite-renderer.ts';
import type { MaskRefiner } from '../core/mask/mask-refiner.ts';

export type ExportFormat = 'png' | 'jpeg';

/**
 * Where the full-resolution pixels come from.
 *
 * Export does not re-read the preview texture, which may have been capped for
 * memory. It goes back to the original. What "the original" is differs between
 * a photograph and a frame of a video, and this is the whole of that
 * difference: everything after it is one path.
 */
export interface ExportSource {
  readonly width: number;
  readonly height: number;
  /** Fill a texture of exactly these dimensions. */
  fill(device: GPUDevice, texture: GPUTexture): Promise<void>;
  /** Always called, including when the render fails. */
  release(): void;
}

/** The original photograph, decoded again at full size. */
export async function imageFileSource(file: Blob, maxDimension: number): Promise<ExportSource> {
  const decoded = await decodeImageFile(file, maxDimension);
  if (!decoded.ok) throw new Error('The original file could no longer be decoded.');
  const { bitmap, width, height } = decoded.value;
  return {
    width,
    height,
    fill(device, texture) {
      uploadImageToTexture(device, bitmap, texture);
      return Promise.resolve();
    },
    release() {
      // An ImageBitmap holds a full RGBA copy: 192 MB for a 48 megapixel photograph.
      bitmap.close();
    },
  };
}

export interface ExportOptions {
  readonly device: GPUDevice;
  readonly maxTextureDimension: number;
  /** Borrowed from the engine so export does not duplicate the pipeline set. */
  readonly renderer: CompositeRenderer;
  readonly refiner: MaskRefiner;
  readonly source: ExportSource;
  readonly commands: readonly SelectionCommand[];
  readonly style: StyleDefinition;
  readonly controls: StyleControls;
  readonly format: ExportFormat;
}

export interface ExportResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

const JPEG_QUALITY = 0.92;

/**
 * Render and encode the finished image at full resolution.
 *
 * The source is decoded again from the original file rather than reusing the
 * preview texture, which may have been capped for memory. Everything else, the
 * style chain, the parameters, the composite, is the same code the preview
 * ran, so this cannot drift from what the user was looking at.
 *
 * An OffscreenCanvas is used as the render target purely because
 * `convertToBlob` then encodes straight from GPU memory. The alternative,
 * copying the texture back into a buffer and encoding by hand, measured an
 * order of magnitude slower and requires de-padding every row to undo the
 * 256-byte alignment WebGPU imposes on texture-to-buffer copies.
 */
export async function exportImage(options: ExportOptions): Promise<ExportResult> {
  const { device, maxTextureDimension, renderer, refiner, source, commands, style, controls, format } =
    options;
  const { width, height } = source;

  // Everything from here is inside the try: a full-resolution source texture is
  // hundreds of megabytes, and every step below can fail.
  let sourceTexture: GPUTexture | undefined;
  try {
    sourceTexture = device.createTexture({
      label: 'export-source',
      size: { width, height },
      format: SOURCE_FORMAT,
      viewFormats: [SOURCE_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    await source.fill(device, sourceTexture);

    const size = exportDimensions({ width, height }, maxTextureDimension);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not create a rendering context for export.');
    context.configure({
      device,
      format: OUTPUT_FORMAT,
      viewFormats: [OUTPUT_VIEW_FORMAT],
      // Matches the preview canvas, so the exported file is the image that was
      // on screen. Source transparency is flattened in both.
      alphaMode: 'opaque',
    });

    // Validation errors in WebGPU are asynchronous, createTexture returns an
    // object and reports the failure later, so a failed allocation would
    // otherwise be discovered as a silently blank download.
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');

    await renderExport({
      device,
      renderer,
      refiner,
      sourceTexture,
      sourceSize: { width, height },
      commands,
      style,
      controls,
      target: context.getCurrentTexture(),
    });

    const validationError = await device.popErrorScope();
    const memoryError = await device.popErrorScope();
    if (memoryError) throw new Error('Not enough graphics memory to export this image at full size.');
    if (validationError) throw new Error(`Export failed while rendering: ${validationError.message}`);

    const type = format === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await canvas.convertToBlob(format === 'jpeg' ? { type, quality: JPEG_QUALITY } : { type });
    // An unsupported type is not an error: the canvas silently falls back to
    // PNG, which would otherwise ship a .jpg file containing PNG bytes.
    if (blob.type !== type) {
      throw new Error(`This browser cannot encode ${type}.`);
    }
    return { blob, width: size.width, height: size.height };
  } finally {
    source.release();
    sourceTexture?.destroy();
  }
}

/**
 * Filename for an export, derived from the original.
 *
 * A frame number when there is one, because exporting three frames of the same
 * clip would otherwise write the same name three times.
 */
export function exportFilename(originalName: string, format: ExportFormat, frame?: number): string {
  const stem = originalName.replace(/\.[^.]+$/, '') || 'image';
  const at = frame === undefined ? '' : `-f${String(frame + 1).padStart(5, '0')}`;
  return `${stem}-rotyl${at}.${format === 'png' ? 'png' : 'jpg'}`;
}
