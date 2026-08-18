import { ExportRenderer, exportDimensions } from '../../core/render/export-renderer.ts';
import {
  OUTPUT_FORMAT,
  OUTPUT_VIEW_FORMAT,
  SOURCE_FORMAT,
  SOURCE_VIEW_FORMAT,
} from '../../core/gpu/formats.ts';
import { stillSink } from './still-sink.ts';
import type { Dimensions } from '../../core/render/resolution.ts';
import type { SelectionCommand } from '../../core/document/selection-command.ts';
import type { StyleControls, StyleDefinition } from '../../core/style/style.ts';
import type { CompositeRenderer } from '../../core/render/composite-renderer.ts';
import type { MaskRefiner } from '../../core/mask/mask-refiner.ts';

/**
 * Writing the work out.
 *
 * ONE LOOP. A source hands over frames, the renderer composites each one, and a
 * sink takes them. A photograph is a one-frame document and goes through the
 * same loop once, which is the same rule the command log is built on: nothing
 * below asks which kind of file this is, only how many frames it has and where
 * they are going.
 *
 * The two seams are `ExportSource` and `FrameSink`, and everything that varies
 * lives behind one of them. A second container is an entry in the table at the
 * bottom of this file; a second codec is an entry in the one in `clip-sink.ts`.
 */

/** One frame of the document, as the thing being written needs to see it. */
export interface ExportFrame {
  /** Index into the document, which is what a command's `frame` refers to. */
  readonly index: number;
  /**
   * Presentation time in microseconds, taken from the container's own index.
   *
   * Never derived by multiplying an index by a frame rate: a variable frame
   * rate, or the two-frame offset an edit list introduces, would put a frame at
   * a time it is not at. A photograph is at zero, and nothing reads it.
   */
  readonly timestampMicros: number;
  readonly durationMicros: number;
}

/**
 * Where the full-resolution pixels come from.
 *
 * Export does not re-read the preview texture, which may have been capped for
 * memory. It goes back to the original. What "the original" is differs between
 * a photograph, one frame of a video and a whole clip, and this is the whole of
 * that difference: everything after it is one path.
 */
export interface ExportSource {
  readonly width: number;
  readonly height: number;
  /** The frames to write, in order. A photograph has one. */
  readonly frames: readonly ExportFrame[];
  /** Fill a texture of exactly these dimensions with `frame`. */
  fill(device: GPUDevice, texture: GPUTexture, frame: ExportFrame): Promise<void>;
  /** Always called, including when the render fails. */
  release(): void;
}

/**
 * Where rendered frames go.
 *
 * A sink is handed the canvas rather than pixels, because both of them want it:
 * a still encodes straight out of GPU memory with `convertToBlob`, and a clip
 * builds a `VideoFrame` from the same surface. Measured, on this machine:
 * capturing the canvas costs nothing detectable, where copying the composite
 * into a buffer and rebuilding a frame from it costs a millisecond a frame at
 * 1080p and needs every row de-padded to undo the 256-byte alignment WebGPU
 * imposes on texture-to-buffer copies.
 */
export interface FrameSink {
  /**
   * Called once, before any frame, with the size the renderer would like to
   * work at. Returns the size it will actually be given, so a sink with a
   * constraint of its own can state it rather than failing on the first frame.
   */
  open(size: Dimensions): Promise<Dimensions>;
  accept(canvas: OffscreenCanvas, frame: ExportFrame): Promise<void>;
  finish(): Promise<Blob>;
  /** Release everything. Called instead of `finish` when an export is abandoned. */
  cancel(): Promise<void>;
}

export interface ExportRequest {
  readonly device: GPUDevice;
  readonly maxTextureDimension: number;
  /** Borrowed from the engine so export does not duplicate the pipeline set. */
  readonly renderer: CompositeRenderer;
  readonly refiner: MaskRefiner;
  readonly source: ExportSource;
  readonly sink: FrameSink;
  /**
   * The whole log, not one frame's.
   *
   * Which commands are in effect on a frame is a question core answers, and an
   * export that filtered for itself could answer it differently from the
   * preview the user was looking at.
   */
  readonly commands: readonly SelectionCommand[];
  readonly style: StyleDefinition;
  readonly controls: StyleControls;
  /** Called after each frame, so a long export can say how far along it is. */
  readonly onProgress?: (written: number, total: number) => void;
  readonly signal?: AbortSignal;
}

