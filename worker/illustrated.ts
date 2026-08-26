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
  KEEP_INSTRUCTION,
  buildIllustratedPrompt,
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
const FAL_UPLOAD = 'https://rest.fal.ai/storage/upload/initiate';
const POLL_MS = 2_000;
const GIVE_UP_MS = 180_000;

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
    const result = await runIllustrated({ still, mime: parsed.value.image.mime, host });
    const image = result[0];
    if (!image) throw new Error('Fal finished without a still.');
    return imageResponse(image.bytes, image.mime);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'The illustrated job failed.';
    return jsonResponse({ error: message }, 502);
  }
}

async function uploadFalAsset(
  bytes: Uint8Array,
  mime: string,
  fileName: string,
  runtimeFetch: typeof fetch,
  key: string,
): Promise<string> {
  const initiated = await runtimeFetch(FAL_UPLOAD, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content_type: mime, file_name: fileName }),
  });
  if (!initiated.ok) {
    throw new Error(`Fal would not take the still (${String(initiated.status)}).`);
  }
  const body: unknown = await initiated.json();
  const uploadUrl = readField(body, 'upload_url');
  const fileUrl = readField(body, 'file_url');
  if (typeof uploadUrl !== 'string' || typeof fileUrl !== 'string') {
    throw new Error('Fal did not name an upload.');
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const uploaded = await runtimeFetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mime },
    body: copy,
  });
  if (!uploaded.ok) throw new Error(`Fal would not store the still (${String(uploaded.status)}).`);
  return fileUrl;
}

