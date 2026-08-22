/**
 * Run ordinary unit tests in Node and shader tests in installed Chrome.
 *
 * GitHub's virtual Macs cannot complete the native Node Dawn suite, even with
 * one shader file per process. Chrome owns Dawn's lifetime across test files
 * and is also the engine the product actually ships against. Both processes
 * must produce a complete machine-readable assertion report.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dawnTestFiles, unitTestFiles } from './dawn-files.mjs';

const scratch = path.resolve('.scratch', `test-gate-${String(Date.now())}`);
mkdirSync(scratch, { recursive: true });

function runVitest(files, label, extra = []) {
  const reportPath = path.join(scratch, `${label}.json`);
  const processResult = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', ...files, ...extra, '--reporter=json', `--outputFile=${reportPath}`],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    report = undefined;
  }
  return { processResult, report };
}

function failures(report) {
  return (report?.testResults ?? [])
    .flatMap((file) => file.assertionResults)
    .filter((test) => test.status === 'failed')
    .flatMap((test) => [`${test.fullName}:`, ...test.failureMessages]);
}

function requireComplete(label, run) {
  const report = run.report;
  const complete = Boolean(
    report?.success &&
    report.numTotalTests > 0 &&
    report.numPassedTests === report.numTotalTests &&
    report.numFailedTests === 0 &&
    report.numPendingTests === 0 &&
    run.processResult.status === 0,
  );
  if (complete) {
    console.log(`${label}: ${String(report.numPassedTests)} assertions passed.`);
    return report.numPassedTests;
  }

  console.error(`${label} did not produce a complete passing assertion report.`);
  const messages = failures(report);
  if (messages.length > 0) console.error(messages.join('\n'));
  if (run.processResult.stdout.trim()) console.error(run.processResult.stdout.trim());
  if (run.processResult.stderr.trim()) console.error(run.processResult.stderr.trim());
  process.exitCode = 1;
  return 0;
}

const dawn = new Set(dawnTestFiles());
const nodeFiles = unitTestFiles().filter((file) => !dawn.has(file));
const node = runVitest(nodeFiles, 'node', ['--fileParallelism=true']);
const nodeAssertions = requireComplete('Node', node);

if (process.exitCode !== 1) {
  const browser = runVitest([], 'chrome-dawn', ['--config', 'vitest.browser.config.ts']);
  const browserAssertions = requireComplete('Chrome Dawn', browser);
  if (process.exitCode !== 1) {
    console.log(`${String(nodeAssertions + browserAssertions)} unit assertions passed.`);
  }
}
