import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST_PATH = path.join(PROJECT_ROOT, 'models/edgetam/manifest.json');

export async function readManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  if (
    manifest?.schema !== 1 ||
    typeof manifest.version !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.version) ||
    typeof manifest.release !== 'string' ||
    !manifest.release.startsWith('https://') ||
    typeof manifest.files !== 'object' ||
    manifest.files === null
  ) {
    throw new Error('The EdgeTAM manifest has an unsupported shape.');
  }
  const features = new Set(['selection-half', 'selection-full', 'tracking', 'legal']);
  const entries = Object.entries(manifest.files);
  if (
    entries.length === 0 ||
    entries.some(
      ([name, file]) =>
        path.basename(name) !== name ||
        !Number.isSafeInteger(file?.bytes) ||
        file.bytes <= 0 ||
        typeof file.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(file.sha256) ||
        !features.has(file.feature),
    )
  ) {
    throw new Error('The EdgeTAM manifest has an invalid file entry.');
  }
  return manifest;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function mismatch(name, expected, bytes) {
  if (bytes.byteLength !== expected.bytes) {
    return `${name} is ${bytes.byteLength.toLocaleString('en-US')} bytes; the manifest requires ${expected.bytes.toLocaleString('en-US')}`;
  }
  const digest = sha256(bytes);
  return digest === expected.sha256
    ? undefined
    : `${name} has SHA-256 ${digest}; the manifest requires ${expected.sha256}`;
}

export function cacheDirectory(manifest) {
  return path.join(PROJECT_ROOT, '.model-assets', manifest.version);
}
