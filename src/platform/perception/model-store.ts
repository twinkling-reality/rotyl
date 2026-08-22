/**
 * Where the EdgeTAM weights come from, and where they stay.
 *
 * Rotyl's promise is that the image never leaves the machine, and it does not:
 * this fetches a model *to* the machine, once, and everything after that is
 * local. The distinction is worth being precise about rather than glossing.
 * "runs locally" and "needs no network ever" are different claims, and only the
 * first is true.
 *
 * Every graph is served by the deployment that served the application. The
 * build obtained it from Rotyl's immutable release and checked it against the
 * committed manifest before it emitted a byte. This file checks it again after
 * fetch and after a cache read, before ONNX Runtime can see it.
 *
 * Cached in the Cache Storage API rather than in memory or IndexedDB: it is the
 * one browser store designed for exactly this. Immutable, addressable by URL,
 * evictable under pressure, and shared across tabs, so a second window pays
 * nothing.
 */

import { MODEL_RELEASE, modelAsset, modelAssetUrl, type ModelAssetName } from './model-assets.ts';

const CACHE_PREFIX = 'rotyl-models-';
const CACHE_NAME = `${CACHE_PREFIX}${MODEL_RELEASE}`;

export interface ModelFile {
  /** The graph. Small: the weights live beside it. */
  readonly graph: ModelAssetName;
  /**
   * The weights, as an ONNX external-data sidecar.
   *
   * ONNX Runtime Web will not fetch these itself, it has no idea where the
   * model came from, so they are fetched here and handed over as bytes under
   * the exact filename the graph records.
   */
  readonly weights: ModelAssetName;
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
    },
    decoder: {
      graph: 'prompt_encoder_mask_decoder_fp16.onnx',
      weights: 'prompt_encoder_mask_decoder_fp16.onnx_data',
    },
  },
  full: {
    encoder: {
      graph: 'vision_encoder.onnx',
      weights: 'vision_encoder.onnx_data',
    },
    decoder: {
      graph: 'prompt_encoder_mask_decoder.onnx',
      weights: 'prompt_encoder_mask_decoder.onnx_data',
    },
  },
} as const satisfies Record<string, ModelVariant>;

export function edgetamVariant(supportsF16: boolean): ModelVariant {
  return supportsF16 ? EDGETAM_VARIANTS.half : EDGETAM_VARIANTS.full;
}

/** Total download for a cold start, for the message shown while it happens. */
export function variantBytes(variant: ModelVariant): number {
  return [variant.encoder, variant.decoder].reduce(
    (total, file) => total + modelAsset(file.graph).bytes + modelAsset(file.weights).bytes,
    0,
  );
}

export interface ModelBytes {
  readonly graph: Uint8Array<ArrayBuffer>;
  readonly weights: Uint8Array<ArrayBuffer>;
}

let cachePromise: Promise<Cache | undefined> | undefined;

async function openCache(): Promise<Cache | undefined> {
  // Absent in insecure contexts and in some private modes. Not having it costs
  // a re-download, which is worth continuing for rather than failing over.
  if (!('caches' in globalThis)) return undefined;
  cachePromise ??= (async () => {
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      return await caches.open(CACHE_NAME);
    } catch {
      return undefined;
    }
  })();
  return cachePromise;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Refuse bytes that are not the exact release this build names. */
export async function verifyModelAsset(name: ModelAssetName, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const expected = modelAsset(name);
  const detail =
    bytes.byteLength !== expected.bytes
      ? `${String(bytes.byteLength)} bytes arrived; ${String(expected.bytes)} were required`
      : hex(await crypto.subtle.digest('SHA-256', bytes)) !== expected.sha256
        ? 'its SHA-256 digest was different'
        : undefined;
  if (detail) {
    throw new Error(
      `Rotyl refused ${name} because it did not match model release ${MODEL_RELEASE}: ${detail}. ` +
        'The deployment or browser cache is incomplete. Reload; if this continues, tell whoever deployed Rotyl.',
    );
  }
}

async function readWithProgress(
  response: Response,
  onBytes: (delta: number) => void,
  compressed = false,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = compressed ? response.body?.pipeThrough(new DecompressionStream('gzip')) : response.body;
  if (!body) {
    const received = new Uint8Array(await response.arrayBuffer());
    const buffer = compressed
      ? new Uint8Array(
          await new Response(
            new Blob([received]).stream().pipeThrough(new DecompressionStream('gzip')),
          ).arrayBuffer(),
        )
      : received;
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
  name: ModelAssetName,
  onBytes: (delta: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const url = modelAssetUrl(name);
  const cache = await openCache();

  const cached = await cache?.match(url);
  if (cached) {
    const bytes = await readWithProgress(cached, onBytes);
    try {
      await verifyModelAsset(name, bytes);
    } catch (cause) {
      // The message asks for a reload, so make that reload meaningful. This
      // attempt still refuses the file loudly; the next one has to go back to
      // the deployment rather than reading the same corrupt cache entry again.
      await cache?.delete(url).catch(() => undefined);
      throw cause;
    }
    return bytes;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download ${name} (${String(response.status)}).`);
  }
  // A plain static host serves the explicit .gz file as bytes and this stream
  // inflates it. A host configured for precompressed assets may set
  // Content-Encoding instead, in which case fetch has already done that work.
  const alreadyDecoded = response.headers.get('Content-Encoding')?.includes('gzip') ?? false;
  const bytes = await readWithProgress(response, onBytes, !alreadyDecoded);
  await verifyModelAsset(name, bytes);
  // Stored after the fact rather than by cloning the response: a clone has to
  // buffer the whole body anyway, and this way a failed download never leaves a
  // truncated entry behind.
  await cache?.put(url, new Response(bytes)).catch(() => undefined);
  return bytes;
}

/**
 * Fetch one whole graph, weights and all.
 *
 * The tracking graphs are exported with their weights inside them rather than
 * beside them, so there is no sidecar to ask for and no second request to make.
 * Asking for one through `fetchModel` and naming the graph as its own weights
 * fetched it twice, which the cache made cheap and the progress bar made
 * confusing.
 *
 * The name is constrained by the manifest, so a caller cannot ask this fetch
 * path for bytes the build did not verify and ship.
 */
export async function fetchGraph(
  name: ModelAssetName,
  onProgress: (received: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  let received = 0;
  return fetchFile(name, (delta) => {
    received += delta;
    onProgress(received);
  });
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
): Promise<ModelBytes> {
  let received = 0;
  const count = (delta: number): void => {
    received += delta;
    onProgress(received);
  };

  // Sequential, not parallel: two large streams over one connection interleave
  // into a progress bar that stalls near the end while both finish at once.
  const graph = await fetchFile(file.graph, count);
  const weights = await fetchFile(file.weights, count);
  return { graph, weights };
}
