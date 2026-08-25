import {
  ILLUSTRATED_MAX_BYTES,
  ILLUSTRATED_TERMS,
  consentMatches,
  type IllustratedConsent,
} from './terms.ts';

export function readField(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

export type IllustratedImageMime = 'image/jpeg' | 'image/png';

export interface IllustratedJobRequest {
  readonly consent: IllustratedConsent;
  readonly image: {
    readonly mime: IllustratedImageMime;
    readonly data: string;
  };
}

export type IllustratedJobRead =
  | { readonly ok: true; readonly value: IllustratedJobRequest }
  | { readonly ok: false; readonly error: string };

/**
 * Read a job body. Refuse anything that is not an accepted, current consent
 * plus a still under the size cap.
 *
 * The worker is the only caller that then sends bytes off the machine. This
 * function is the last gate that can run without a network.
 */
export function readIllustratedJob(body: unknown): IllustratedJobRead {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'That was not a stills job.' };
  }
  if (!consentMatches(readField(body, 'consent'), ILLUSTRATED_TERMS)) {
    return {
      ok: false,
      error: 'Accept the current hosted terms before a still can leave this machine.',
    };
  }
  const image = readField(body, 'image');
  if (image === null || typeof image !== 'object') {
    return { ok: false, error: 'The still is missing.' };
  }
  const mime = readField(image, 'mime');
  const data = readField(image, 'data');
  if (mime !== 'image/jpeg' && mime !== 'image/png') {
    return { ok: false, error: 'Send a JPEG or PNG still.' };
  }
  if (typeof data !== 'string' || data.length === 0) {
    return { ok: false, error: 'The still is empty.' };
  }
  // Four base64 characters are three bytes. The exact decode happens on the
  // host; this is the cap that keeps a 48 megapixel dump from leaving.
  const estimated = Math.ceil((data.length * 3) / 4);
  if (estimated > ILLUSTRATED_MAX_BYTES) {
    return { ok: false, error: 'That still is larger than the hosted job will take.' };
  }
  return {
    ok: true,
    value: {
      consent: { version: ILLUSTRATED_TERMS.version, accepted: true },
      image: { mime, data },
    },
  };
}

export interface IllustratedStatus {
  readonly available: boolean;
  readonly configured: boolean;
  readonly terms: typeof ILLUSTRATED_TERMS;
  readonly reason?: string;
}

export function illustratedStatus(configured: boolean): IllustratedStatus {
  return configured
    ? { available: true, configured: true, terms: ILLUSTRATED_TERMS }
    : {
        available: false,
        configured: false,
        terms: ILLUSTRATED_TERMS,
        reason: 'The host has not configured the illustrated stills job.',
      };
}