export async function runPhotomaker(job: PhotomakerJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const archive = zipStore('id.jpg', job.still);
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  const archiveUrl = await uploadFalAsset(archive, 'application/zip', 'id.zip', runtimeFetch, key);
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
      image_archive_url: archiveUrl,
      initial_image_url: stillUrl,
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
      headers: { Authorization: `Key ${key}` },
    });
    if (!statusResponse.ok) throw new Error('Fal would not say how the job was doing.');
    const status = readField(await statusResponse.json(), 'status');
    if (status === 'COMPLETED') {
      const resultResponse = await runtimeFetch(`${FAL_QUEUE}/requests/${requestId}`, {
        headers: { Authorization: `Key ${key}` },
      });
      if (!resultResponse.ok) {
        const detail = await resultResponse.text();
        throw new Error(
          `Fal finished and then would not hand the still back (${String(resultResponse.status)}). ${detail}`.trim(),
        );
      }
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

export const FAL_KONTEXT_PRO = 'fal-ai/flux-pro/kontext';
export const FAL_KONTEXT_MAX = 'fal-ai/flux-pro/kontext/max';
export const FAL_FLUX2_EDIT = 'fal-ai/flux-2-pro/edit';
export const FAL_NANO_EDIT = 'fal-ai/nano-banana-2/edit';
export const FAL_SEEDREAM_EDIT = 'fal-ai/bytedance/seedream/v4.5/edit';
export const FAL_GPT_EDIT = 'fal-ai/gpt-image-1.5/edit';
export const FAL_SEEDREAM5_PRO_EDIT = 'bytedance/seedream/v5/pro/edit';
export const FAL_SEEDREAM5_LITE_EDIT = 'bytedance/seedream/v5/lite/edit';
export const FAL_NANO_PRO_EDIT = 'fal-ai/nano-banana-pro/edit';
export const FAL_QWEN_EDIT = 'fal-ai/qwen-image-edit-2511';
export const FAL_GROK_EDIT = 'xai/grok-imagine-image/edit';
export const FAL_FLUX2_FLEX_EDIT = 'fal-ai/flux-2-flex/edit';
export const FAL_VISION = 'fal-ai/any-llm/vision';

export interface FalKontextJob {
  readonly still: Uint8Array;
  readonly mime: string;
  readonly host: IllustratedHost;
  readonly prompt: string;
  readonly model?: string;
  readonly aspectRatio?: string;
  /** Nano Banana Pro output size. The product stays at 1K; the bench asks for more. */
  readonly resolution?: string;
  readonly numImages?: number;
  readonly guidance?: number;
  readonly seed?: number;
  readonly giveUpMs?: number;
}

/**
 * Fal edit of this still. Eval-only until a licensed set clears the bar.
 * Product POST still goes through PhotoMaker.
 */
export async function runFalKontext(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const model = job.model ?? FAL_KONTEXT_PRO;
  const queue = `https://queue.fal.run/${model}`;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  const numImages = job.numImages ?? 1;
  const giveUpMs = job.giveUpMs ?? GIVE_UP_MS;

  const submitted = await runtimeFetch(queue, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
      'X-Fal-Store-IO': '0',
    },
    body: JSON.stringify({
      prompt: job.prompt,
      image_url: stillUrl,
      num_images: numImages,
      output_format: 'jpeg',
      guidance_scale: job.guidance ?? 3.5,
      ...(job.aspectRatio === undefined ? {} : { aspect_ratio: job.aspectRatio }),
      ...(job.seed === undefined ? {} : { seed: job.seed }),
    }),
  });
  if (!submitted.ok) {
    const detail = await submitted.text();
    throw new Error(`Fal refused the job (${String(submitted.status)}). ${detail}`.trim());
  }
  const submittedBody: unknown = await submitted.json();
  const requestId = readField(submittedBody, 'request_id');
  const statusUrl = readField(submittedBody, 'status_url');
  const responseUrl = readField(submittedBody, 'response_url');
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('Fal did not name the job.');
  }
  if (typeof statusUrl !== 'string' || typeof responseUrl !== 'string') {
    throw new Error('Fal did not name the job status.');
  }

  const started = Date.now();
  while (Date.now() - started < giveUpMs) {
    const statusResponse = await runtimeFetch(statusUrl, {
      headers: { Authorization: `Key ${key}` },
    });
    if (!statusResponse.ok) {
      const detail = await statusResponse.text();
      throw new Error(
        `Fal would not say how the job was doing (${String(statusResponse.status)}). ${detail}`.trim(),
      );
    }
    const status = readField(await statusResponse.json(), 'status');
    if (status === 'COMPLETED') {
      const resultResponse = await runtimeFetch(responseUrl, {
        headers: { Authorization: `Key ${key}` },
      });
      if (!resultResponse.ok) {
        const detail = await resultResponse.text();
        throw new Error(
          `Fal finished and then would not hand the still back (${String(resultResponse.status)}). ${detail}`.trim(),
        );
      }
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

/**
 * FLUX.2 Pro edit of this still. Eval-only. Product POST is still PhotoMaker.
 */
export async function runFalFlux2Edit(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const queue = `https://queue.fal.run/${FAL_FLUX2_EDIT}`;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  const giveUpMs = job.giveUpMs ?? GIVE_UP_MS;

  const submitted = await runtimeFetch(queue, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
      'X-Fal-Store-IO': '0',
    },
    body: JSON.stringify({
      prompt: job.prompt,
      image_urls: [stillUrl],
      image_size: 'auto',
      output_format: 'jpeg',
      ...(job.seed === undefined ? {} : { seed: job.seed }),
    }),
  });
  if (!submitted.ok) {
    const detail = await submitted.text();
    throw new Error(`Fal refused the job (${String(submitted.status)}). ${detail}`.trim());
  }
  const submittedBody: unknown = await submitted.json();
  const requestId = readField(submittedBody, 'request_id');
  const statusUrl = readField(submittedBody, 'status_url');
  const responseUrl = readField(submittedBody, 'response_url');
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('Fal did not name the job.');
  }
  if (typeof statusUrl !== 'string' || typeof responseUrl !== 'string') {
    throw new Error('Fal did not name the job status.');
  }

  const started = Date.now();
  while (Date.now() - started < giveUpMs) {
    const statusResponse = await runtimeFetch(statusUrl, {
      headers: { Authorization: `Key ${key}` },
    });
    if (!statusResponse.ok) {
      const detail = await statusResponse.text();
      throw new Error(
        `Fal would not say how the job was doing (${String(statusResponse.status)}). ${detail}`.trim(),
      );
    }
    const status = readField(await statusResponse.json(), 'status');
    if (status === 'COMPLETED') {
      const resultResponse = await runtimeFetch(responseUrl, {
        headers: { Authorization: `Key ${key}` },
      });
      if (!resultResponse.ok) {
        const detail = await resultResponse.text();
        throw new Error(
          `Fal finished and then would not hand the still back (${String(resultResponse.status)}). ${detail}`.trim(),
        );
      }
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

/**
 * Nano Banana 2 edit of this still. Eval-only. Product POST is still PhotoMaker.
 */
export async function runFalNanoEdit(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const queue = `https://queue.fal.run/${FAL_NANO_EDIT}`;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  const giveUpMs = job.giveUpMs ?? GIVE_UP_MS;

  const submitted = await runtimeFetch(queue, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
      'X-Fal-Store-IO': '0',
    },
    body: JSON.stringify({
      prompt: job.prompt,
      image_urls: [stillUrl],
      aspect_ratio: 'auto',
      output_format: 'jpeg',
      resolution: '1K',
      num_images: 1,
      limit_generations: true,
      ...(job.seed === undefined ? {} : { seed: job.seed }),
    }),
  });
  if (!submitted.ok) {
    const detail = await submitted.text();
    throw new Error(`Fal refused the job (${String(submitted.status)}). ${detail}`.trim());
  }
  const submittedBody: unknown = await submitted.json();
  const requestId = readField(submittedBody, 'request_id');
  const statusUrl = readField(submittedBody, 'status_url');
  const responseUrl = readField(submittedBody, 'response_url');
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('Fal did not name the job.');
  }
  if (typeof statusUrl !== 'string' || typeof responseUrl !== 'string') {
    throw new Error('Fal did not name the job status.');
  }

  const started = Date.now();
  while (Date.now() - started < giveUpMs) {
    const statusResponse = await runtimeFetch(statusUrl, {
      headers: { Authorization: `Key ${key}` },
    });
    if (!statusResponse.ok) {
      const detail = await statusResponse.text();
      throw new Error(
        `Fal would not say how the job was doing (${String(statusResponse.status)}). ${detail}`.trim(),
      );
    }
    const status = readField(await statusResponse.json(), 'status');
    if (status === 'COMPLETED') {
      const resultResponse = await runtimeFetch(responseUrl, {
        headers: { Authorization: `Key ${key}` },
      });
      if (!resultResponse.ok) {
        const detail = await resultResponse.text();
        throw new Error(
          `Fal finished and then would not hand the still back (${String(resultResponse.status)}). ${detail}`.trim(),
        );
      }
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

async function pollFalImages(
  key: string,
  runtimeFetch: typeof fetch,
  statusUrl: string,
  responseUrl: string,
  giveUpMs: number,
): Promise<PhotomakerImage[]> {
  const started = Date.now();
  while (Date.now() - started < giveUpMs) {
    const statusResponse = await runtimeFetch(statusUrl, {
      headers: { Authorization: `Key ${key}` },
    });
    if (!statusResponse.ok) {
      const detail = await statusResponse.text();
      throw new Error(
        `Fal would not say how the job was doing (${String(statusResponse.status)}). ${detail}`.trim(),
      );
    }
    const status = readField(await statusResponse.json(), 'status');
    if (status === 'COMPLETED') {
      const resultResponse = await runtimeFetch(responseUrl, {
        headers: { Authorization: `Key ${key}` },
      });
      if (!resultResponse.ok) {
        const detail = await resultResponse.text();
        throw new Error(
          `Fal finished and then would not hand the still back (${String(resultResponse.status)}). ${detail}`.trim(),
        );
      }
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

async function runFalQueuedEdit(
  job: FalKontextJob,
  model: string,
  payload: Record<string, unknown>,
): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const giveUpMs = job.giveUpMs ?? GIVE_UP_MS;
  const submitted = await runtimeFetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
      'X-Fal-Store-IO': '0',
    },
    body: JSON.stringify(payload),
  });
  if (!submitted.ok) {
    const detail = await submitted.text();
    throw new Error(`Fal refused the job (${String(submitted.status)}). ${detail}`.trim());
  }
  const submittedBody: unknown = await submitted.json();
  const requestId = readField(submittedBody, 'request_id');
  const statusUrl = readField(submittedBody, 'status_url');
  const responseUrl = readField(submittedBody, 'response_url');
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('Fal did not name the job.');
  }
  if (typeof statusUrl !== 'string' || typeof responseUrl !== 'string') {
    throw new Error('Fal did not name the job status.');
  }
  return pollFalImages(key, runtimeFetch, statusUrl, responseUrl, giveUpMs);
}

