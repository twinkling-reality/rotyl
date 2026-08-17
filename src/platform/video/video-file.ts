/**
 * Reading a video file the browser will actually decode.
 *
 * The same rule as `image-file.ts`: the format is decided from the bytes, not
 * from the extension or the `type` a File carries, both of which are supplied
 * by whatever produced the file and are routinely wrong.
 *
 * MP4 and QuickTime only, and that is a measured decision rather than a
 * shortcut. They share one demuxer, so accepting `.mov` alongside `.mp4` costs
 * 64 bytes gzipped; Matroska is a second demuxer and costs 15.4 KB. It also
 * mostly carries VP9 or AV1, whose decode has not been measured here at all,
 * where H.264 in MP4 is hardware-decoded at seventy times real time. Shipping a
 * format on an unmeasured path is how a feature becomes slow in a way nobody
 * can explain. See tools/video-bench.
 */

export type VideoFormat = 'mp4' | 'quicktime' | 'matroska' | 'unknown';

export type VideoLoadError =
  | { readonly kind: 'unsupported-format'; readonly format: VideoFormat }
  | { readonly kind: 'no-video-track' }
  | { readonly kind: 'unsupported-codec'; readonly codec: string }
  | { readonly kind: 'too-large'; readonly width: number; readonly height: number; readonly limit: number }
  | { readonly kind: 'unreadable' };

function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * ISO base media brands that mean "a movie".
 *
 * Deliberately not exhaustive and deliberately not a prefix match: `ftyp` also
 * introduces AVIF and HEIC, which are images and belong to the other loader.
 * An unknown brand falls through to `unknown` and the caller tries the image
 * path, which is where a mis-sniff should land.
 */
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'iso8',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'cmfc',
  'M4V ',
  'M4VH',
  'M4VP',
]);

export function sniffVideoFormat(header: Uint8Array): VideoFormat {
  // EBML, which is Matroska and WebM alike.
  if (matches(header, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'matroska';

  if (matches(header, 4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = String.fromCharCode(...header.subarray(8, 12));
    // QuickTime's brand is 'qt  ', trailing spaces included.
    if (brand === 'qt  ') return 'quicktime';
    if (MP4_BRANDS.has(brand)) return 'mp4';
  }
  return 'unknown';
}

export function describeVideoLoadError(error: VideoLoadError): string {
  switch (error.kind) {
    case 'unsupported-format':
      // Worth its own sentence, because the browser plays it: someone dropping
      // a WebM is not dropping something broken, and saying "not a video" would
      // read as a bug rather than as a limit.
      return error.format === 'matroska'
        ? 'WebM and Matroska are not supported yet. MP4 and MOV work.'
        : 'That file is not a video Rotyl can read.';
    case 'no-video-track':
      return 'That file has no video in it.';
    case 'unsupported-codec':
      return `This browser cannot decode ${error.codec}.`;
    case 'too-large':
      return `That video is ${String(error.width)} × ${String(error.height)}. This device can hold up to ${String(error.limit)} pixels on a side.`;
    default:
      return 'That file could not be read. It may have been moved or renamed since you chose it.';
  }
}

/** Whether the bytes look like a video at all, before any of it is parsed. */
export async function looksLikeVideo(file: Blob): Promise<VideoFormat> {
  try {
    const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    return sniffVideoFormat(header);
  } catch {
    return 'unknown';
  }
}
