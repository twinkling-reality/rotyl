import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { mismatch, PROJECT_ROOT, readManifest } from '../model-assets/lib.mjs';

const output = path.join(PROJECT_ROOT, 'dist');
const client = path.join(output, 'client');

await Promise.all(['index.html', '_headers'].map((name) => access(path.join(client, name))));
await Promise.all(['index.js', 'wrangler.json'].map((name) => access(path.join(output, 'server', name))));
await access(path.join(output, '.openai', 'hosting.json'));

const headers = await readFile(path.join(client, '_headers'), 'utf8');
const immutable = 'Cache-Control: public, max-age=31536000, immutable';
if (
  !headers.includes('/models/edgetam/edgetam-v1/*') ||
  !headers.includes('/assets/*') ||
  headers.split(immutable).length !== 3 ||
  /models[\s\S]*Cache-Control: no-cache/.test(headers)
) {
  throw new Error('The production cache policy does not keep versioned model and code assets immutable.');
}

const manifest = await readManifest();
for (const [name, expected] of Object.entries(manifest.files)) {
  const servedName = expected.feature === 'legal' ? name : `${name}.gz`;
  const served = await readFile(path.join(client, 'models', 'edgetam', manifest.version, servedName));
  const bytes = expected.feature === 'legal' ? served : gunzipSync(served);
  const problem = mismatch(name, expected, bytes);
  if (problem) throw new Error(`${problem}. Refusing the production site output.`);
}

for (const duplicate of [path.join(output, 'models'), path.join(output, 'server', 'models')]) {
  try {
    await access(duplicate);
    throw new Error(`The production output duplicated model assets at ${duplicate}.`);
  } catch (cause) {
    if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) {
      throw cause;
    }
  }
}

console.log(
  `Production site ${manifest.version} verified: ${String(Object.keys(manifest.files).length)} model assets, one client copy and immutable versioned paths.`,
);
