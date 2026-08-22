import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { mismatch, PROJECT_ROOT, readManifest } from '../model-assets/lib.mjs';

const output = path.join(PROJECT_ROOT, 'dist');
const client = path.join(output, 'client');
const workerAssets = path.join(client, '__rotyl');

await access(path.join(workerAssets, 'index.html'));
await Promise.all(['index.js', 'wrangler.json'].map((name) => access(path.join(output, 'server', name))));
await access(path.join(output, '.openai', 'hosting.json'));

await Promise.all(
  ['index.html', 'assets', 'models', 'research'].map(async (publicEntry) => {
    try {
      await access(path.join(client, publicEntry));
      throw new Error(`The production asset ${publicEntry} can bypass the worker response policy.`);
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) {
        throw cause;
      }
    }
  }),
);

const worker = await readFile(path.join(output, 'server', 'index.js'), 'utf8');
const workerPolicy = [
  '/__rotyl',
  '/models/edgetam/edgetam-v1/',
  '/assets/',
  'public, max-age=31536000, immutable',
  'public, max-age=0, must-revalidate',
  'application/gzip',
  'Referrer-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
];
if (workerPolicy.some((value) => !worker.includes(value))) {
  throw new Error('The production worker is missing a cache, content type or security policy.');
}

const wrangler = JSON.parse(await readFile(path.join(output, 'server', 'wrangler.json'), 'utf8'));
if (wrangler.assets?.binding !== 'ASSETS') {
  throw new Error('The production worker has no static asset binding.');
}
if (wrangler.assets?.html_handling !== 'none') {
  throw new Error('The production asset binding can redirect internal HTML paths.');
}

const manifest = await readManifest();
for (const [name, expected] of Object.entries(manifest.files)) {
  const servedName = expected.feature === 'legal' ? name : `${name}.gz`;
  const served = await readFile(path.join(workerAssets, 'models', 'edgetam', manifest.version, servedName));
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
