import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, readManifest, sha256 } from './lib.mjs';

const directory = process.argv.find((argument, index) => index > 1 && argument !== '--');
if (!directory) throw new Error('usage: pnpm models:manifest -- /directory/holding/the/release');

const manifest = await readManifest();
const resolved = path.resolve(PROJECT_ROOT, directory);
const files = {};
for (const [name, expected] of Object.entries(manifest.files)) {
  const bytes = await readFile(path.join(resolved, name));
  files[name] = { bytes: bytes.byteLength, sha256: sha256(bytes), feature: expected.feature };
}
console.log(JSON.stringify(files, undefined, 2));