export interface ExportResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
}

/** Thrown when an export was stopped on purpose, so a caller can stay quiet about it. */
export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'ExportCancelled';
  }
}

/**
 * Render every frame of the source and write it into the sink.
 *
 * The source is read again from the original rather than reusing the preview
 * texture, which may have been capped for memory. Everything else, the style
 * chain, the parameters, the composite, is the same code the preview ran, so
 * this cannot drift from what the user was looking at.
 */
export async function runExport(request: ExportRequest): Promise<ExportResult> {
  const { device, maxTextureDimension, renderer, refiner, source, sink, commands } = request;
  const { style, controls, onProgress, signal } = request;
  const { width, height } = source;

  // Everything from here is inside the try: a full-resolution source texture is
  // hundreds of megabytes, and every step below can fail.
  let sourceTexture: GPUTexture | undefined;
  let exporter: ExportRenderer | undefined;
  let finished = false;
  try {
    sourceTexture = device.createTexture({
      label: 'export-source',
      size: { width, height },
      format: SOURCE_FORMAT,
      viewFormats: [SOURCE_VIEW_FORMAT],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const outputSize = await sink.open(exportDimensions({ width, height }, maxTextureDimension));
    const canvas = new OffscreenCanvas(outputSize.width, outputSize.height);
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

    exporter = new ExportRenderer({
      device,
      renderer,
      refiner,
      sourceTexture,
      sourceSize: { width, height },
      outputSize,
    });

    const total = source.frames.length;
    let written = 0;
    for (const frame of source.frames) {
      if (signal?.aborted) throw new ExportCancelled();
      await source.fill(device, sourceTexture, frame);

      // Validation errors in WebGPU are asynchronous: createTexture returns an
      // object and reports the failure later, so a failed allocation would
      // otherwise be discovered as a silently blank download. Scoped per frame
      // rather than per export because the pop resolves against work the render
      // has already fenced on, so it costs nothing and a clip that fails on
      // frame five hundred says so at frame five hundred.
      device.pushErrorScope('out-of-memory');
      device.pushErrorScope('validation');
      await exporter.render(context.getCurrentTexture(), commands, frame.index, style, controls);
      const validationError = await device.popErrorScope();
      const memoryError = await device.popErrorScope();
      if (memoryError) throw new Error('Not enough graphics memory to export this at full size.');
      if (validationError) throw new Error(`Export failed while rendering: ${validationError.message}`);

      await sink.accept(canvas, frame);
      written++;
      onProgress?.(written, total);
    }

    const blob = await sink.finish();
    finished = true;
    return { blob, width: outputSize.width, height: outputSize.height, frames: total };
  } finally {
    if (!finished) await sink.cancel();
    source.release();
    exporter?.dispose();
    sourceTexture?.destroy();
  }
}

/**
 * The formats this can write, and how to reach the code that writes them.
 *
 * A SECOND CONTAINER IS AN ENTRY HERE. The clip writer is behind a dynamic
 * import because it is 41.6 KB gzipped on top of the demuxer, measured through
 * this project's own build, which is the size of the entire application bundle.
 * Someone who opens a photograph never fetches it, the same treatment the
 * inference runtime and the demuxer get and for the same reason.
 */
const FORMATS = {
  png: { extension: 'png', open: () => Promise.resolve(stillSink('image/png')) },
  jpeg: { extension: 'jpg', open: () => Promise.resolve(stillSink('image/jpeg')) },
  mp4: {
    extension: 'mp4',
    open: async (): Promise<FrameSink> => (await import('./clip-sink.ts')).clipSink(),
  },
} as const;

export type ExportFormat = keyof typeof FORMATS;

export function openSink(format: ExportFormat): Promise<FrameSink> {
  return FORMATS[format].open();
}

/**
 * Filename for an export, derived from the original.
 *
 * A frame number when one frame of a clip is being written, because exporting
 * three frames of the same clip would otherwise write the same name three
 * times. A whole clip is the document and takes the document's name.
 */
export function exportFilename(originalName: string, format: ExportFormat, frame?: number): string {
  const stem = originalName.replace(/\.[^.]+$/, '') || 'image';
  const at = frame === undefined ? '' : `-f${String(frame + 1).padStart(5, '0')}`;
  return `${stem}-rotyl${at}.${FORMATS[format].extension}`;
}
