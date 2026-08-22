import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'dist');

await rm(output, { recursive: true, force: true });
const result = spawnSync('pnpm', ['exec', 'vite', 'build', '--mode', 'sites'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  const client = path.join(output, 'client');
  const workerAssets = path.join(client, '__rotyl');
  await mkdir(workerAssets);
  const entries = (await readdir(client)).filter((entry) => entry !== '.assetsignore' && entry !== '__rotyl');
  await Promise.all(entries.map((entry) => rename(path.join(client, entry), path.join(workerAssets, entry))));
}