/**
 * Seedream 4.5 edit of this still. Eval-only. Product POST is still PhotoMaker.
 */
export async function runFalSeedreamEdit(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  return runFalQueuedEdit(job, FAL_SEEDREAM_EDIT, {
    prompt: job.prompt,
    image_urls: [stillUrl],
    image_size: 'auto_2K',
    num_images: 1,
    max_images: 1,
    ...(job.seed === undefined ? {} : { seed: job.seed }),
  });
}

/**
 * GPT Image 1.5 edit of this still. Eval-only. Product POST is still PhotoMaker.
 */
export async function runFalGptEdit(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  return runFalQueuedEdit(job, FAL_GPT_EDIT, {
    prompt: job.prompt,
    image_urls: [stillUrl],
    image_size: 'auto',
    quality: 'high',
    input_fidelity: 'high',
    num_images: 1,
    output_format: 'jpeg',
  });
}

/**
 * Seedream 5 Pro edit of this still. Eval-only. Product POST is still PhotoMaker.
 */
export async function runFalSeedream5ProEdit(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  return runFalQueuedEdit(job, FAL_SEEDREAM5_PRO_EDIT, {
    prompt: job.prompt,
    image_urls: [stillUrl],
    image_size: 'auto_2K',
    num_images: 1,
    output_format: 'jpeg',
  });
}

