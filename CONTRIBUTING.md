# Contributing to Rotyl

Thank you for helping improve Rotyl. For a substantial change, open an issue
first so the problem, evidence and release impact can be agreed before code is
written. Report vulnerabilities through the private process in `SECURITY.md`,
not through an issue.

## Development

```bash
pnpm install
pnpm dev
```

The development command obtains the complete model release pinned by the
manifest. No `VITE_TRACKING_HOST` or other feature flag is needed to include
Track.

Before opening a pull request, run:

```bash
pnpm verify
pnpm e2e
```

`pnpm verify` is the required GitHub Actions gate. Playwright is a separate
real-Chrome suite and uses port 5180. Stop another process using that port before
the suite starts.

Keep a pull request focused and preserve the architecture described in
`docs/architecture.md`. Add tests for behavior changes. A performance or size
claim needs a reproducible measurement and its own generated research entry.
Record an attempted approach that was rejected in the trials ledger with the
evidence that decided it.

Do not commit generated model binaries. A model release change must follow
`models/edgetam/README.md`, preserve the Apache-2.0 files beside the graphs, and
use a new immutable model version. All other project code is contributed under
the repository's MIT license.
