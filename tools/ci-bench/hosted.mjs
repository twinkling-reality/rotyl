/**
 * Compare the raw suite with one Dawn test file per process on the hosted Mac.
 *
 * This is a workflow measurement rather than a local benchmark: the question
 * is whether the exact runner enforcing the gate survives each topology.
 */

import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dawnTestFiles } from '../ci/dawn-files.mjs';

const at = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const cycles = Number(at('--cycles', '16'));
const output = path.resolve(at('--output', 'tools/ci-bench/hosted-results.json'));
if (!Number.isInteger(cycles) || cycles < 1) throw new Error('--cycles needs a positive integer');

const dawnFiles = dawnTestFiles();
if (dawnFiles.length === 0) throw new Error('No Dawn test files found');

const scratch = path.resolve('.scratch', `hosted-ci-bench-${String(Date.now())}`);
mkdirSync(scratch, { recursive: true });

function run(files, label, cycle, file) {
  const reportPath = path.join(scratch, `${label}.json`);
  const started = performance.now();
  const processResult = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${reportPath}`],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  const seconds = (performance.now() - started) / 1000;

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    report = undefined;
  }
  const pendingFiles = (report?.testResults ?? [])
    .filter((result) => result.assertionResults.some((test) => test.status === 'pending'))
    .map((result) => path.basename(result.name));
  const assertionProof = Boolean(
    report?.success &&
    report.numTotalTests > 0 &&
    report.numPassedTests === report.numTotalTests &&
    report.numFailedTests === 0 &&
    report.numPendingTests === 0,
  );
  const observation = {
    cycle,
    file,
    exit: processResult.status ?? (processResult.signal ? 128 : 1),
    signal: processResult.signal,
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
    pending_files: pendingFiles,
    assertion_proof: assertionProof,
    stderr_tail: processResult.stderr.trim().split('\n').slice(-6).join('\n'),
  };
  console.log(
    `${label}: exit ${String(observation.exit)}, ` +
      `${assertionProof ? 'assertion complete' : `${String(pendingFiles.length)} incomplete files`}, ` +
      `${seconds.toFixed(1)} s`,
  );
  return observation;
}

const suites = [];
for (let cycle = 1; cycle <= cycles; cycle++) {
  suites.push(run([], `suite-${String(cycle)}`, cycle));
}

const isolated = [];
for (let cycle = 1; cycle <= cycles; cycle++) {
  for (const file of dawnFiles) {
    isolated.push(
      run([file], `isolated-${String(cycle)}-${path.basename(file)}`, cycle, path.basename(file)),
    );
  }
}

function summary(observations) {
  return {
    processes: observations.length,
    clean_exits: observations.filter((entry) => entry.exit === 0).length,
    post_assertion_aborts: observations.filter((entry) => entry.exit !== 0 && entry.assertion_proof).length,
    assertion_failures: observations.filter((entry) => (entry.report?.failed ?? 0) > 0).length,
    incomplete_processes: observations.filter(
      (entry) => !entry.assertion_proof && (entry.report?.failed ?? 0) === 0,
    ).length,
    pending_files: observations.reduce((total, entry) => total + entry.pending_files.length, 0),
  };
}

const result = {
  command: `node tools/ci-bench/hosted.mjs --cycles ${String(cycles)}`,
  environment: {
    platform: process.platform,
    architecture: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    node: process.version,
    image_os: process.env.ImageOS ?? 'unknown',
    image_version: process.env.ImageVersion ?? 'unknown',
    runner_architecture: process.env.RUNNER_ARCH ?? 'unknown',
  },
  cycles,
  dawn_files: dawnFiles.map((file) => path.basename(file)),
  suite: summary(suites),
  isolated: summary(isolated),
  suites,
  isolated_processes: isolated,
};

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, undefined, 2)}\n`);
console.log(JSON.stringify({ suite: result.suite, isolated: result.isolated }));