/**
 * Seedream 5 Lite edit of this still. Eval-only. Product POST is still PhotoMaker.
 */
export async function runFalSeedream5LiteEdit(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  return runFalQueuedEdit(job, FAL_SEEDREAM5_LITE_EDIT, {
    prompt: job.prompt,
    image_urls: [stillUrl],
    image_size: 'auto_2K',
    num_images: 1,
    max_images: 1,
  });
}

/**
 * Nano Banana Pro edit of this still. Eval-only. Product POST is still PhotoMaker.
 */
export async function runFalNanoProEdit(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  return runFalQueuedEdit(job, FAL_NANO_PRO_EDIT, {
    prompt: job.prompt,
    image_urls: [stillUrl],
    aspect_ratio: 'auto',
    resolution: job.resolution ?? '1K',
    output_format: 'jpeg',
    num_images: 1,
    limit_generations: true,
    ...(job.seed === undefined ? {} : { seed: job.seed }),
  });
}

/**
 * Qwen image edit of this still. Eval-only. Product POST is still PhotoMaker.
 * image_size is left off so Qwen keeps the framing of the still it was given.
 */
export async function runFalQwenEdit(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  return runFalQueuedEdit(job, FAL_QWEN_EDIT, {
    prompt: job.prompt,
    image_urls: [stillUrl],
    num_images: 1,
    output_format: 'jpeg',
    guidance_scale: job.guidance ?? 4.5,
    ...(job.seed === undefined ? {} : { seed: job.seed }),
  });
}

/**
 * Grok Imagine edit of this still. Eval-only. Product POST is still PhotoMaker.
 */
export async function runFalGrokEdit(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  return runFalQueuedEdit(job, FAL_GROK_EDIT, {
    prompt: job.prompt,
    image_urls: [stillUrl],
    resolution: '2k',
    aspect_ratio: 'auto',
    num_images: 1,
    output_format: 'jpeg',
  });
}

/**
 * FLUX.2 Flex edit of this still. Eval-only. Product POST is still PhotoMaker.
 */
export async function runFalFlux2FlexEdit(job: FalKontextJob): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  return runFalQueuedEdit(job, FAL_FLUX2_FLEX_EDIT, {
    prompt: job.prompt,
    image_urls: [stillUrl],
    image_size: 'auto',
    num_inference_steps: 28,
    guidance_scale: job.guidance ?? 3.5,
    output_format: 'jpeg',
    ...(job.seed === undefined ? {} : { seed: job.seed }),
  });
}

