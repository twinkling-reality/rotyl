import { illustratedStatus, readField, readIllustratedJob } from '../src/core/illustrated/request.ts';
import { ILLUSTRATED_TERMS } from '../src/core/illustrated/terms.ts';
import {
  ILLUSTRATED_GUIDANCE,
  ILLUSTRATED_NEGATIVE_PROMPT,
  ILLUSTRATED_PIPELINE,
  ILLUSTRATED_PROMPT,
  ILLUSTRATED_STEPS,
  ILLUSTRATED_STRENGTH,
  ILLUSTRATED_STYLE_STRENGTH,
} from '../src/core/illustrated/prompt.ts';
import { zipStore } from '../src/core/illustrated/zip.ts';

export interface IllustratedHost {
  readonly FAL_KEY?: string;
  readonly fetch?: typeof fetch;
}

export interface PhotomakerJob {
  readonly still: Uint8Array;
  readonly mime: string;
  readonly host: IllustratedHost;
  readonly numImages?: number;
  readonly strength?: number;
  readonly steps?: number;
  readonly styleStrength?: number;
  readonly seed?: number;
  readonly giveUpMs?: number;
}

export interface PhotomakerImage {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

const FAL_MODEL = 'fal-ai/photomaker';
const FAL_QUEUE = `https://queue.fal.run/${FAL_MODEL}`;
const POLL_MS = 2_000;
const GIVE_UP_MS = 180_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function imageResponse(bytes: Uint8Array, mime: string): Response {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Same-origin illustrated stills job.
 *
 * GET says whether the host has a key and reprints the terms. POST refuses
 * without a current consent, then calls PhotoMaker. The browser never sees
 * Fal or the key.
 */
export async function handleIllustrated(request: Request, host: IllustratedHost): Promise<Response> {
  const configured = typeof host.FAL_KEY === 'string' && host.FAL_KEY.length > 0;
  if (request.method === 'GET') return jsonResponse(illustratedStatus(configured));
  if (request.method !== 'POST') return jsonResponse({ error: 'Use GET or POST.' }, 405);
  if (!configured) return jsonResponse(illustratedStatus(false), 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'That was not a stills job.' }, 400);
  }
  const parsed = readIllustratedJob(body);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);

  try {
    const still = base64ToBytes(parsed.value.image.data);
    const result = await runPhotomaker({ still, mime: parsed.value.image.mime, host });
    const image = result[0];
    if (!image) throw new Error('Fal finished without a still.');
    return imageResponse(image.bytes, image.mime);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'The illustrated job failed.';
    return jsonResponse({ error: message }, 502);
  }
}

export async function runPhotomaker(job: PhotomakerJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const stillUri = `data:${job.mime};base64,${bytesToBase64(job.still)}`;
  const archive = zipStore('id.jpg', job.still);
  const archiveUri = `data:application/zip;base64,${bytesToBase64(archive)}`;
  const numImages = job.numImages ?? 1;
  const giveUpMs = job.giveUpMs ?? GIVE_UP_MS;

  const submitted = await runtimeFetch(FAL_QUEUE, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
      'X-Fal-Store-IO': '0',
    },
    body: JSON.stringify({
      prompt: ILLUSTRATED_PROMPT,
      negative_prompt: ILLUSTRATED_NEGATIVE_PROMPT,
      base_pipeline: ILLUSTRATED_PIPELINE,
      style: '(No style)',
      image_archive_url: archiveUri,
      initial_image_url: stillUri,
      initial_image_strength: job.strength ?? ILLUSTRATED_STRENGTH,
      style_strength: job.styleStrength ?? ILLUSTRATED_STYLE_STRENGTH,
      num_images: numImages,
      num_inference_steps: job.steps ?? ILLUSTRATED_STEPS,
      guidance_scale: ILLUSTRATED_GUIDANCE,
      ...(job.seed === undefined ? {} : { seed: job.seed }),
    }),
  });
  if (!submitted.ok) {
    const detail = await submitted.text();
    throw new Error(`Fal refused the job (${String(submitted.status)}). ${detail}`.trim());
  }
  const requestId = readField(await submitted.json(), 'request_id');
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('Fal did not name the job.');
  }

  const started = Date.now();
  while (Date.now() - started < giveUpMs) {
    const statusResponse = await runtimeFetch(`${FAL_QUEUE}/requests/${requestId}/status`, {
      headers: { Authorization: `Key ${key}`, 'X-Fal-Store-IO': '0' },
    });
    if (!statusResponse.ok) throw new Error('Fal would not say how the job was doing.');
    const status = readField(await statusResponse.json(), 'status');
    if (status === 'COMPLETED') {
      const resultResponse = await runtimeFetch(`${FAL_QUEUE}/requests/${requestId}`, {
        headers: { Authorization: `Key ${key}`, 'X-Fal-Store-IO': '0' },
      });
      if (!resultResponse.ok) throw new Error('Fal finished and then would not hand the still back.');
      const images = readField(await resultResponse.json(), 'images');
      if (!Array.isArray(images) || images.length === 0) throw new Error('Fal finished without a still.');
      const collected: PhotomakerImage[] = [];
      for (const image of images) {
        const url = readField(image, 'url');
        if (typeof url !== 'string' || url.length === 0) throw new Error('Fal finished without a still.');
        const download = await runtimeFetch(url);
        if (!download.ok) throw new Error('The generated still could not be fetched.');
        const contentType = readField(image, 'content_type');
        collected.push({
          bytes: new Uint8Array(await download.arrayBuffer()),
          mime:
            typeof contentType === 'string'
              ? contentType
              : (download.headers.get('content-type') ?? 'image/jpeg'),
        });
      }
      return collected;
    }
    if (status === 'FAILED') throw new Error('Fal could not finish the illustrated still.');
    await wait(POLL_MS);
  }
  throw new Error(`The illustrated job took longer than ${String(giveUpMs / 1000)} seconds.`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export { ILLUSTRATED_TERMS, FAL_MODEL };
