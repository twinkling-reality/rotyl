import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const TEST_ROOT = path.resolve('test');

function localImports(file) {
  const source = readFileSync(file, 'utf8');
  const imports = [];
  const pattern = /(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (!specifier) continue;
    const unresolved = path.resolve(path.dirname(file), specifier);
    const candidates = [
      unresolved,
      `${unresolved}.ts`,
      `${unresolved}.tsx`,
      `${unresolved}.mjs`,
      `${unresolved}.js`,
      path.join(unresolved, 'index.ts'),
    ];
    const resolved = candidates.find((candidate) => existsSync(candidate));
    if (resolved?.startsWith(`${TEST_ROOT}${path.sep}`)) imports.push(resolved);
  }
  return imports;
}

function reachesHarness(file, visiting = new Set()) {
  if (path.basename(file) === 'gpu-harness.ts') return true;
  if (visiting.has(file)) return false;
  visiting.add(file);
  return localImports(file).some((dependency) => reachesHarness(dependency, visiting));
}

/** Test files that reach Dawn, including through a shared test harness. */
export function dawnTestFiles() {
  return readdirSync(TEST_ROOT)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => path.join(TEST_ROOT, name))
    .filter((file) => reachesHarness(file))
    .sort();
}
