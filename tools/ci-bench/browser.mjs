/** Measure the complete shader suite in installed Chrome on a hosted Mac. */

import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const at = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const cycles = Number(at('--cycles', '16'));
const output = path.resolve(at('--output', 'tools/ci-bench/browser-results.json'));
if (!Number.isInteger(cycles) || cycles < 1) throw new Error('--cycles needs a positive integer');

const scratch = path.resolve('.scratch', `hosted-browser-bench-${String(Date.now())}`);
mkdirSync(scratch, { recursive: true });

const observations = [];
for (let cycle = 1; cycle <= cycles; cycle++) {
  const reportPath = path.join(scratch, `browser-${String(cycle)}.json`);
  const started = performance.now();
  const processResult = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.browser.config.ts',
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  const seconds = (performance.now() - started) / 1000;

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    report = undefined;
  }
  const complete = Boolean(
    processResult.status === 0 &&
    report?.success &&
    report.numTotalTests > 0 &&
    report.numPassedTests === report.numTotalTests &&
    report.numFailedTests === 0 &&
    report.numPendingTests === 0,
  );
  const observation = {
    cycle,
    exit: processResult.status ?? (processResult.signal ? 128 : 1),
    signal: processResult.signal,
    seconds,
    complete,
    report: report
      ? {
          total: report.numTotalTests,
          passed: report.numPassedTests,
          failed: report.numFailedTests,
          pending: report.numPendingTests,
          success: report.success,
        }
      : null,
    stderr_tail: processResult.stderr.trim().split('\n').slice(-6).join('\n'),
  };
  observations.push(observation);
  console.log(
    `browser-${String(cycle)}: exit ${String(observation.exit)}, ` +
      `${complete ? `${String(report.numPassedTests)} assertions` : 'incomplete'}, ${seconds.toFixed(1)} s`,
  );
}

const result = {
  command: `node tools/ci-bench/browser.mjs --cycles ${String(cycles)}`,
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
  summary: {
    processes: observations.length,
    complete_processes: observations.filter((entry) => entry.complete).length,
    failed_assertion_processes: observations.filter((entry) => (entry.report?.failed ?? 0) > 0).length,
    incomplete_processes: observations.filter((entry) => !entry.complete).length,
  },
  observations,
};

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, undefined, 2)}\n`);
console.log(JSON.stringify(result.summary));

if (result.summary.incomplete_processes > 0) process.exitCode = 1;
