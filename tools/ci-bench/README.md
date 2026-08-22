# CI stability

## Measurement 19: the gate is assertion-complete, not exit-code-only

The unit suite runs WGSL through Dawn's Node bindings. Dawn can abort while its
native objects are being torn down, after Vitest has finished every assertion.
That is a different outcome from a failed or incomplete suite, and a gate has
to prove the difference rather than rerun until it gets the exit it wanted.

```bash
node tools/ci-bench/run.mjs --runs 32
```

Each run writes Vitest's JSON assertion report before the process exits. The
measurement records the report and the exit independently. The CI runner uses
the same rule: a clean exit passes; a nonzero exit passes when a complete report
proves that every collected assertion passed, none failed and none was pending.
A failed assertion or missing report fails immediately. An incomplete file
alone gets a fresh Dawn process, up to three total attempts: the observed
per-process rate puts the estimated residual below one in seventy-seven
thousand suites. Passed files and real failures are never retried.

The result and its observed rate are on `/research/ci.html`.
