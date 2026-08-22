import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cacheDirectory, mismatch, PROJECT_ROOT, readManifest } from './lib.mjs';

const checkOnly = process.argv.includes('--check');
const manifest = await readManifest();
const target = cacheDirectory(manifest);
const configured = process.env.ROTYL_MODEL_SOURCE?.trim();
const source = configured && configured.length > 0 ? configured.replace(/\/+$/, '') : manifest.release;

function githubToken() {
  if (source !== manifest.release || !source.startsWith('https://github.com/twinkling-reality/rotyl/')) {
    return undefined;
  }
  const fromEnvironment = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

const token = githubToken();
const githubRelease = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)$/.exec(
  manifest.release,
);
let releaseAssets;

function property(value, name) {
  if (value === null || typeof value !== 'object') return undefined;
  return Object.getOwnPropertyDescriptor(value, name)?.value;
}

async function authenticatedAsset(name) {
  if (!token || !githubRelease) return undefined;
  releaseAssets ??= (async () => {
    const [, owner, repository, tag] = githubRelease;
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Could not read Rotyl's private model release (${String(response.status)}).`);
    }
    const assets = property(await response.json(), 'assets');
    if (!Array.isArray(assets)) throw new Error("Rotyl's model release returned no asset list.");
    return assets;
  })();

  const asset = (await releaseAssets).find((candidate) => property(candidate, 'name') === `${name}.gz`);
  const url = property(asset, 'url');
  if (typeof url !== 'string') throw new Error(`Rotyl's model release has no ${name}.gz asset.`);
  return url;
}

async function existing(name, expected) {
  try {
    const bytes = await readFile(path.join(target, name));
    const problem = mismatch(name, expected, bytes);
    if (problem) throw new Error(`${problem}. Refusing the cached model release.`);
    return true;
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') return false;
    throw cause;
  }
}

async function fromDirectory(name) {
  const resolved = path.resolve(PROJECT_ROOT, source, name);
  try {
    return await readFile(resolved);
  } catch (cause) {
    if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) throw cause;
  }
  try {
    return gunzipSync(await readFile(`${resolved}.gz`));
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      throw new Error(`The model source has no ${name} or ${name}.gz: ${path.dirname(resolved)}`, {
        cause,
      });
    }
    throw cause;
  }
}

async function fromRelease(name) {
  const authenticated = source === manifest.release ? await authenticatedAsset(name) : undefined;
  const response = await fetch(authenticated ?? `${source}/${encodeURIComponent(name)}.gz`, {
    redirect: 'follow',
    headers: token
      ? {
          Accept: authenticated ? 'application/octet-stream' : '*/*',
          Authorization: `Bearer ${token}`,
          ...(authenticated ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
        }
      : undefined,
  });
  if (!response.ok) {
    throw new Error(
      `Could not obtain ${name} from Rotyl's model release (${String(response.status)}). ` +
        'No deployment was produced. If the repository is private, authenticate with gh or set GH_TOKEN. ' +
        'A release maintainer may instead set ROTYL_MODEL_SOURCE to a verified local directory.',
    );
  }
  return gunzipSync(await response.arrayBuffer());
}

async function obtain(name) {
  return /^https?:\/\//.test(source) ? fromRelease(name) : fromDirectory(name);
}

await mkdir(target, { recursive: true });
let fetched = 0;
for (const [name, expected] of Object.entries(manifest.files)) {
  if (await existing(name, expected)) continue;
  if (checkOnly) {
    throw new Error(
      `${name} is absent from ${target}. No deployment was produced. Run pnpm models while online, ` +
        'or set ROTYL_MODEL_SOURCE to the complete release directory.',
    );
  }

  const bytes =
    expected.feature === 'legal'
      ? await readFile(path.join(PROJECT_ROOT, 'models/edgetam', name))
      : await obtain(name);
  const problem = mismatch(name, expected, bytes);
  if (problem) throw new Error(`${problem}. Refusing the model release; no deployment was produced.`);

  const partial = path.join(target, `${name}.part`);
  await writeFile(partial, bytes);
  try {
    await rename(partial, path.join(target, name));
  } catch (cause) {
    await unlink(partial).catch(() => undefined);
    throw cause;
  }
  fetched += bytes.byteLength;
}

console.log(
  fetched > 0
    ? `Model release ${manifest.version} verified; obtained ${fetched.toLocaleString('en-US')} bytes.`
    : `Model release ${manifest.version} verified in the local cache.`,
);
