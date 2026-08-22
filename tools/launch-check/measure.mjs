import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'dist');
const publicRoot = path.join(output, 'client', '__rotyl');
const canonical = new URL(process.env.ROTYL_LAUNCH_URL?.trim() || 'https://rotyl.glendonchin.com/');

if (canonical.protocol !== 'https:') throw new Error('The canonical launch URL must use HTTPS.');

async function filesBelow(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory()
        ? filesBelow(absolute, relative)
        : [{ path: relative, bytes: (await stat(absolute)).size }];
    }),
  );
  return nested.flat();
}

function requiredHeader(headers, name) {
  const value = headers.get(name);
  if (!value) throw new Error(`The production response is missing ${name}.`);
  return value;
}

async function request(relative, expectedStatus = 200) {
  const url = new URL(relative, canonical);
  const response = await fetch(url, { redirect: 'manual' });
  if (response.status !== expectedStatus) {
    throw new Error(`${url.href} returned ${String(response.status)}, expected ${String(expectedStatus)}.`);
  }
  if (response.headers.has('location'))
    throw new Error(`${url.href} redirected instead of serving the canonical origin.`);
  return response;
}

function responsePolicy(response) {
  return {
    status: response.status,
    cache_control: requiredHeader(response.headers, 'cache-control'),
    content_type: requiredHeader(response.headers, 'content-type'),
    referrer_policy: requiredHeader(response.headers, 'referrer-policy'),
    content_type_options: requiredHeader(response.headers, 'x-content-type-options'),
    frame_options: requiredHeader(response.headers, 'x-frame-options'),
  };
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'models', 'edgetam', 'manifest.json'), 'utf8'));
const deploymentFiles = await filesBelow(output);
const publicFiles = await filesBelow(publicRoot);
const javascript = publicFiles.find((entry) => /^assets\/.*\.js$/.test(entry.path));
if (!javascript) throw new Error('The production output has no hashed JavaScript asset.');

const modelPrefix = path.posix.join('models', 'edgetam', manifest.version);
const modelFiles = publicFiles.filter((entry) => entry.path.startsWith(`${modelPrefix}/`));
const modelProbe = path.posix.join(modelPrefix, 'parameters.json.gz');
const modelExpected = manifest.files['parameters.json'];
if (!modelExpected) throw new Error('The model manifest has no parameters.json entry.');

const rootResponse = await request('/');
const researchResponse = await request('/research.html');
const codeResponse = await request(`/${javascript.path}`);
const modelResponse = await request(`/${modelProbe}`);

const rootPolicy = responsePolicy(rootResponse);
const researchPolicy = responsePolicy(researchResponse);
const codePolicy = responsePolicy(codeResponse);
const modelPolicy = responsePolicy(modelResponse);

if (rootPolicy.cache_control !== 'public, max-age=0, must-revalidate') {
  throw new Error(`Root HTML has the wrong cache policy: ${rootPolicy.cache_control}`);
}
if (researchPolicy.cache_control !== 'public, max-age=0, must-revalidate') {
  throw new Error(`Research HTML has the wrong cache policy: ${researchPolicy.cache_control}`);
}
if (codePolicy.cache_control !== 'public, max-age=31536000, immutable') {
  throw new Error(`Hashed code has the wrong cache policy: ${codePolicy.cache_control}`);
}
if (modelPolicy.cache_control !== 'public, max-age=31536000, immutable') {
  throw new Error(`Versioned model has the wrong cache policy: ${modelPolicy.cache_control}`);
}

const modelServed = new Uint8Array(await modelResponse.arrayBuffer());
const modelBytes = modelPolicy.content_type.includes('application/gzip')
  ? gunzipSync(modelServed)
  : modelServed;
const modelDigest = createHash('sha256').update(modelBytes).digest('hex');
if (modelBytes.byteLength !== modelExpected.bytes || modelDigest !== modelExpected.sha256) {
  throw new Error('The production model probe does not match the build manifest.');
}

const exposureProbes = [
  ['/.openai/hosting.json', 'project_id'],
  ['/package.json', '"name"'],
  ['/worker/index.ts', 'AssetFetcher'],
  ['/.git/config', '[core]'],
  ['/site.tar', 'ustar'],
];
const exposures = await Promise.all(
  exposureProbes.map(async ([relative, marker]) => {
    const response = await fetch(new URL(relative, canonical), { redirect: 'manual' });
    const body = await response.text();
    return { path: relative, status: response.status, exposed: body.includes(marker) };
  }),
);
if (exposures.some((entry) => entry.exposed))
  throw new Error('A private source or deployment file is publicly exposed.');

const sourceMaps = publicFiles.filter((entry) => entry.path.endsWith('.map'));
const archives = publicFiles.filter((entry) => /\.(?:tar|tgz|zip)$/i.test(entry.path));
if (sourceMaps.length > 0) throw new Error('The public build contains source maps.');
if (archives.length > 0) throw new Error('The public build contains a temporary archive.');

const result = {
  schema: 1,
  application_release: `v${packageJson.version}`,
  model_release: manifest.version,
  canonical_origin: canonical.origin,
  environment: { node: process.version },
  build: {
    deployment_files: deploymentFiles.length,
    deployment_bytes: deploymentFiles.reduce((sum, entry) => sum + entry.bytes, 0),
    public_files: publicFiles.length,
    public_bytes: publicFiles.reduce((sum, entry) => sum + entry.bytes, 0),
    largest_public_file: publicFiles.reduce((largest, entry) =>
      entry.bytes > largest.bytes ? entry : largest,
    ),
    source_maps: sourceMaps.length,
    temporary_archives: archives.length,
  },
  models: {
    emitted_files: modelFiles.length,
    served_bytes: modelFiles.reduce((sum, entry) => sum + entry.bytes, 0),
    probe: {
      path: `/${modelProbe}`,
      decompressed_bytes: modelBytes.byteLength,
      sha256: modelDigest,
      matches_manifest: true,
    },
  },
  production: {
    anonymous_https: true,
    redirected: false,
    root: rootPolicy,
    research: researchPolicy,
    code: { path: `/${javascript.path}`, ...codePolicy },
    model: { path: `/${modelProbe}`, ...modelPolicy },
    exposure_probes: exposures,
  },
};

await writeFile(
  path.join(root, 'tools', 'launch-check', 'results.json'),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(
  `Public launch measured at ${canonical.origin}; ${String(publicFiles.length)} files, no exposed source or archive.`,
);
