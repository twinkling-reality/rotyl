/**
 * Reading an image file the browser will actually accept.
 *
 * File extensions and the `type` a File carries are both supplied by whatever
 * produced the file and are routinely wrong, so the format is determined from
 * the bytes. Twenty lines of magic-number matching replaces a dependency here,
 * and it is also the only way to give a useful message for the one format that
 * matters most in practice and works least: HEIC, which is what an iPhone
 * produces by default and which no browser except Safari can decode.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'bmp' | 'heic' | 'unknown';

export interface DecodedImage {
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
}

export type ImageLoadError =
  | { readonly kind: 'unsupported-format'; readonly format: ImageFormat }
  | { readonly kind: 'too-large'; readonly width: number; readonly height: number; readonly limit: number }
  | { readonly kind: 'decode-failed' }
  | { readonly kind: 'unreadable' };

function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

export function sniffImageFormat(header: Uint8Array): ImageFormat {
  if (matches(header, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (matches(header, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (matches(header, 0, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (matches(header, 0, [0x42, 0x4d])) return 'bmp';
  // RIFF....WEBP
  if (matches(header, 0, [0x52, 0x49, 0x46, 0x46]) && matches(header, 8, [0x57, 0x45, 0x42, 0x50]))
    return 'webp';

  // ISO base media: the brand at offset 8 distinguishes AVIF from HEIC, and
  // both look identical until then.
  if (matches(header, 4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = String.fromCharCode(...header.subarray(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return 'unknown';
}

/**
 * Decode a file to an ImageBitmap.
 *
 * Default options throughout, deliberately. `imageOrientation` defaults to
 * `'from-image'`, so EXIF rotation is already applied and any additional
 * rotation would double it; `colorSpaceConversion` defaults to `'default'`,
 * which normalises an embedded ICC profile to sRGB and is what makes the
 * `rgba8unorm-srgb` assumption downstream correct.
 *
 * `maxDimension` comes from the GPU device rather than being a fixed constant:
 * the real limit is what can be held in a texture.
 */
export async function decodeImageFile(
  file: Blob,
  maxDimension: number,
): Promise<{ ok: true; value: DecodedImage } | { ok: false; error: ImageLoadError }> {
  let header: Uint8Array;
  try {
    header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  } catch {
    // A File is a handle to something on disk, not a copy of it. Reading one
    // that has since been moved, renamed or unmounted rejects here, and an
    // uncaught rejection would strand the caller mid-load with no way back.
    return { ok: false, error: { kind: 'unreadable' } };
  }
  const format = sniffImageFormat(header);

  if (format === 'unknown' || format === 'heic') {
    return { ok: false, error: { kind: 'unsupported-format', format } };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, error: { kind: 'decode-failed' } };
  }

  if (bitmap.width > maxDimension || bitmap.height > maxDimension) {
    const { width, height } = bitmap;
    bitmap.close();
    return { ok: false, error: { kind: 'too-large', width, height, limit: maxDimension } };
  }

  return { ok: true, value: { bitmap, width: bitmap.width, height: bitmap.height } };
}

export function describeImageLoadError(error: ImageLoadError): string {
  if (error.kind === 'unsupported-format') {
    // HEIC is worth its own sentence: it is what an iPhone produces by default,
    // so this is the most common rejection there is. The advice deliberately
    // does not name a browser — Safari decodes HEIC and would reach this branch
    // too, since the format is rejected by signature before any decoder is
    // consulted, and telling a Safari user to switch to Safari is nonsense.
    return error.format === 'heic'
      ? 'HEIC images are not supported yet. Convert to JPEG or PNG and try again.'
      : 'That file is not an image Rotyl can read.';
  }
  if (error.kind === 'too-large') {
    return `That image is ${String(error.width)} × ${String(error.height)}. This device can hold up to ${String(error.limit)} pixels on a side.`;
  }
  if (error.kind === 'unreadable') {
    return 'That file could not be read. It may have been moved or renamed since you chose it.';
  }
  return 'That image could not be decoded. It may be incomplete or corrupt.';
}
