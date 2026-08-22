/**
 * Measure the Dawn exit the CI gate has to distinguish from a failed test.
 *
 * Each run asks Vitest for its machine-readable assertion report and records
 * the process exit separately. A native teardown abort after the report says
 * every assertion passed is therefore a different row from a failed or
 * incomplete suite, rather than a retry that happens to go green later.
 *
 *   node tools/ci-bench/run.mjs --runs 32
 */

import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const requested = process.argv.indexOf('--runs');
const runs = requested >= 0 ? Number(process.argv[requested + 1]) : 32;
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs needs a positive integer');

const dawnFiles = readdirSync('test').filter((name) => {
  if (!name.endsWith('.test.ts')) return false;
  return /['"]\.\/gpu-harness\.ts['"]/.test(readFileSync(path.join('test', name), 'utf8'));
}).length;
if (dawnFiles === 0) throw new Error('No Dawn test files found');

const scratch = path.resolve('.scratch', `ci-bench-${String(Date.now())}`);
mkdirSync(scratch, { recursive: true });
const observations = [];

for (let run = 1; run <= runs; run++) {
  const reportPath = path.join(scratch, `${String(run)}.json`);
  const started = performance.now();
  const process = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${reportPath}`],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  const seconds = (performance.now() - started) / 1000;

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    report = undefined;
  }

  const exit = process.status ?? (process.signal ? 128 : 1);
  const assertionProof = Boolean(
    report?.success &&
    report.numTotalTests > 0 &&
    report.numPassedTests === report.numTotalTests &&
    report.numFailedTests === 0 &&
    report.numPendingTests === 0,
  );
  const observation = {
    run,
    exit,
    signal: process.signal,
    seconds,
    report: report
      ? {
          total: report.numTotalTests,
          passed: report.numPassedTests,
          failed: report.numFailedTests,
          pending: report.numPendingTests,
          success: report.success,
        }
      : null,
    assertion_proof: assertionProof,
    stderr_tail: process.stderr.trim().split('\n').slice(-6).join('\n'),
  };
  observations.push(observation);
  console.log(
    `run ${String(run)}/${String(runs)}: exit ${String(exit)}, ` +
      `${assertionProof ? `${String(report.numPassedTests)}/${String(report.numTotalTests)} assertions passed` : 'no complete passing report'}, ` +
      `${seconds.toFixed(1)} s`,
  );
}

const result = {
  command: 'pnpm exec vitest run --reporter=json',
  environment: {
    platform: process.platform,
    architecture: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    node: process.version,
  },
  summary: {
    runs,
    clean_exits: observations.filter((run) => run.exit === 0).length,
    post_assertion_aborts: observations.filter((run) => run.exit !== 0 && run.assertion_proof).length,
    assertion_failures: observations.filter((run) => (run.report?.failed ?? 0) > 0).length,
    incomplete_runs: observations.filter((run) => !run.assertion_proof).length,
    dawn_files_per_suite: dawnFiles,
    dawn_processes: runs * dawnFiles,
    observed_process_abort_rate: observations.filter((run) => run.exit !== 0).length / (runs * dawnFiles),
    estimated_incomplete_suites_after_three_attempts:
      dawnFiles * (observations.filter((run) => run.exit !== 0).length / (runs * dawnFiles)) ** 3,
  },
  runs: observations,
};

writeFileSync('tools/ci-bench/results.json', `${JSON.stringify(result, undefined, 2)}\n`);
console.log(JSON.stringify(result.summary));
