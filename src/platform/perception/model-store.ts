/**
 * Where the segmentation weights come from, and where they stay.
 *
 * Rotyl's promise is that the image never leaves the machine, and it does not:
 * this fetches a model *to* the machine, once, and everything after that is
 * local. The distinction is worth being precise about rather than glossing.
 * "runs locally" and "needs no network ever" are different claims, and only the
 * first is true.
 *
 * The revision is pinned to a commit rather than to `main`. A moving reference
 * would mean the weights could change under a cached session, and a mask is not
 * the kind of output where a silent model swap is acceptable.
 *
 * Cached in the Cache Storage API rather than in memory or IndexedDB: it is the
 * one browser store designed for exactly this. Immutable, addressable by URL,
 * evictable under pressure, and shared across tabs, so a second window pays
 * nothing.
 */

const REVISION = '9c77c7bff7fd0f3079585fa17af7f730ddc531ed';
const BASE = `https://huggingface.co/onnx-community/EdgeTAM-ONNX/resolve/${REVISION}/onnx`;

const CACHE_NAME = 'rotyl-models-v1';

export interface ModelFile {
  /** The graph. Small: the weights live beside it. */
  readonly graph: string;
  /**
   * The weights, as an ONNX external-data sidecar.
   *
   * ONNX Runtime Web will not fetch these itself, it has no idea where the
   * model came from, so they are fetched here and handed over as bytes under
   * the exact filename the graph records.
   */
  readonly weights: string;
  /** Declared size in bytes, used only to show progress before the first byte. */
  readonly bytes: number;
}

export interface ModelVariant {
  readonly encoder: ModelFile;
  readonly decoder: ModelFile;
}

/**
 * Two builds of the same weights, chosen by what the device can compile.
 *
 * Half precision is half the download and the one to prefer, but its kernels
 * need the `shader-f16` feature and refuse to build without it. A failure that
 * arrives as a session-creation error deep inside the runtime, long after the
 * twenty megabytes have been fetched. Picking the variant from the device's
 * feature set turns that into a decision made before anything is downloaded.
 */
export const EDGETAM_VARIANTS = {
  half: {
    encoder: {
      graph: 'vision_encoder_fp16.onnx',
      weights: 'vision_encoder_fp16.onnx_data',
      bytes: 167_617 + 9_739_536,
    },
    decoder: {
      graph: 'prompt_encoder_mask_decoder_fp16.onnx',
      weights: 'prompt_encoder_mask_decoder_fp16.onnx_data',
      bytes: 229_799 + 10_454_016,
    },
  },
  full: {
    encoder: {
      graph: 'vision_encoder.onnx',
      weights: 'vision_encoder.onnx_data',
      bytes: 192_225 + 19_532_576,
    },
    decoder: {
      graph: 'prompt_encoder_mask_decoder.onnx',
      weights: 'prompt_encoder_mask_decoder.onnx_data',
      bytes: 213_114 + 20_958_208,
    },
  },
} as const satisfies Record<string, ModelVariant>;

export function edgetamVariant(supportsF16: boolean): ModelVariant {
  return supportsF16 ? EDGETAM_VARIANTS.half : EDGETAM_VARIANTS.full;
}

/** Total download for a cold start, for the message shown while it happens. */
export function variantBytes(variant: ModelVariant): number {
  return variant.encoder.bytes + variant.decoder.bytes;
}

export interface ModelBytes {
  readonly graph: Uint8Array<ArrayBuffer>;
  readonly weights: Uint8Array<ArrayBuffer>;
}

async function openCache(): Promise<Cache | undefined> {
  // Absent in insecure contexts and in some private modes. Not having it costs
  // a re-download, which is worth continuing for rather than failing over.
  if (!('caches' in globalThis)) return undefined;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return undefined;
  }
}

async function readWithProgress(
  response: Response,
  onBytes: (delta: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    onBytes(buffer.byteLength);
    return buffer;
  }

  // Streamed rather than awaited whole, which is the entire point: a
  // twenty-megabyte download with no progress is indistinguishable from a hang.
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.byteLength;
    onBytes(chunk.byteLength);
  }

  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchFile(
  name: string,
  onBytes: (delta: number) => void,
  base = BASE,
): Promise<Uint8Array<ArrayBuffer>> {
  const url = `${base}/${name}`;
  const cache = await openCache();

  const cached = await cache?.match(url);
  if (cached) return readWithProgress(cached, onBytes);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the object-selection model (${String(response.status)}).`);
  }
  const bytes = await readWithProgress(response, onBytes);
  // Stored after the fact rather than by cloning the response: a clone has to
  // buffer the whole body anyway, and this way a failed download never leaves a
  // truncated entry behind.
  await cache?.put(url, new Response(bytes)).catch(() => undefined);
  return bytes;
}

/**
 * Fetch a model's graph and weights, reporting progress across both.
 *
 * Progress is measured in bytes actually received rather than in files
 * completed, because a two-file download that jumps from 0% to 50% to 100% is
 * indistinguishable from a stalled one.
 */
export async function fetchModel(
  file: ModelFile,
  onProgress: (received: number) => void,
  /**
   * Where to fetch from, for the one caller that is not the published release.
   * The tracking graphs are produced by `tools/edgetam-export` and hosted by
   * whoever is running this, so they cannot be a constant here.
   */
  base?: string,
): Promise<ModelBytes> {
  let received = 0;
  const count = (delta: number): void => {
    received += delta;
    onProgress(received);
  };

  // Sequential, not parallel: two large streams over one connection interleave
  // into a progress bar that stalls near the end while both finish at once.
  const graph = await fetchFile(file.graph, count, base);
  const weights = await fetchFile(file.weights, count, base);
  return { graph, weights };
}
