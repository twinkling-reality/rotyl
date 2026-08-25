import {
  ILLUSTRATED_LONG_EDGE,
  ILLUSTRATED_TERMS,
  type IllustratedConsent,
} from '../../core/illustrated/terms.ts';
import { readField, type IllustratedStatus } from '../../core/illustrated/request.ts';
import { SOURCE_FORMAT, SOURCE_VIEW_FORMAT } from '../../core/gpu/formats.ts';
import { uploadImageToTexture } from '../texture-upload.ts';

const ENDPOINT = '/api/illustrated';

export async function fetchIllustratedStatus(): Promise<IllustratedStatus> {
  try {
    const response = await fetch(ENDPOINT, { method: 'GET', cache: 'no-store' });
    if (!response.ok) {
      return {
        available: false,
        configured: false,
        terms: ILLUSTRATED_TERMS,
        reason: 'The illustrated job could not be reached.',
      };
    }
    return readIllustratedStatus(await response.json());
  } catch {
    return {
      available: false,
      configured: false,
      terms: ILLUSTRATED_TERMS,
      reason: 'The illustrated job could not be reached.',
    };
  }
}

/**
 * Shrink a still to the hosted long edge and encode it as JPEG.
 *
 * The original file stays on the machine. Only this smaller still is offered
 * to the worker, and only after consent.
 */
export async function prepareIllustratedStill(file: Blob, longEdge = ILLUSTRATED_LONG_EDGE): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the still for the hosted job.');
    context.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  } finally {
    bitmap.close();
  }
}

export async function sendIllustratedStill(still: Blob, consent: IllustratedConsent): Promise<Blob> {
  const data = await blobToBase64(still);
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      consent,
      image: { mime: 'image/jpeg', data },
    }),
  });
  if (!response.ok) {
    let message = 'The illustrated job failed.';
    try {
      const error = readField(await response.json(), 'error');
      if (typeof error === 'string' && error.length > 0) message = error;
    } catch {
      /* the body was not JSON; keep the generic sentence */
    }
    throw new Error(message);
  }
  return await response.blob();
}

export function createIllustratedTexture(device: GPUDevice, bitmap: ImageBitmap): GPUTexture {
  const texture = device.createTexture({
    label: 'illustrated-layer',
    size: { width: bitmap.width, height: bitmap.height },
    format: SOURCE_FORMAT,
    viewFormats: [SOURCE_VIEW_FORMAT],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  uploadImageToTexture(device, bitmap, texture);
  return texture;
}

function readIllustratedStatus(body: unknown): IllustratedStatus {
  const reason = readField(body, 'reason');
  return {
    available: readField(body, 'available') === true,
    configured: readField(body, 'configured') === true,
    terms: ILLUSTRATED_TERMS,
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
