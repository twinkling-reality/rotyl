/**
 * Measure what owning the model release costs to load, ship, cache and check.
 *
 * This is separate from every video benchmark on purpose. It builds the last
 * committed application in a temporary archive for the initial-load control,
 * builds the working tree for the owned release, and reads only the model
 * manifest and the files that build emitted.
 *
 *   node tools/model-assets/measure.mjs
 */

import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { cpus, tmpdir } from 'node:os';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { cacheDirectory, readManifest } from './lib.mjs';

const manifest = await readManifest();
const cache = cacheDirectory(manifest);

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    input: options.input,
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function mainBundle(directory) {
  const html = readFileSync(path.join(directory, 'index.html'), 'utf8');
  const source = /<script[^>]+src="\.?(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
  if (!source) throw new Error(`No application script in ${directory}/index.html`);
  const bytes = readFileSync(path.join(directory, source.replace(/^\//, '')));
  return { raw: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength };
}

const temporary = mkdtempSync(path.join(tmpdir(), 'rotyl-model-measure-'));
try {
  const baseline = path.join(temporary, 'baseline');
  mkdirSync(baseline);
  const archive = run('git', ['archive', 'HEAD'], { encoding: null });
  run('tar', ['-x', '-C', baseline], { input: archive, encoding: null });
  symlinkSync(path.resolve('node_modules'), path.join(baseline, 'node_modules'), 'dir');
  run(path.resolve('node_modules/.bin/vite'), ['build'], { cwd: baseline });

  run('pnpm', ['build']);

  const entries = Object.entries(manifest.files).map(([name, expected]) => {
    const raw = readFileSync(path.join(cache, name));
    const served =
      expected.feature === 'legal'
        ? readFileSync(path.join('dist/models/edgetam', manifest.version, name))
        : readFileSync(path.join('dist/models/edgetam', manifest.version, `${name}.gz`));
    return {
      name,
      feature: expected.feature,
      raw: raw.byteLength,
      served: served.byteLength,
    };
  });

  const group = (features) => {
    const chosen = entries.filter((entry) => features.includes(entry.feature));
    return {
      files: chosen.length,
      raw: chosen.reduce((total, entry) => total + entry.raw, 0),
      served: chosen.reduce((total, entry) => total + entry.served, 0),
    };
  };

  const selectionHalf = group(['selection-half']);
  const selectionFull = group(['selection-full']);
  const tracking = group(['tracking']);
  const legal = group(['legal']);
  const deployment = group(['selection-half', 'selection-full', 'tracking', 'legal']);

  async function digestTime(features, rounds = 5) {
    const chosen = entries.filter((entry) => features.includes(entry.feature));
    const samples = [];
    for (let round = 0; round < rounds; round++) {
      const started = performance.now();
      for (const entry of chosen) {
        const bytes = Uint8Array.from(readFileSync(path.join(cache, entry.name)));
        await webcrypto.subtle.digest('SHA-256', bytes);
      }
      samples.push(performance.now() - started);
    }
    return samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)];
  }

  async function inflateTime(features, rounds = 5) {
    const chosen = entries.filter((entry) => features.includes(entry.feature) && entry.feature !== 'legal');
    const samples = [];
    for (let round = 0; round < rounds; round++) {
      const started = performance.now();
      for (const entry of chosen) {
        const bytes = readFileSync(path.join('dist/models/edgetam', manifest.version, `${entry.name}.gz`));
        await new Response(
          new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
        ).arrayBuffer();
      }
      samples.push(performance.now() - started);
    }
    return samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)];
  }

  const result = {
    release: manifest.version,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      node: process.version,
    },
    initial_application: {
      before: mainBundle(path.join(baseline, 'dist')),
      owned_release: mainBundle('dist'),
      model_requests: 0,
    },
    groups: {
      selection_half: selectionHalf,
      selection_full: selectionFull,
      tracking,
      legal,
      deployment,
    },
    cache: {
      after_selection_half: selectionHalf.raw,
      after_selection_full: selectionFull.raw,
      after_tracking_half: selectionHalf.raw + tracking.raw,
      after_tracking_full: selectionFull.raw + tracking.raw,
      invalidated_on_next_model_use_half: selectionHalf.raw + tracking.raw,
      invalidated_on_next_model_use_full: selectionFull.raw + tracking.raw,
    },
    serving: {
      cold_selection_half: selectionHalf.served,
      cold_selection_full: selectionFull.served,
      cold_tracking_after_selection: tracking.served,
      cold_full_feature_session_half: selectionHalf.served + tracking.served,
      cold_full_feature_session_full: selectionFull.served + tracking.served,
      thousand_full_feature_sessions_half: (selectionHalf.served + tracking.served) * 1000,
    },
    verification_ms: {
      build_all: await digestTime(['selection-half', 'selection-full', 'tracking', 'legal']),
      fetch_selection_half: await digestTime(['selection-half']),
      fetch_selection_full: await digestTime(['selection-full']),
      fetch_tracking: await digestTime(['tracking']),
    },
    inflate_ms: {
      selection_half: await inflateTime(['selection-half']),
      selection_full: await inflateTime(['selection-full']),
      tracking: await inflateTime(['tracking']),
    },
    files: entries,
    emitted_files: readdirSync(path.join('dist/models/edgetam', manifest.version)).length,
  };

  writeFileSync('tools/model-assets/results.json', `${JSON.stringify(result, undefined, 2)}\n`);
  console.log(JSON.stringify(result, undefined, 2));
} finally {
  rmSync(temporary, { recursive: true });
}
