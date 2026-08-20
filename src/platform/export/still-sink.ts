import type { Dimensions } from '../../core/render/resolution.ts';
import type { ExportFrame, FrameSink, SinkState, Written } from './export.ts';

const JPEG_QUALITY = 0.92;

/**
 * One frame, as a picture file.
 *
 * `convertToBlob` encodes straight from GPU memory, which is why the render
 * target is a canvas at all. The alternative, copying the texture back into a
 * buffer and encoding by hand, measured an order of magnitude slower and
 * requires de-padding every row to undo the 256-byte alignment WebGPU imposes
 * on texture-to-buffer copies.
 *
 * It takes the LAST frame it is given rather than refusing a second one. A
 * still sink handed a clip is a caller mistake, and the honest place to catch
 * that is where the pairing is chosen, not here in an error message about
 * canvases.
 */
export function stillSink(type: 'image/png' | 'image/jpeg'): FrameSink {
  let picture: Blob | undefined;

  return {
    open(size: Dimensions): Promise<Dimensions> {
      return Promise.resolve(size);
    },

    async accept(canvas: OffscreenCanvas, _frame: ExportFrame): Promise<SinkState> {
      const blob = await canvas.convertToBlob(
        type === 'image/jpeg' ? { type, quality: JPEG_QUALITY } : { type },
      );
      // An unsupported type is not an error: the canvas silently falls back to
      // PNG, which would otherwise ship a .jpg file containing PNG bytes.
      if (blob.type !== type) throw new Error(`This browser cannot encode ${type}.`);
      picture = blob;
      // A picture is never the sink that runs out of room: one frame of it is
      // the whole document, and a photograph that did not fit in memory could
      // not have been opened.
      return 'ready';
    },

    finish(): Promise<Written> {
      if (!picture) throw new Error('Nothing was rendered to export.');
      return Promise.resolve({ to: 'download', blob: picture });
    },

    cancel(): Promise<void> {
      picture = undefined;
      return Promise.resolve();
    },
  };
}
