/**
 * A Vitest gate that distinguishes a failed assertion from Dawn tearing down.
 *
 * Dawn occasionally exits a worker after reporting no failed assertions. If
 * every assertion completed, that report is proof and the native exit changes
 * nothing. If a file has pending assertions, only that file is run again. A
 * real failure, a missing report, or a file that cannot complete within the
 * measured bound fails immediately or at the bound.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Measurement 19 observed three Dawn exits across the shader processes in
// thirty-two suites. Three attempts puts the measured residual below one in
// seventy-seven thousand suites. This is a measured bound, not a generic retry
// count; tools/ci-bench/results.json carries the arithmetic.
const MAX_ATTEMPTS = 3;
const scratch = path.resolve('.scratch', `test-gate-${String(Date.now())}`);
mkdirSync(scratch, { recursive: true });

function runVitest(files, label) {
  const reportPath = path.join(scratch, `${label}.json`);
  const result = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${reportPath}`],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    report = undefined;
  }
  return { result, report };
}

function failedMessages(report) {
  return (report?.testResults ?? [])
    .flatMap((file) => file.assertionResults)
    .filter((test) => test.status === 'failed')
    .flatMap((test) => [`${test.fullName}:`, ...test.failureMessages]);
}

function pendingFiles(report) {
  return (report?.testResults ?? [])
    .filter((file) => file.assertionResults.some((test) => test.status === 'pending'))
    .map((file) => file.name);
}

function fail(message, run) {
  console.error(message);
  const failures = failedMessages(run.report);
  if (failures.length > 0) console.error(failures.join('\n'));
  if (run.result.stderr.trim()) console.error(run.result.stderr.trim());
  process.exitCode = 1;
}

const initial = runVitest([], 'all');
if (!initial.report) {
  fail('Vitest produced no assertion report.', initial);
} else if (initial.report.numFailedTests > 0) {
  fail(`${String(initial.report.numFailedTests)} unit assertions failed.`, initial);
} else {
  const pending = pendingFiles(initial.report);
  const completed = initial.report.numPassedTests;
  const total = initial.report.numTotalTests;

  if (pending.length === 0 && completed === total) {
    console.log(`${String(completed)} unit assertions passed.`);
  } else if (pending.length === 0) {
    fail(
      `Vitest reported ${String(completed)} of ${String(total)} assertions without naming the gap.`,
      initial,
    );
  } else {
    console.log(
      `Dawn ended before ${String(total - completed)} assertions in ${pending.map((file) => path.basename(file)).join(', ')}. ` +
        'Running only the incomplete file.',
    );
    for (const file of pending) {
      let passed = false;
      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
        const retry = runVitest([file], `${path.basename(file)}-${String(attempt)}`);
        if (!retry.report) {
          fail(`The retry for ${path.basename(file)} produced no assertion report.`, retry);
          break;
        }
        if (retry.report.numFailedTests > 0) {
          fail(`${String(retry.report.numFailedTests)} assertions failed in ${path.basename(file)}.`, retry);
          break;
        }
        if (
          retry.report.numTotalTests > 0 &&
          retry.report.numPassedTests === retry.report.numTotalTests &&
          retry.report.numPendingTests === 0
        ) {
          passed = true;
          console.log(
            `${path.basename(file)} completed on measured attempt ${String(attempt)}: ` +
              `${String(retry.report.numPassedTests)} assertions passed.`,
          );
          break;
        }
      }
      if (!passed && process.exitCode !== 1) {
        console.error(
          `${path.basename(file)} did not complete in ${String(MAX_ATTEMPTS)} measured attempts.`,
        );
        process.exitCode = 1;
      }
    }
    if (process.exitCode !== 1) {
      console.log(`${String(total)} unit assertions passed, with every collected case complete.`);
    }
  }
}