/** Polls a queued Fal job that answers with text rather than images. */
async function runFalQueuedText(
  job: FalKontextJob,
  model: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const giveUpMs = job.giveUpMs ?? GIVE_UP_MS;
  const submitted = await runtimeFetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
      'X-Fal-Store-IO': '0',
    },
    body: JSON.stringify(payload),
  });
  if (!submitted.ok) {
    const detail = await submitted.text();
    throw new Error(`Fal refused the job (${String(submitted.status)}). ${detail}`.trim());
  }
  const submittedBody: unknown = await submitted.json();
  const statusUrl = readField(submittedBody, 'status_url');
  const responseUrl = readField(submittedBody, 'response_url');
  if (typeof statusUrl !== 'string' || typeof responseUrl !== 'string') {
    throw new Error('Fal did not name the job status.');
  }
  const started = Date.now();
  while (Date.now() - started < giveUpMs) {
    const statusResponse = await runtimeFetch(statusUrl, { headers: { Authorization: `Key ${key}` } });
    if (!statusResponse.ok) {
      const detail = await statusResponse.text();
      throw new Error(
        `Fal would not say how the job was doing (${String(statusResponse.status)}). ${detail}`.trim(),
      );
    }
    const status = readField(await statusResponse.json(), 'status');
    if (status === 'COMPLETED') {
      const resultResponse = await runtimeFetch(responseUrl, {
        headers: { Authorization: `Key ${key}` },
      });
      if (!resultResponse.ok) throw new Error('Fal finished and then would not hand the answer back.');
      const output = readField(await resultResponse.json(), 'output');
      if (typeof output !== 'string' || output.trim().length === 0) {
        throw new Error('Fal finished without a description.');
      }
      return output.trim();
    }
    if (status === 'FAILED') throw new Error('Fal could not read the still.');
    await wait(POLL_MS);
  }
  throw new Error(`The illustrated job took longer than ${String(giveUpMs / 1000)} seconds.`);
}

/**
 * Looks at this still and writes the keep list for it.
 *
 * The eval keep lists were written by hand against six known photographs, which
 * a real upload never gets. This derives the same thing from whatever the user
 * actually sent, so nothing about the request is hardcoded to one picture.
 */
export async function describeIllustratedKeep(job: FalKontextJob): Promise<string> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  const runtimeFetch = job.host.fetch ?? fetch;
  const stillUrl = await uploadFalAsset(job.still, job.mime, 'still.jpg', runtimeFetch, key);
  return runFalQueuedText(job, FAL_VISION, {
    prompt: KEEP_INSTRUCTION,
    image_urls: [stillUrl],
    model: job.model ?? 'google/gemini-2.5-flash',
    temperature: 0,
  });
}

/**
 * The adopted illustrated path.
 *
 * Reads the still, writes a keep list from what is actually in it, then draws
 * with that list. PhotoMaker invented a new face and the hand-written bench
 * keep lists could never reach a real upload, so neither is what ships.
 *
 * Nano Banana Pro is the family: it draws rather than traces, and unlike
 * Seedream 5 Pro its complexion follows the keep list instead of the weights.
 * If the still yields no description the draw request still goes out, because a
 * plain drawing beats refusing the job.
 */
export async function runIllustrated(job: {
  readonly still: Uint8Array;
  readonly mime: string;
  readonly host: IllustratedHost;
  readonly giveUpMs?: number;
}): Promise<PhotomakerImage[]> {
  const key = job.host.FAL_KEY;
  if (!key) throw new Error('The host has not configured the illustrated stills job.');
  let keep = '';
  try {
    keep = await describeIllustratedKeep({
      still: job.still,
      mime: job.mime,
      host: job.host,
      prompt: '',
      ...(job.giveUpMs === undefined ? {} : { giveUpMs: job.giveUpMs }),
    });
  } catch {
    keep = '';
  }
  return runFalNanoProEdit({
    still: job.still,
    mime: job.mime,
    host: job.host,
    prompt: buildIllustratedPrompt(keep),
    // Full size, because the layer this becomes is judged at the size it is
    // looked at rather than at the size it is convenient to send.
    resolution: '4K',
    ...(job.giveUpMs === undefined ? {} : { giveUpMs: job.giveUpMs }),
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export { ILLUSTRATED_TERMS, FAL_MODEL };
