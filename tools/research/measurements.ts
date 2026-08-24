/**
 * Every measurement, pulled out of the harnesses' results by path.
 *
 * `at` throws rather than returning undefined, and that is the whole mechanism:
 * if a benchmark stops reporting something, or renames it, the page fails to
 * generate and the build fails with it. The alternative, a blank cell, or a
 * number left over from a shape that no longer exists, is indistinguishable
 * from a measurement to whoever reads it.
 *
 * ONE ENTRY IS ONE FINDING. The organising question is not "which harness
 * produced this" but "what did we learn", which is why tracking has a page of
 * its own rather than four rows inside video: they were answered at different
 * times, they decided different things, and a reader wants one of them and not
 * the other.
 */

import type { Entry, Section } from './page.ts';

/**
 * Read a path, or say exactly which step of it was missing.
 *
 * The path is an array rather than a dotted string, which looks fussier and is
 * not: the harnesses key their results by the human labels a measurement was
 * taken under, and those contain dots and commas. "sigma 0.5",
 * "static-720p, fixed camera". A dotted path would split them into steps that
 * do not exist, which is a wrong answer dressed as a missing one.
 */
function at(source: unknown, path: readonly string[]): unknown {
  let node = source;
  const walked: string[] = [];
  for (const key of path) {
    if (node === null || typeof node !== 'object') {
      throw new Error(`research: ${walked.join(' / ') || '(root)'} is not an object`);
    }
    node = Object.getOwnPropertyDescriptor(node, key)?.value;
    walked.push(key);
    if (node === undefined) throw new Error(`research: no ${walked.join(' / ')} in the results`);
  }
  return node;
}

function num(source: unknown, path: readonly string[]): number {
  const value = at(source, path);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`research: ${path.join(' / ')} is ${String(value)}, not a number`);
  }
  return value;
}

function text(source: unknown, path: readonly string[]): string {
  const value = at(source, path);
  if (typeof value !== 'string') throw new Error(`research: ${path.join(' / ')} is not a string`);
  return value;
}

const ms = (value: number): string => `${value.toFixed(value < 10 ? 1 : 0)} ms`;
/**
 * Bytes below a kilobyte, because one of these is twelve of them and "0.0 KB"
 * reads as a rounding error rather than as the finding it is.
 */
const asBytes = (count: number): string =>
  count < 1024 ? `${count.toFixed(0)} bytes` : `${(count / 1024).toFixed(1)} KB`;
const asDecimalBytes = (count: number): string =>
  count < 1000 ? `${count.toFixed(0)} bytes` : `${(count / 1000).toFixed(1)} KB`;
const pct = (value: number): string => `${value.toFixed(2)}%`;
/** Megabytes, to a hundredth, which is what a document is quoted to everywhere else. */
const asFile = (bytes: number): string => `${(bytes / 1e6).toFixed(2)} MB`;

const SIZES = ['720p', '2 MP', '12 MP', '24 MP'] as const;
const STYLES = ['comic', 'poster', 'print'] as const;

// --- public launch ---------------------------------------------------------

export function publicLaunchEntry(launch: unknown): Entry {
  const probes = at(launch, ['production', 'exposure_probes']);
  if (!Array.isArray(probes)) throw new Error('research: production / exposure_probes is not a list');
  const exposed = probes.filter((_, index) =>
    flag(launch, ['production', 'exposure_probes', String(index), 'exposed']),
  ).length;
  const direct =
    flag(launch, ['production', 'anonymous_https']) && !flag(launch, ['production', 'redirected']);
  const policyRow = (label: string, group: string): readonly string[] => [
    label,
    String(num(launch, ['production', group, 'status'])),
    text(launch, ['production', group, 'cache_control']),
    text(launch, ['production', group, 'content_type']),
  ];

  return {
    slug: 'public-launch',
    results: 'tools/launch-check/results.json',
    title: 'Production deployment audit',
    standfirst:
      'An anonymous check of the live domain, cache rules, model digest and five paths that must never reveal private project files.',
    harness: 'tools/launch-check',
    taken: `Anonymous HTTPS from Node ${text(launch, ['environment', 'node'])}`,
    lede: [
      'A build that passed locally is not proof of the origin a visitor receives. The public check reads the exact Sites output, then approaches the canonical hostname without browser credentials and without following a redirect.',
      `The result is ${direct ? 'one direct HTTPS origin' : 'not a direct HTTPS origin'} for application code and the independently versioned ${text(launch, ['model_release'])} model release. It records only public response metadata, file sizes and derived digests.`,
    ],
    sections: [
      {
        heading: 'The public artifact is the artifact that was checked',
        prose: [
          `The deployment contains ${String(num(launch, ['build', 'deployment_files']))} files and occupies ${asFile(num(launch, ['build', 'deployment_bytes']))}. ${String(num(launch, ['build', 'public_files']))} of those files, occupying ${asFile(num(launch, ['build', 'public_bytes']))}, are below the worker's public asset root.`,
          `The largest public file is ${text(launch, ['build', 'largest_public_file', 'path'])} at ${asFile(num(launch, ['build', 'largest_public_file', 'bytes']))}. The output contains no source map and no temporary archive.`,
        ],
        table: {
          columns: ['boundary', 'files', 'bytes'],
          rows: [
            [
              'saved Sites artifact',
              String(num(launch, ['build', 'deployment_files'])),
              asFile(num(launch, ['build', 'deployment_bytes'])),
            ],
            [
              'public worker assets',
              String(num(launch, ['build', 'public_files'])),
              asFile(num(launch, ['build', 'public_bytes'])),
            ],
          ],
        },
        command: 'node tools/launch-check/measure.mjs',
      },
      {
        heading: 'HTML revalidates and immutable bytes do not',
        prose: [
          `The root, research page, hashed application code and versioned model all answered on ${text(launch, ['canonical_origin'])}. All four returned the worker's referrer, framing and content-type protections.`,
          'HTML must revalidate so an atomic deployment can replace it. A hashed application asset and a model path containing its release version can remain immutable for a year because changing either changes its URL.',
        ],
        table: {
          columns: ['anonymous request', 'status', 'cache-control', 'content-type'],
          rows: [
            policyRow('application HTML', 'root'),
            policyRow('research HTML', 'research'),
            policyRow('hashed application code', 'code'),
            policyRow('versioned model', 'model'),
          ],
        },
        command: 'node tools/launch-check/measure.mjs',
      },
      {
        heading: 'The model crosses the deployment boundary with its digest',
        prose: [
          `${String(num(launch, ['models', 'emitted_files']))} model release files occupy ${asFile(num(launch, ['models', 'served_bytes']))} as served. The probe fetched ${text(launch, ['models', 'probe', 'path'])}, decompressed it and matched all ${String(num(launch, ['models', 'probe', 'decompressed_bytes']))} bytes to the committed SHA-256 digest.`,
          `${String(probes.length)} negative requests looked for deployment configuration, package metadata, worker source, repository data and a temporary site archive. ${String(exposed)} contained the marker that would identify the requested private source.`,
        ],
        table: {
          columns: ['production refusal', 'observed'],
          rows: [
            [
              'model probe matches manifest',
              flag(launch, ['models', 'probe', 'matches_manifest']) ? 'yes' : 'no',
            ],
            ['source maps in public output', String(num(launch, ['build', 'source_maps']))],
            ['temporary archives in public output', String(num(launch, ['build', 'temporary_archives']))],
            ['private-source markers exposed', `${String(exposed)} / ${String(probes.length)}`],
          ],
        },
        caveat:
          'A negative marker probe does not prove that no undiscovered route exists. It makes the intended deployment boundary executable and fails the measurement if any named source or metadata path begins exposing its expected contents.',
        command: 'node tools/launch-check/measure.mjs',
      },
    ],
  };
}

// --- owning the model release ---------------------------------------------

export function modelDeliveryEntry(models: unknown): Entry {
  const group = (name: string, fieldName: string): number => num(models, ['groups', name, fieldName]);
  const before = num(models, ['initial_application', 'before', 'gzip']);
  const owned = num(models, ['initial_application', 'owned_release', 'gzip']);
  const halfServed = num(models, ['serving', 'cold_full_feature_session_half']);
  const halfCached = num(models, ['cache', 'after_tracking_half']);
  const buildCheck = num(models, ['verification_ms', 'build_all']);
  const selectionCheck = num(models, ['verification_ms', 'fetch_selection_half']);
  const trackingCheck = num(models, ['verification_ms', 'fetch_tracking']);

  return {
    slug: 'model-delivery',
    results: 'tools/model-assets/results.json',
    title: 'Model delivery and caching',
    standfirst: `All ${asFile(group('deployment', 'served'))} are pinned and deployed on the same origin. The browser fetches only the features it uses and checks every file before inference.`,
    harness: 'tools/model-assets',
    taken: `${text(models, ['environment', 'cpu'])}, Node ${text(models, ['environment', 'node'])}`,
    lede: [
      'Object selection and tracking were local computations backed by somebody else’s availability. The selection graphs came from a third-party model host at runtime, while the tracking files existed only wherever a builder happened to put them. A clone could build an editor with no Track button, and a deployment could change its model without changing its application.',
      'One manifest owns that boundary now. It pins the upstream revisions, every byte length and every SHA-256 digest. A build vendors the complete project release into its own output; the browser asks only that deployment for a model and checks the same digest before ONNX Runtime sees it.',
    ],
    sections: [
      {
        heading: 'The first page pays nothing for ownership',
        prose: [
          `The committed application chunk is ${asDecimalBytes(before)} gzipped in the control build. The owned release build is ${asDecimalBytes(owned)}, ${asDecimalBytes(before - owned)} smaller, because the model loader itself moved behind first use with the model it loads. The first page makes ${String(num(models, ['initial_application', 'model_requests']))} model requests.`,
          'Ownership changes what a deployment contains, not what a person who opens the drop zone downloads. Object selection still pays on first selection use and tracking still pays on first Track.',
        ],
        table: {
          columns: ['initial application', 'raw', 'gzipped'],
          rows: [
            [
              'committed build',
              asDecimalBytes(num(models, ['initial_application', 'before', 'raw'])),
              asDecimalBytes(before),
            ],
            [
              'owned model release',
              asDecimalBytes(num(models, ['initial_application', 'owned_release', 'raw'])),
              asDecimalBytes(owned),
            ],
          ],
        },
        command: 'node tools/model-assets/measure.mjs',
      },
      {
        heading: 'First use, cache and serving are three different prices',
        prose: [
          `On hardware with half precision, a cold session that selects an object and then tracks it transfers ${asFile(halfServed)} of model data and keeps ${asFile(halfCached)} after decompression. One thousand such cold sessions are ${asFile(num(models, ['serving', 'thousand_full_feature_sessions_half']))} of origin traffic. A warm session transfers none of it.`,
          'The full-precision selection variant has to travel in the deployment for hardware that cannot compile half precision, but one browser fetches one variant and never both. Tracking has one variant.',
        ],
        table: {
          columns: ['first use', 'served', 'kept in Cache Storage'],
          rows: [
            [
              'object selection, half precision',
              asFile(group('selection_half', 'served')),
              asFile(group('selection_half', 'raw')),
            ],
            [
              'object selection, full precision',
              asFile(group('selection_full', 'served')),
              asFile(group('selection_full', 'raw')),
            ],
            ['tracking', asFile(group('tracking', 'served')), asFile(group('tracking', 'raw'))],
          ],
        },
        caveat:
          'Served bytes are the explicit gzip files in the build, independent of whether a static host decides ONNX is compressible. Cache Storage holds the checked, decompressed bytes ONNX Runtime consumes.',
        command: 'node tools/model-assets/measure.mjs',
      },
      {
        heading: 'A deployment carries both selection variants and only fetches one',
        prose: [
          `The model part of a deployment is ${asFile(group('deployment', 'served'))}, against ${asFile(group('deployment', 'raw'))} uncompressed. That is storage and release bandwidth paid once per deployment, not first-load traffic.`,
          `The cache name and every URL contain the manifest version. On the next model use after an update, the browser deletes the previous Rotyl model cache before opening the new one. That gives back ${asFile(num(models, ['cache', 'invalidated_on_next_model_use_half']))} in the ordinary half-precision case, then downloads only whichever features are used again.`,
        ],
        table: {
          columns: ['deployment contents', 'files', 'served'],
          rows: [
            [
              'selection, both variants',
              String(group('selection_half', 'files') + group('selection_full', 'files')),
              asFile(group('selection_half', 'served') + group('selection_full', 'served')),
            ],
            ['tracking', String(group('tracking', 'files')), asFile(group('tracking', 'served'))],
            ['licence and notice', String(group('legal', 'files')), asFile(group('legal', 'served'))],
          ],
        },
        command: 'node tools/model-assets/measure.mjs',
      },
      {
        heading: 'The digest belongs at build and at fetch',
        prose: [
          `Checking the complete release at build takes ${ms(buildCheck)}. It catches a missing, stale or replaced release before a deployable directory exists. Checking the half-precision selection files after fetch takes ${ms(selectionCheck)}, and the tracking files ${ms(trackingCheck)}. That second check covers the origin response and Cache Storage, which did not exist at build time.`,
          'A mismatch is never handed to the runtime. The build names the file, expected length and expected digest and produces no deployment. The editor names the refused file and release, says the deployment or cache is incomplete, and tells the user to reload or contact the deployer. Retrying a changed graph under the same version would turn an integrity failure into a silent model swap.',
        ],
        table: {
          columns: ['checked boundary', 'median'],
          rows: [
            ['all release files at build', ms(buildCheck)],
            ['selection, half precision, after fetch', ms(selectionCheck)],
            [
              'selection, full precision, after fetch',
              ms(num(models, ['verification_ms', 'fetch_selection_full'])),
            ],
            ['tracking after fetch', ms(trackingCheck)],
            ['inflate selection, half precision', ms(num(models, ['inflate_ms', 'selection_half']))],
            ['inflate tracking', ms(num(models, ['inflate_ms', 'tracking']))],
          ],
        },
        caveat:
          'Digest timings use Web Crypto over the exact bytes in the manifest. Decompression is timed separately because it is a transport cost rather than an integrity check.',
        command: 'node tools/model-assets/measure.mjs',
      },
      {
        heading: 'A clone with no assets cannot produce a partial product',
        prose: [
          'The normal build fills a local cache from Rotyl’s immutable release, verifies every file, then emits every feature. A maintainer may point that preparation step at a local export or another origin, but the override changes only where bytes are obtained; it cannot change the manifest or bypass a digest.',
          'Offline with an empty cache, an unavailable release, or one wrong byte, the build stops before Vite and says how to supply the complete release. There is no output with a Track button waiting to fail, and no successful output with the button missing.',
        ],
        command: 'pnpm models:check',
      },
    ],
  };
}

// --- CI stability ----------------------------------------------------------

export function ciStabilityEntry(ci: unknown): Entry {
  const runs = num(ci, ['summary', 'runs']);
  const clean = num(ci, ['summary', 'clean_exits']);
  const aborts = runs - clean;
  const rawRate = (aborts / runs) * 100;
  const processRate = num(ci, ['summary', 'observed_process_abort_rate']) * 100;
  const residual = num(ci, ['summary', 'estimated_incomplete_suites_after_three_attempts']);
  const residualPct = `${(residual * 100).toFixed(4)}%`;
  const oneIn = Math.floor(1 / residual).toLocaleString('en-GB');

  return {
    slug: 'ci',
    results: 'tools/ci-bench/results.json',
    title: 'Shader test reliability',
    standfirst:
      'Dawn crashed both after completed assertions and during unfinished files. The assertion report, not the process code, became the gate.',
    harness: 'tools/ci-bench',
    taken: `${text(ci, ['environment', 'cpu'])}, Node ${text(ci, ['environment', 'node'])}`,
    lede: [
      'A CI workflow that reruns until green teaches exactly the wrong lesson, and a workflow that trusts one native process exit flakes on code that passed. The unit suite needs a third answer: preserve every real shader assertion while recognising the one failure mode Dawn’s Node binding has after or between them.',
      'The harness records Vitest’s machine-readable assertion report and the process exit separately. A failed assertion, a missing report and an incomplete file are therefore different outcomes before any policy is applied.',
    ],
    sections: [
      {
        heading: 'Exit code alone would reject nearly one change in ten',
        prose: [
          `${String(runs)} complete suites produced ${String(clean)} clean exits and ${String(aborts)} native exits, a raw gate failure rate of ${pct(rawRate)}. There were ${String(num(ci, ['summary', 'assertion_failures']))} failed assertions. One native exit came after all assertions had passed; two left a GPU file’s cases pending.`,
          'That last split is why accepting a recognisable Dawn exit is not safe. Some of these exits changed only teardown, while others stopped cases from running. The assertion report, not the native message, is the proof.',
        ],
        table: {
          columns: ['outcome', 'suites'],
          rows: [
            ['clean process exit', String(clean)],
            [
              'native exit after complete assertion proof',
              String(num(ci, ['summary', 'post_assertion_aborts'])),
            ],
            ['native exit with an incomplete file', String(num(ci, ['summary', 'incomplete_runs']))],
            ['failed assertions', String(num(ci, ['summary', 'assertion_failures']))],
          ],
        },
        command: 'node tools/ci-bench/run.mjs --runs 32',
      },
      {
        heading: 'Only the incomplete file gets another process',
        prose: [
          `The observed rate is ${pct(processRate)} per Dawn process. At that rate, allowing an incomplete file three total processes leaves an estimated ${residualPct} incomplete suites, below one in ${oneIn}. A failed assertion is never run again, and neither is any file whose assertions already passed.`,
          'A nonzero process with a complete passing report passes because every claimed test ran. A report with pending cases names their file and only that file starts in a fresh Dawn process. No report, any failed assertion, or a file still incomplete at the measured bound fails the job.',
        ],
        table: {
          columns: ['gate', 'raw false failure estimate'],
          rows: [
            ['exit code only', pct(rawRate)],
            ['assertion proof with the measured bound', residualPct],
          ],
        },
        caveat: `The residual is the observed per-process exit rate raised to the three-attempt bound, across the ${String(num(ci, ['summary', 'dawn_files_per_suite']))} shader files in one suite. It is a reliability estimate from this run, not a claim that native failures are independent on every machine.`,
        command: 'node tools/ci-bench/run.mjs --runs 32',
      },
    ],
  };
}

interface HostedNativeResults {
  readonly standard: unknown;
  readonly intel: unknown;
  readonly xlarge: unknown;
}

/** The hosted-runner measurement that tested the local gate's premise. */
export function hostedCiEntry(native: HostedNativeResults, browser: unknown): Entry {
  const nativeRows = [
    ['standard virtual Mac', native.standard],
    ['Intel virtual Mac', native.intel],
    ['GPU larger Mac', native.xlarge],
  ] as const;
  const complete = (result: unknown, group: 'suite' | 'isolated'): number =>
    num(result, [group, 'processes']) -
    num(result, [group, 'incomplete_processes']) -
    num(result, [group, 'assertion_failures']);
  const ratio = (result: unknown, group: 'suite' | 'isolated'): string =>
    `${String(complete(result, group))} / ${String(num(result, [group, 'processes']))}`;
  const fullProcesses = nativeRows.reduce(
    (total, [, result]) => total + num(result, ['suite', 'processes']),
    0,
  );
  const fullComplete = nativeRows.reduce((total, [, result]) => total + complete(result, 'suite'), 0);
  const isolatedProcesses = nativeRows.reduce(
    (total, [, result]) => total + num(result, ['isolated', 'processes']),
    0,
  );
  const isolatedComplete = nativeRows.reduce((total, [, result]) => total + complete(result, 'isolated'), 0);
  const browserProcesses = num(browser, ['summary', 'processes']);
  const browserComplete = num(browser, ['summary', 'complete_processes']);
  const browserAssertions = num(browser, ['observations', '0', 'report', 'total']);

  return {
    slug: 'hosted-ci',
    results: 'tools/ci-bench/browser-results.json',
    title: 'GPU tests on GitHub runners',
    standfirst: `No native runner completed the full suite. Installed Chrome finished all ${String(browserProcesses)} cycles with every shader assertion accounted for.`,
    harness: 'tools/ci-bench',
    taken: `${text(browser, ['environment', 'cpu'])}, Node ${text(browser, ['environment', 'node'])}`,
    lede: [
      'The local measurement found a narrow native teardown failure and justified retrying only an incomplete shader file. That was a candidate policy, not permission to assume the same distribution on a different machine. The first GitHub run contradicted it, so the runner itself became the next measurement.',
      'Every hosted variant was asked both questions: can the unchanged full suite complete, and does putting each shader file in its own native process remove the failure. The answer to both was no. The installed Chrome on the ordinary runner was then asked to execute the same WGSL assertions while the browser, rather than Vitest, owned Dawn’s process lifetime.',
    ],
    sections: [
      {
        heading: 'No hosted native runner completed a full suite',
        prose: [
          `${String(fullComplete)} of ${String(fullProcesses)} unchanged full-suite processes completed across the three hosted Mac shapes. None reported a failed assertion; they stopped with cases still pending. A retry count cannot be derived from a runner on which the observed full-suite completion rate is zero.`,
          `One shader file per process improved the shape without fixing it: ${String(isolatedComplete)} of ${String(isolatedProcesses)} processes completed. The result also moved sharply with the runner, which rules out transplanting the local machine’s process rate into GitHub’s gate.`,
        ],
        table: {
          columns: ['hosted runner', 'reported CPU', 'full suite complete', 'isolated files complete'],
          rows: nativeRows.map(([label, result]) => [
            label,
            text(result, ['environment', 'cpu']),
            ratio(result, 'suite'),
            ratio(result, 'isolated'),
          ]),
        },
        caveat:
          'A complete process means a zero exit and a report with every assertion passed and none pending. An assertion failure is counted separately and is never treated as native instability.',
        command: 'Run “Measure hosted Dawn” from GitHub Actions',
      },
      {
        heading: 'The larger GPU runner made the native binding worse',
        prose: [
          `The GPU larger Mac completed ${ratio(native.xlarge, 'isolated')} isolated processes, against ${ratio(native.standard, 'isolated')} on the standard virtual Mac and ${ratio(native.intel, 'isolated')} on Intel. Paying for a runner advertised with GPU acceleration does not change who owns the native binding’s teardown, and did not buy a usable gate.`,
          'This is why CI does not select a more expensive machine and does not hide the result behind a larger retry budget. Both approaches preserve the failure boundary the measurement identified.',
        ],
        command: 'node tools/ci-bench/hosted.mjs --cycles 16',
      },
      {
        heading: 'Installed Chrome completed every hosted cycle',
        prose: [
          `${String(browserComplete)} of ${String(browserProcesses)} Chrome processes completed all ${String(browserAssertions)} shader assertions. That is ${String(browserComplete * browserAssertions)} assertion executions with none failed or pending on the same standard virtual Mac where native Node Dawn completed no full suite.`,
          'The shader files are discovered through their local import graph and assembled into one browser page. That keeps one Chrome-owned device across the shader suite, which is the lifetime the product has, while ordinary DOM-free unit tests remain parallel Node processes.',
        ],
        table: {
          columns: ['gate on the standard virtual Mac', 'complete processes', 'failed assertion processes'],
          rows: [
            [
              'native Node Dawn',
              ratio(native.standard, 'suite'),
              String(num(native.standard, ['suite', 'assertion_failures'])),
            ],
            [
              'installed Chrome Dawn',
              `${String(browserComplete)} / ${String(browserProcesses)}`,
              String(num(browser, ['summary', 'failed_assertion_processes'])),
            ],
          ],
        },
        command: 'node tools/ci-bench/browser.mjs --cycles 16',
      },
      {
        heading: 'The gate has no retry path',
        prose: [
          'The Node report and the Chrome report must each exist, exit cleanly, contain tests, and say that every collected assertion passed with none pending. A failed assertion, a missing installed Chrome, unavailable WebGPU, a missing report, or an incomplete report fails the job on that run.',
          'The required workflow runs the same pnpm verify command maintainers run locally, then builds and inspects the production Sites layout. Playwright remains separate because it exercises gestures, media and model-backed browser paths rather than unit assertions.',
        ],
        command: 'pnpm verify',
      },
    ],
  };
}

// --- the look ---------------------------------------------------------------

function styleCost(style: unknown): Section {
  const median = (size: string, name: string): number =>
    num(style, ['chain', size, `${name}, default`, 'full', 'median']);
  // Computed, because both of these are ratios between two cells of the table
  // below and a ratio typed into prose is a number waiting to go stale. The
  // second one did: the comic chain got three times cheaper at 720p when its
  // flatten was bounded below the frame, and "200 times" survived the run.
  const times = (size: string): string => (median(size, 'comic') / median(size, 'print')).toFixed(0);
  return {
    heading: 'What a style chain costs',
    prose: [
      `Two of the three styles run in under two milliseconds at 720p. The third takes ${ms(
        median('720p', 'comic'),
      )} there and ${ms(median('12 MP', 'comic'))} at twelve megapixels, and spends essentially all of it in a single stage.`,
      `The print chain had never been timed before this. It was argued to be cheaper, on the grounds that it is three passes against nineteen with only one at output resolution. It is ${times('720p')} times cheaper at 720p and ${times('2 MP')} at two megapixels.`,
      'A style does not have to be expensive to be flat. That is what the third style came out of: one that fits inside a frame is something a clip can be played through, rather than something a clip is rendered with.',
    ],
    table: {
      columns: ['style, default controls', ...SIZES],
      rows: STYLES.map((name) => [
        name,
        ...SIZES.map((size) => ms(num(style, ['chain', size, `${name}, default`, 'full', 'median']))),
      ]),
    },
    caveat:
      'Full quality tier, style chain only: the composite is a separate pass that re-runs on every brush movement. The 24 MP column is the one place the ordering stops being 20:1. Both cheap styles do all of their deciding in one pass at output resolution, so past about 12 megapixels they are paying for pixels rather than for thinking.',
    command: 'node tools/style-bench/run.mjs chain',
  };
}

function detailCost(style: unknown): Section {
  const tier = (name: string): string => ms(num(style, ['chain', '720p', 'comic, detail 1', name, 'median']));
  const cell = (size: string, name: string): number => num(style, ['chain', size, name, 'full', 'median']);
  const faster = (size: string): string =>
    (cell(size, 'comic, detail 0') / cell(size, 'comic, detail 1')).toFixed(1);
  return {
    heading: 'Higher detail is cheaper, and the quality tiers collapse',
    prose: [
      `Turning detail up makes the comic chain ${faster('720p')} times faster at 720p, and a draft frame there is the same render as an export. Both of those sound like bugs and are consequences of one decision.`,
      'Each stage declares the apparent scale it wants and derives its own resolution to hold it. When the picture cannot supply that resolution, the kernel shrinks rather than the fraction drifting. Cost falls, and the tiers converge.',
      'The flatten reaches that bound sooner than it used to, because it is now held a root two below the frame rather than at it: the downsample onto it is this chain’s grain rejection and a buffer the size of the picture is not a downsample. What that cost is on the page it came from; what it bought here is the 720p column and the two megapixel one.',
    ],
    table: {
      columns: ['comic, full tier', ...SIZES],
      rows: [
        ['comic, detail 0', 'detail 0'],
        ['comic, default', 'detail 0.5'],
        ['comic, detail 1', 'detail 1'],
      ].map(([key, label]) => [
        label ?? '',
        ...SIZES.map((size) => ms(num(style, ['chain', size, key ?? '', 'full', 'median']))),
      ]),
    },
    caveat: `At 720p and detail 1 every tier reaches the same bound: draft ${tier('draft')}, full ${tier('full')}, export ${tier('export')}. "Draft is cheaper" is not universally true, and no code may assume it.`,
    command: 'node tools/style-bench/run.mjs chain',
  };
}

function stability(style: unknown): Section {
  const clip = ['clips', 'static-720p, fixed camera'];
  const row = (label: string, name: string, side: string): readonly string[] => {
    const path = [...clip, name, side];
    return [
      label,
      num(style, [...path, 'mean']).toFixed(2),
      num(style, [...path, 'p99']).toFixed(1),
      pct(num(style, [...path, 'flicker'])),
    ];
  };
  return {
    heading: 'Nothing boils here, and not for the reason anyone expected',
    prose: [
      'On this picture no style amplifies its input, every one attenuates it, and the chain that looked most at risk is the steadiest of the three. Two of those three claims survived a photograph unchanged and the poster row did not: see what survived a real picture, which re-takes this table against four of them and a film, and which is where the outline this row depends on was rebuilt.',
      'The worry was reasonable. Every stage runs per frame with no knowledge of the last one, and two of them are winner-take-all decisions on a noisy field: a Kuwahara picking its most homogeneous sector, a difference of Gaussians thresholding a response. A pixel one code different between two frames could flip either.',
      'It does not, because neither decides on one pixel. The Kuwahara chooses on the variance of two hundred samples, and the chain removes more grain than its decisions reintroduce.',
    ],
    table: {
      columns: ['per-pixel change between frames', 'mean', 'p99', 'over 8 codes'],
      rows: [
        row('the source', 'comic, default', 'source'),
        row('comic', 'comic, default', 'styled'),
        row('poster', 'poster, default', 'styled'),
        row('print', 'print, default', 'styled'),
      ],
    },
    caveat:
      'In output codes, over consecutive decoded frames of a fixed camera on a fixed scene, so everything that differs between two of them is grain and the encoder’s own noise. The mean is the least useful column: boiling is a small proportion of pixels moving a long way, which is what the other two measure. The scene is drawn rather than photographed, which is why every row here is read against the page that re-takes it on four that are not.',
    command: 'node tools/style-bench/run.mjs clips',
  };
}

function perturbation(style: unknown): Section {
  const p99 = (sigma: string, name: string): string =>
    `${num(style, ['perturbation', sigma, name, 'p99']).toFixed(0)} codes`;
  return {
    heading: 'The same result with the codec taken out of it',
    prose: [
      'The finding survives without a codec in the way. One frame is rendered twice, the second with grain of a known size added, so what is measured is the style and nothing else.',
      'Half a code is about the smallest perturbation an 8-bit pipeline can express, which is the "one code different between two frames" case exactly. Two codes is roughly a decent sensor at base ISO.',
    ],
    table: {
      columns: ['99th percentile change', 'grain σ 0.5', 'grain σ 2'],
      rows: [
        ['the input', 'input'],
        ['comic', 'comic, default'],
        ['poster', 'poster, default'],
        ['print', 'print, default'],
      ].map(([label, name]) => [label ?? '', p99('sigma 0.5', name ?? ''), p99('sigma 2', name ?? '')]),
    },
    command: 'node tools/style-bench/run.mjs perturbation',
  };
}

function transitionFloor(): Section {
  return {
    heading: 'Every hard decision needs a floor under its transition',
    prose: [
      'What does boil is a hard threshold against a fixed field. A halftone dot is one. So is a quantiser, if it is left hard: the poster style’s first version measured five to ten times worse than the comic chain on a still camera.',
      'The cause is exact. Softening a step across one pixel is right for an edge and useless for a gradient, because where the field is nearly flat the local derivative is nearly zero. A band boundary then becomes a step of a whole level driven by a hundredth of one, and a frame of grain moves it.',
      'The fix is a floor under the transition width, expressed in the units of the thing being decided rather than in pixels. It caps the gain from input to output at about four. Chroma was the larger half: colour steps are as discontinuous as lightness ones and there are more of them, because chroma is small everywhere in a hazy picture.',
    ],
    table: {
      columns: ['poster, static camera', 'p99', 'over 8 codes'],
      rows: [
        ['hard, derivative only', '23.3', '1.67%'],
        ['lightness and palette margin floored', '14.6', '1.23%'],
        ['chroma floored as well', 'the row above', 'the row above'],
      ],
    },
    caveat:
      'Taken during development by re-running the clip measurement against each version. The last row is whatever the table above reports today; the first two are gone from the code and cannot be regenerated without reverting it. The fix costs nothing measurable and nothing visible: the transition only widens where the picture has no edge to sharpen. What it did not reach is the outline, which took its decision against a NEIGHBOUR’s rounded colour and so had no derivative to floor. That is the defect the real-picture page found, and what answered it there was a different operator rather than another floor.',
  };
}

function paletteFit(): Section {
  return {
    heading: 'A palette has to be fitted to the picture',
    prose: [
      'A hazy photograph uses two and a half of a palette’s five stops, and comes out in one colour. That looks like a palette chosen badly. It is a palette barely used.',
      'A palette is a claim about where a photograph’s lightness lives, and photographs disagree. The reference scene has a spread of 0.136 against 0.23 to 0.29 for every palette in the codebase.',
      'The fix is one pass measuring the picture’s own mean and spread, and one affine map moving it onto the palette’s. On a hazy frame it changes more than anything else measured here. The claim was re-taken against four photographs afterwards, because a scene drawn to be hazy is a poor witness to haze; it holds on all four, by less than the scene implies.',
    ],
    table: {
      columns: ['lightness', 'p1', 'p50', 'p99', 'mean', 'spread'],
      rows: [
        ['the reference scene', '0.35', '0.64', '0.84', '0.60', '0.136'],
        ['Mural palette', '', '', '', '0.64', '0.234'],
        ['Riso palette', '', '', '', '0.57', '0.249'],
        ['Noir palette', '', '', '', '0.54', '0.288'],
      ],
    },
    figure: {
      name: 'palettes',
      caption: 'The same frame, flattened the same way, under no palette and two of the five.',
    },
    caveat:
      'A fixed sampling grid is what makes measuring this per frame safe on video: the sample points do not move between frames and each tap is a local average of an already smoothed buffer, so the statistics follow the scene rather than the grain. The stability table above includes the fitted palettes, which is the check on that claim rather than the argument for it.',
  };
}

// --- a real picture ---------------------------------------------------------

const REAL_PICTURES = ['facade', 'foliage', 'fog', 'portrait'] as const;
const REAL_CLIPS = [
  ['the synthetic scene', 'the synthetic scene, fixed camera'],
  ['facade', 'facade, fixed camera'],
  ['foliage', 'foliage, fixed camera'],
  ['fog', 'fog, fixed camera'],
  ['portrait', 'portrait, fixed camera'],
  ['a film, exterior', 'Tears of Steel, exterior'],
  ['a film, interior', 'Tears of Steel, interior'],
] as const;

function realInputs(): Section {
  return {
    heading: 'The input a benchmark cannot commit',
    prose: [
      'Every temporal and cost number on the page before this was taken against a scene drawn by a script, and that harness says plainly that a script cannot produce a photograph’s texture statistics. The headline finding on it, that no style amplifies its input, is the whole argument for why per-frame stylisation is acceptable at all. It had never been put to a picture a camera took.',
      'Real footage cannot be checked in, so there were two honest ways to take this. Fetch a known input by URL and pin it by hash, or publish the number with a note saying nobody can reproduce it. The second is worse than it sounds: the measurement it applies to is the one the design rests on, and a number nobody can re-take is a number nobody can contradict.',
      'So it is fetched, and pinned by SHA-256 before anything is derived from it. That leaves one failure the synthetic scene does not have, a URL that stops resolving, and removes the one that matters. If the bytes at the far end change, the script refuses to run rather than quietly measuring a different picture.',
      'Three kinds of input, because no one of them settles it. The scene itself, re-taken in the same run rather than quoted from the page next door. Four photographs put through exactly the recipe that made the scene’s clip, so the picture is the only thing that differs. And two shots of a film, stream copied rather than re-encoded, which carry real sensor grain and real codec noise and also real subject motion, the one thing a fixed camera was isolating and no real shot can be without.',
    ],
    table: {
      columns: ['input', 'what it is there for'],
      rows: [
        ['the synthetic scene', 'the control, re-taken in the same run'],
        ['facade', 'strong directional structure, near monochrome, high contrast'],
        ['foliage', 'fine and isotropic: the other end of the axis'],
        ['fog', 'hazy distance and thin road markings: what the scene was drawn to imitate'],
        ['portrait', 'skin, and large out-of-focus areas'],
        ['a film', 'real grain, real codec noise, real motion, CC-BY, hash pinned'],
      ],
    },
    caveat:
      'The photographs are CC0 from Wikimedia Commons. The film is Tears of Steel, CC-BY 3.0, (CC) Blender Foundation. Nothing fetched is committed or redistributed. The film’s two shots are the quietest in it, found by scanning every frame for the window whose worst consecutive-frame difference is smallest; neither is locked off, because no real shot is.',
    command: './tools/style-bench/fetch-real.sh',
  };
}

function realCost(real: unknown): Section {
  const cell = (picture: string, size: string, name: string): string =>
    ms(num(real, ['real-chain', picture, size, name, 'full', 'median']));
  // Computed rather than typed, like every other figure here: a percentage in
  // prose is exactly as capable of going stale as one in a table.
  const at720 = (picture: string): number =>
    num(real, ['real-chain', picture, '720p', 'comic, default', 'full', 'median']);
  const scene = at720('the synthetic scene');
  const cheaper = (picture: string): string => `${(((scene - at720(picture)) / scene) * 100).toFixed(0)}%`;
  // Signed, and read through Math.abs where it is quoted: an earlier version of
  // this said every photograph was cheaper than the scene, which was true when
  // it was written and stopped being true when the comic chain's flatten was
  // bounded and the whole column moved.
  const against = (picture: string): number => ((at720(picture) - scene) / scene) * 100;
  const cheapest = REAL_PICTURES.reduce((a, b) => (at720(a) < at720(b) ? a : b));
  const dearest = REAL_PICTURES.reduce((a, b) => (at720(a) > at720(b) ? a : b));
  const band = (
    Math.max(...REAL_PICTURES.map(against), 0) - Math.min(...REAL_PICTURES.map(against), 0)
  ).toFixed(0);
  return {
    heading: 'Content barely moves the cost table, and not the way it was meant to',
    prose: [
      'This was expected to move. The anisotropic Kuwahara’s sample bound grows with local anisotropy, so a frame of architecture should cost more than a frame of foliage, and the harness that took the original figures carries a caveat telling readers to treat the comic column as a hard case rather than a typical one.',
      `The prediction does not appear. Foliage is the dearest of the four photographs and a brick wall is not, which is the ordering backwards. What does appear is a smaller effect running the other way: the portrait is the cheapest of the five, ${cheaper(
        'portrait',
      )} below the scene, and large out-of-focus areas are exactly where anisotropy is low.`,
      `So the caveat was right that the scene is not typical and wrong about how much that matters. All five sit inside a band ${band}% wide: the ${cheapest} is ${cheaper(
        cheapest,
      )} below the scene and the ${dearest} is within ${Math.abs(against(dearest)).toFixed(
        0,
      )}% of it. That is a narrow range rather than a class of its own. Cost is set by the stage resolutions, and those are derived from the output’s short edge and from nothing in the picture.`,
    ],
    table: {
      columns: ['comic, default, full tier', ...SIZES],
      rows: [
        ['the synthetic scene', ...SIZES.map((size) => cell('the synthetic scene', size, 'comic, default'))],
        ...REAL_PICTURES.map((picture) => [
          picture,
          ...SIZES.map((size) => cell(picture, size, 'comic, default')),
        ]),
      ],
    },
    caveat: `The two cheap chains are flat across content as well: poster runs ${cell('facade', '720p', 'poster, default')} on the wall and ${cell('foliage', '720p', 'poster, default')} on the leaves. Photographs are cropped to the ladder’s aspect rather than stretched into it, because stretching one axis by up to two is a change to local anisotropy, which is the thing under test.`,
    command: 'node tools/style-bench/run.mjs real-chain',
  };
}

function realStability(real: unknown): Section {
  const cell = (clip: string, name: string): string =>
    num(real, ['real-clips', clip, name, 'amplification', 'p99']).toFixed(2);
  return {
    heading: 'The comic chain held. The poster chain had to be rebuilt.',
    prose: [
      'Half of the original finding survived a photograph untouched. The comic chain really is steadier than its input, on a photograph as on a drawing, which is the part that was surprising and the part the design leans on.',
      'The other half was false, and it was the poster chain. On a brick wall it amplified by 5.7 and on foliage by 4.9, where the synthetic scene reports it attenuating by two. That is not a small drift in a number: it is the opposite sign, on the measurement that says whether stylised video is worth shipping, and it was invisible for as long as the input was drawn rather than photographed. The two sections below are what it turned out to be and what replaced it. This table is taken afterwards, and the wall now reads 1.36.',
      'The two rows that are not fixed cameras are read differently and are here for a different reason. An actor moving is a large honest change and it lands in the source column, so the ratio is the only thing those rows can say. What they said before the change was that the poster chain was four times its input on real footage while the other two were near one; what they say now is that all three sit between one and two.',
      'The comic column is the middle of a control that has two other ends, and read across all three it is a slope rather than a number. What raising detail was doing has its own page, because it turned out not to be what this one said it was.',
    ],
    table: {
      columns: ['styled change over source change, p99', 'comic', 'poster', 'poster, no outline', 'print'],
      rows: REAL_CLIPS.map(([label, clip]) => [
        label,
        cell(clip, 'comic, default'),
        cell(clip, 'poster, default'),
        cell(clip, 'poster, no line'),
        cell(clip, 'print, default'),
      ]),
    },
    caveat:
      'Twenty-four consecutive frames, in output codes, at the 99th percentile of the per-pixel change between one frame and the next. One means the style is exactly as steady as what it was given. The fourth column is the same chain with the outline switched off, which is the floor the third column is trying to reach and the diagnostic the next section is about.',
    command: 'node tools/style-bench/run.mjs real-clips',
  };
}

function realOutline(real: unknown): Section {
  const p99 = (picture: string, name: string): string =>
    num(real, ['real-perturbation', picture, 'sigma 2', name, 'p99']).toFixed(0);
  return {
    heading: 'It was the outline, and the quantiser inside it',
    prose: [
      'With the codec, the camera and the subject all taken out, the same result appeared and it had one cause. One picture is rendered twice with grain of a known size added the second time, so what is measured is the style and nothing else. On the wall a perturbation whose 99th percentile is six codes came out the far side at seventy-eight. Turned the outline off and it came out at eight.',
      'The mechanism is exact. The outline compared the quantised colour here against the quantised colour a line away, and a quantised colour is what round() returns: it flips a whole band on an infinitesimal change, the flip moved the comparison by a fifth of the Oklab range, that crossed the line threshold, and a stroke appeared at full weight. The scene could not show it. It was drawn with large near-flat regions, so almost no pixel in it sits near a band edge, and the population that flickers is exactly that one. A brick wall is nothing but marginal boundaries.',
      'What the quantiser was contributing was the flicker and nothing else. Two sides in different bands returned a whole band however far apart the picture had them, so which pixels along a faint boundary got a stroke was decided by where the band grid happened to fall: a faint line was drawn as a dotted one rather than as a fainter one. The outline now measures the flattened colour itself and its weight is that distance, ramped up to the threshold. The table is after that change, and the row it was written for reads fifteen against a floor of eight.',
    ],
    table: {
      columns: ['grain σ 2, p99 out', 'input', 'comic', 'poster', 'poster, no outline', 'print'],
      rows: [['the synthetic scene', ...REAL_PICTURES] as const]
        .flat()
        .map((picture) => [
          picture,
          p99(picture, 'input'),
          p99(picture, 'comic, default'),
          p99(picture, 'poster, default'),
          p99(picture, 'poster, no line'),
          p99(picture, 'print, default'),
        ]),
    },
    caveat:
      'The remainder is not the quantiser and does not look like it: the map that real-flicker writes no longer traces the ink but scatters through the texture, which is the flatten’s own edge contrast moving under the grain and being read through the ramp. Five codes above the floor on the two worst pictures in this set is where that leaves it. The section below is the four tuning passes tried before the operator was replaced, and why none of them could have worked.',
    command: 'node tools/style-bench/run.mjs real-perturbation',
  };
}

function outlineAttempts(): Section {
  return {
    heading: 'Four tuning passes, and why the answer was a different operator',
    prose: [
      'The old outline compared two quantised colours and thresholded the distance between them, so there were exactly two hard decisions in it and each could be softened independently. All four combinations were measured against the worst picture, and the useful result is the one that says none of them works.',
      'Softening the neighbour probe buys about a fifth and costs the look, because a soft probe reduces the distance at a genuine boundary as much as it reduces the noise at a marginal one. Centring the threshold’s transition rather than opening at it is free and buys nothing on its own. The two together get within three times of the floor and no closer, and the floor is the same picture with the outline switched off.',
      'What that pattern means is not a tuning problem. The quantity being thresholded is a distance between two rounded colours and is therefore discrete: with a hard probe it takes a handful of values and a transition width has nothing to resolve, and with a soft probe the signal and the noise are the same quantity and softening moves both. So the probe stopped rounding. Reading the flattened colour instead makes the strength continuous in the picture by construction, and it stays a region boundary rather than becoming a difference of Gaussians because of WHICH picture it reads: the bilateral’s piecewise-constant answer, which is where smog, grain and the inside of foliage have already gone.',
    ],
    table: {
      columns: ['what was changed, grain σ 2, p99 out of 6 in', 'facade', 'foliage'],
      rows: [
        ['nothing, as it was', '85', '61'],
        ['the probe softened', '69', '46'],
        ['the threshold centred, half width 0.02', '85', '54'],
        ['the threshold centred, half width 0.12', '59', '37'],
        ['both, half width 0.06', '34', '27'],
        ['both, half width 0.10', '25', '21'],
        ['the probe unrounded, a ramp to the threshold', '15', '16'],
        ['no outline at all', '8', '7'],
      ],
    },
    caveat:
      'Taken during development by re-running the perturbation against each version; five of the eight rows are gone from the code and cannot be regenerated without reverting it, which is the same footing the transition-floor table on the look page is on. The last two are what the table above reports today. Every one of them was checked against the look as well as against the number, by rendering the reference scene through both chains and differencing: the shipped operator moves 7.8% of that picture more than eight codes, and what moves is the outlines the old one drew on the quantiser’s grid rather than on the picture.',
    command: 'node tools/style-bench/run.mjs real-flicker',
  };
}

/** The seven inputs, paired with the clip each one was also measured as. */
const REAL_STILLS = [
  ['the drawn scene', 'the synthetic scene', 'the synthetic scene, fixed camera'],
  ['facade', 'facade', 'facade, fixed camera'],
  ['foliage', 'foliage', 'foliage, fixed camera'],
  ['fog', 'fog', 'fog, fixed camera'],
  ['portrait', 'portrait', 'portrait, fixed camera'],
  ['a film, exterior', 'a film, exterior', 'Tears of Steel, exterior'],
  ['a film, interior', 'a film, interior', 'Tears of Steel, interior'],
] as const;

const DETAILS = [
  ['comic, detail 0', 'detail 0'],
  ['comic, default', 'detail 0.5'],
  ['comic, detail 1', 'detail 1'],
] as const;

function detailRows(real: unknown): Section {
  const cell = (clip: string, item: string): string =>
    ratio(num(real, ['real-clips', clip, item, 'amplification', 'p99']));
  return {
    heading: 'The control has a broken end, and the column had been sitting here',
    prose: [
      'The comic row on the page before this is read at the middle of its detail control, and the control has two other ends. Read across all three it is not one number, it is a slope, and on every input the slope runs the same way: the top of the control is where a chain that attenuates starts to amplify.',
      'The figures that started this chapter are not the ones in the table below, which is taken after it. They were a brick wall at 0.63, 0.88 and 2.00, the film’s exterior at 1.40, 1.80 and 2.28, and the drawn scene reporting 0.28, 0.34 and 0.59 and saying nothing about any of it for the third time. Somebody who wanted the steadiest comic frame was told, in known limits, to turn detail down.',
      'The explanation written beside those numbers was that raising detail shrinks the Kuwahara radius until the flatten stops flattening. That is the wrong mechanism, and the two sections below are how it was caught and what replaced it.',
    ],
    table: {
      columns: ['comic, amplification p99', ...DETAILS.map(([, label]) => label)],
      rows: REAL_STILLS.map(([label, , clip]) => [label, ...DETAILS.map(([item]) => cell(clip, item))]),
    },
    caveat:
      'Twenty-four consecutive frames, in output codes, at the 99th percentile of the per-pixel change between one frame and the next, over the styled frame and the source frame that produced it. The two film rows carry subject motion in both columns and cannot be read as absolutes; the section below is about what is left of them when the motion is taken out.',
    command: 'node tools/style-bench/run.mjs real-clips',
  };
}

function filmStills(real: unknown): Section {
  const still = (picture: string, item: string): string =>
    ratio(num(real, ['real-perturbation', picture, 'sigma 2', item, 'amplification', 'p99']));
  const clip = (name: string, item: string): string =>
    ratio(num(real, ['real-clips', name, item, 'amplification', 'p99']));
  return {
    heading: 'The film’s two rows were two different findings',
    prose: [
      'The film amplifies at the BOTTOM of the control, where the flatten is at its widest and is supposed to be attenuating hardest, and no photograph does. So either there are two mechanisms or the one written down is not the one running, and which it is decides whether this chapter has one fix or two. Nothing was changed until it was separated.',
      'The separation is to stop using a clip. The two cuts of Tears of Steel are the only inputs here with real sensor noise in them and they are also the only ones with actors in them, so an amplification taken over consecutive frames carries a man walking in both of its columns. One frame of the film rendered twice, with grain of a known size added the second time, has no motion in it at all: it is the same picture twice, and it is the experiment the four photographs were already answering.',
      `Taken that way the two film rows separate. The exterior amplifies ${still(
        'a film, exterior',
        'comic, detail 0',
      )} as a still against ${clip(
        'Tears of Steel, exterior',
        'comic, detail 0',
      )} as a clip, so its figure is the chain and not the actors. The interior attenuates ${still(
        'a film, interior',
        'comic, detail 0',
      )} as a still against ${clip(
        'Tears of Steel, interior',
        'comic, detail 0',
      )} as a clip, so its figure is the actors and not the chain. One page had been reading them as one thing.`,
    ],
    table: {
      columns: [
        'comic, amplification p99',
        'one frame twice, detail 0',
        'a clip, detail 0',
        'one frame twice, detail 1',
        'a clip, detail 1',
      ],
      rows: REAL_STILLS.map(([label, picture, name]) => [
        label,
        still(picture, 'comic, detail 0'),
        clip(name, 'comic, detail 0'),
        still(picture, 'comic, detail 1'),
        clip(name, 'comic, detail 1'),
      ]),
    },
    caveat:
      'The two columns are two experiments and are read down a row rather than across it. A still is one picture rendered twice with grain of σ 2 added the second time, so its input is six codes of white noise; a clip is what a codec and a camera left between two frames. What a still can say that a clip cannot is whether a chain amplifies a picture at all when nothing in the picture moved, and the film’s two shots answer that differently.',
    command: 'node tools/style-bench/run.mjs real-perturbation real-clips',
  };
}

function theFlatten(real: unknown): Section {
  const p99 = (picture: string, item: string): string =>
    num(real, ['real-perturbation', picture, 'sigma 2', item, 'p99']).toFixed(0);
  return {
    heading: 'It was the downsample the derivation had stopped doing',
    prose: [
      'Detail moves three things: the flatten’s apparent scale, the ink’s apparent scale, and tau, which is how much of the local lightness the difference of Gaussians subtracts before it decides. Each was held at its detail-0 value in turn and the perturbation re-run, which is attribution by intervention rather than by scaffolding: the chain measured is the chain that ships, one quantity at a time.',
      'The sector weighting is the amplifier, and it is the amplifier at every setting rather than only at the top. Take it out, so that the eight sectors are averaged rather than chosen between, and a brick wall goes from 29 codes out of 6 to 8 and the film’s exterior from 17 to 5, at detail 1, and the wall’s detail-0 figure goes from 7 to 1. It cannot be taken out: an anisotropic Kuwahara that does not choose its sector is a blur, and the choosing is what makes this style painterly rather than smooth.',
      'A floor under the apparent scale, which is what known limits implied, is not the answer. Measured at four values it takes the wall from 29 down to 9 and takes the film’s exterior from 17 UP to 22 on the way, in the same run, because a wider ellipse spans more structure and a sector that flips then costs more codes. There is no radius that is right for both pictures, which is the honest reason the control exists.',
      'What is uniformly right is the downsample. The flatten’s buffer resolution is derived to hold its radius near eight pixels, and at detail 1 that derivation asks for 1356 pixels of a 720 pixel frame; clamping the request at the frame’s own resolution turns the box downsample in front of the Kuwahara into a copy, and the downsample is the only thing in this chain that removes grain before the decision that amplifies it. Bounding the buffer a root two below the frame restores it at every setting, moves the apparent scale by nothing, and makes the chain cheaper rather than dearer.',
    ],
    figure: {
      name: 'detail',
      caption:
        'What the detail control does now, at its two ends and its default, through the same compositor as every number here.',
    },
    table: {
      columns: ['what was changed, grain σ 2 at detail 1, p99 out of 6 in', 'facade', 'a film, exterior'],
      rows: [
        ['nothing, as it was', '29', '17'],
        ['the ink’s scale held at its detail-0 value', '26', '15'],
        ['the flatten’s scale floored at 0.0088', '20', '22'],
        ['the flatten’s scale floored at 0.0111', '13', '21'],
        ['the flatten’s scale floored at 0.0140', '10', '18'],
        ['the flatten’s scale not moved by detail at all', '9', '11'],
        ['tau held at its detail-0 value', '15', '9'],
        [
          'the flatten bounded a root two below the frame',
          p99('facade', 'comic, detail 1'),
          p99('a film, exterior', 'comic, detail 1'),
        ],
        ['the flatten bounded a factor of two below the frame', '20', '6'],
        ['no sector weighting at all', '8', '5'],
      ],
    },
    caveat:
      'Eight of the ten rows are gone from the code and cannot be regenerated without reverting it, which is the footing the outline’s tuning table on the page before this is on; the row that ships is read from the file like every other number here. Two of them were rejected on the look rather than on the number. Holding tau erases the contour around every window at detail 1, which is what the top of the control is for, and it moves 5.8% of the reference scene; bounding the flatten at a factor of two moves 9.0% of it at detail 1 and 1.2% at detail 0, where root two moves none at all, because at root two the derivation was already downsampling at the bottom of the control. What shipped moves 4.7% of the scene at detail 1 and 1.5% at the default, and detail 0 is byte for byte the render it was. The counter-metric on it is the same one a temporal method would have been judged by, read over a still: the mean gradient magnitude of the styled frame, which a bound on a flatten can only take away. It costs 6.9% of that at detail 1 and 1.0% at the default, against a quarter off the amplification on the wall and a half off it on the film.',
    command: 'node tools/style-bench/run.mjs real-perturbation',
  };
}

function realLightness(real: unknown): Section {
  const of = (picture: string, key: string): string =>
    num(real, ['real-lightness', 'pictures', picture, key]).toFixed(3);
  const palette = (name: string, key: string): string =>
    num(real, ['real-lightness', 'palettes', name, key]).toFixed(3);
  return {
    heading: 'A photograph does use less of a palette than a palette assumes',
    prose: [
      'This one survives, and it is worth saying because it was the claim most at risk. The levels pass exists because the scene occupies about half the lightness range every palette assumes, and the scene was drawn hazy. Measuring the property an input was built to have is not a measurement.',
      'Every photograph here is narrower than every palette. The closest, a portrait at 0.213 against the narrowest palette’s 0.234, still reaches only nine tenths of it; the fog, which is the case the fitting was written for, sits at 0.196 against 0.288 for the widest.',
      'The scene does overstate it. At 0.135 it is narrower than any of the four, so the fitted map moves it further than it moves a photograph. The stage earns its place on all five, by less on real pictures than the argument for it implied.',
    ],
    table: {
      columns: ['Oklab lightness', 'p1', 'p50', 'p99', 'mean', 'spread'],
      rows: [
        ...['the synthetic scene', ...REAL_PICTURES].map((picture) => [
          picture,
          of(picture, 'p1'),
          of(picture, 'p50'),
          of(picture, 'p99'),
          of(picture, 'mean'),
          of(picture, 'spread'),
        ]),
        ...['Mural', 'Noir'].map((name) => [
          `${name} palette`,
          '',
          '',
          '',
          palette(name, 'mean'),
          palette(name, 'spread'),
        ]),
      ],
    },
    caveat:
      'Read from the sRGB bytes the chain is handed, through the same transfer function the hardware applies, at 720p. The palettes’ own figures come from the product’s function rather than from a copy of the numbers, so a palette edited in the codebase moves this table.',
    command: 'node tools/style-bench/run.mjs real-lightness',
  };
}

// --- video ------------------------------------------------------------------

function decode(video: unknown): Section {
  const row = (
    label: string,
    path: readonly string[],
    format: (value: number) => string,
  ): readonly string[] => [
    label,
    format(num(video, ['decode', '1080p30-gop30', ...path])),
    format(num(video, ['decode', '1080p30-gop300', ...path])),
  ];
  return {
    heading: 'Decode is free; seeking is not',
    prose: [
      'The next frame costs 0.46 ms. A seek costs 12 ms, or 88 on the same content encoded with one keyframe instead of thirty.',
      'There is no such thing as decoding frame N. There is decoding from the keyframe at or before N and discarding what comes between, so the cost of a scrub is set by keyframe spacing and by nothing else.',
      'That is a design constraint rather than a number to optimise. A scrub that moves forward must never re-seek: one decoder is held open and fed forward, and it starts again only for a backward or a distant jump.',
    ],
    table: {
      columns: ['1080p30 H.264', '1 s keyframes', 'one keyframe'],
      rows: [
        row('walk every packet', ['demux', 'walk_all_packets_ms', 'median'], (v) => `${v.toFixed(1)} ms`),
        row('decode 300 frames', ['decode_only', 'ms'], (v) => `${v.toFixed(0)} ms`),
        row('a frame, sustained', ['decode_only', 'fps'], (v) => `${(1000 / v).toFixed(2)} ms`),
        row('seek, median', ['seek', 'ms', 'median'], (v) => `${v.toFixed(1)} ms`),
        row('seek, worst', ['seek', 'ms', 'max'], (v) => `${v.toFixed(1)} ms`),
        row('frames decoded per seek', ['seek', 'frames_decoded', 'median'], (v) => v.toFixed(0)),
      ],
    },
    command: 'node tools/video-bench/run.mjs decode',
  };
}

function upload(video: unknown): Section {
  const path = ['decode', '1080p30-gop30', 'upload'];
  return {
    heading: 'A decoded frame onto the GPU',
    prose: [
      'Three ways, fenced. The external-texture path is what playback uses; the copy is what anything that has to keep the frame uses.',
    ],
    table: {
      columns: ['1920×1080', 'median'],
      rows: [
        [
          'importExternalTexture and one pass',
          ms(num(video, [...path, 'importExternalTexture_and_pass', 'median'])),
        ],
        [
          'copyExternalImageToTexture',
          ms(num(video, [...path, 'copyExternalImageToTexture_videoframe', 'median'])),
        ],
        ['createImageBitmap, then copy', ms(num(video, [...path, 'createImageBitmap_then_copy', 'median']))],
      ],
    },
    command: 'node tools/video-bench/run.mjs decode',
  };
}

function colour(video: unknown): Section {
  const worst = (probe: string, view: string): string =>
    `${num(video, ['colour', probe, view, 'worst']).toFixed(0)} codes`;
  return {
    heading: 'A decoded frame needs no colour path of its own',
    prose: [
      'A video frame belongs in the same source texture a photograph does, sampled through the same sRGB view. Nothing downstream needed a special case, and the colour contract survived video with no shader changes at all.',
      'Both ways of being wrong here are silent, so it was measured rather than assumed: sixteen flat patches with known sRGB bytes, encoded to H.264 and brought back. What an external texture samples turns out to be sRGB-encoded, exactly like the bytes of a decoded image.',
      'Writing it through an sRGB view instead encodes it twice. The second row is what that costs, and it is the kind of mistake that is obvious in a measurement and invisible in a review.',
      'The 4:2:0 column here is the limited-range clip. Whether the full-range one needs anything of its own was left open on this page for four chapters and is answered on its own: it does not, and the flag was in the bitstream the whole time.',
      'The eleven codes in that column were attributed here to the browser for five chapters, and they are the browser converting from the transfer these clips declare, which is none. That is its own page as well, and what it changes is the attribution rather than the table: on a clip that says what it is, the upload above is the path that reads the declaration.',
    ],
    table: {
      columns: ['worst error, written through', '4:4:4 lossless', '4:2:0'],
      rows: [
        [
          'a plain rgba8unorm view',
          worst('probe-444-lossless', 'external_to_rgba8unorm'),
          worst('probe-420-tv', 'external_to_rgba8unorm'),
        ],
        [
          'an rgba8unorm-srgb view',
          worst('probe-444-lossless', 'external_to_rgba8unorm_srgb'),
          worst('probe-420-tv', 'external_to_rgba8unorm_srgb'),
        ],
        [
          'copyExternalImageToTexture',
          worst('probe-444-lossless', 'copyExternalImageToTexture'),
          worst('probe-420-tv', 'copyExternalImageToTexture'),
        ],
      ],
    },
    caveat:
      'ffmpeg round-trips all three probes at worst 1, so the eleven codes are introduced in the browser. What used to be written here is that Chrome applies a BT.709 to sRGB conversion on the NV12 path and not on the I444 one, and that nothing here could compensate for it. It converts from the transfer the file declares; these probes declare none, an unspecified transfer defaults to BT.709, and there is no I444 hardware decoder for anything to have been applied by. So the eleven codes belong to the probe, and the sentence about compensating was a claim about a browser made without asking one.',
    command: 'node tools/video-bench/run.mjs colour',
  };
}

// --- tracking ---------------------------------------------------------------

function trackedFrame(video: unknown): Section {
  const agreement = (part: string): number =>
    num(video, [
      'half-precision',
      'memory_attention',
      'fp16',
      'agreement_vs_fp32',
      'conditioned_features',
      part,
    ]);
  return {
    heading: 'Nine to eleven tracked frames a second, against thirty for playback',
    prose: [
      'A tracked frame costs about 90 ms against the 33 a playing clip has, summing the four graphs it is made of. Tracking cannot be a render-loop activity, and no amount of tidying makes it one.',
      'It runs behind the playhead instead, and the interface has to be honest that a mask arrives after the frame does. That is a product decision taken from a number, before any of it was built.',
      'Memory attention is the expensive half, and the fixed-size memory bank is why: 4096 queries against 3648 keys on every frame, where the reference attends against fewer early in a clip.',
    ],
    table: {
      columns: ['graph', 'fp32', 'fp16', 'wasm'],
      rows: [
        [
          'memory attention',
          ms(num(video, ['half-precision', 'memory_attention', 'fp32', 'run_ms', 'median'])),
          ms(num(video, ['half-precision', 'memory_attention', 'fp16', 'run_ms', 'median'])),
          ms(num(video, ['attention', 'memory_attention', 'wasm', 'run_ms_cpu_outputs', 'median'])),
        ],
        [
          'memory encoder',
          ms(num(video, ['half-precision', 'memory_encoder', 'fp32', 'run_ms', 'median'])),
          ms(num(video, ['half-precision', 'memory_encoder', 'fp16', 'run_ms', 'median'])),
          ms(num(video, ['attention', 'memory_encoder', 'wasm', 'run_ms_cpu_outputs', 'median'])),
        ],
      ],
    },
    caveat: `wasm is 30 to 50 times slower, so tracking is a WebGPU-only feature and the honest answer on a fallback is to say so rather than run it. Half precision is a good trade for attention and not for the encoder: attention's worst element moves by ${agreement(
      'max_abs_diff',
    ).toFixed(3)} on values up to ${agreement('max_abs_value').toFixed(
      2,
    )}, where the encoder's output goes into the bank and conditions every later frame.`,
    command: 'node tools/video-bench/run.mjs attention half-precision',
  };
}

function readback(video: unknown): Section {
  const cell = (size: string, part: string): string =>
    ms(num(video, ['readback', `real_encoder_${size}`, part, 'median']));
  const row = (label: string, part: string): readonly string[] => [
    label,
    cell('1920x1080', part),
    cell('4032x3024', part),
  ];
  return {
    heading: 'The 12 MB readback, which does not bind and is avoidable anyway',
    prose: [
      'Two and a half milliseconds of a 33 ms frame is 7%. The readback that looked like the binding constraint is not one.',
      'The inference runtime declines an external GPUDevice, so the model’s input tensor is built on Rotyl’s GPU and read back: 12.58 MB per frame, and a worry about 360 MB/s across the bus at 30 frames a second.',
      'On unified memory there is no bus to cross. Most of the cost is a memcpy, and an ordinary ArrayBuffer copy of the same size measures about the same.',
    ],
    table: {
      columns: ['12.58 MB tensor, per frame', '1920×1080', '4032×3024'],
      rows: [
        row('fullscreen pass and three copies', 'pass_and_copy_fenced'),
        row('map, and copy out of it', 'map_and_copy_out'),
        row('total', 'total'),
      ],
    },
    caveat:
      'For video the crossing is avoidable entirely: a VideoFrame belongs to no device, so the tensor can be built on the runtime’s own device, which does accept a GPU buffer as an input and returns the same answer bit for bit. The image path cannot do that, and by these numbers it does not need to.',
    command: 'node tools/video-bench/run.mjs readback',
  };
}

function tracksWhat(tracking: unknown): Section {
  const SCENES = ['crossing', 'occlusion', 'blur', 'lighting'] as const;
  const of = (scene: string, key: string): unknown => at(tracking, [`${scene}, with pointers`, key]);
  const iou = (scene: string, key: string): string =>
    num(tracking, [`${scene}, with pointers`, key]).toFixed(3);
  const swapped = (scene: string): string => {
    const list = of(scene, 'swapped');
    return Array.isArray(list) && list.length > 0 ? `frames ${list.join(', ')}` : 'never';
  };
  return {
    heading: 'It survives the three things the fixture did not have',
    prose: [
      'The clip these graphs were verified against was two lookalikes on converging paths, and the harness that drew it said plainly what it left out: no occlusion, no motion blur and no lighting change, which are the three things a memory bank exists for. Passing it was therefore weak evidence for the claim it was quoted for.',
      'Three more clips, each changing exactly one of those and keeping the paths and the seed. Nothing takes the wrong object on any of them. The one that costs something is motion blur, which is also the one nobody was worried about: a smeared boundary is genuinely ambiguous, and seven points of IoU is the tracker declining to guess where a smear ends rather than losing the thing.',
      'An illumination ramp of a stop and a half costs almost nothing, which is worth knowing because a memory entry encodes appearance and the obvious worry is that appearance from eight frames ago stops matching. It does not, at that size.',
    ],
    table: {
      columns: ['clip', 'worst IoU against truth', 'took the distractor'],
      rows: SCENES.map((scene) => [scene, iou(scene, 'worst_iou'), swapped(scene)]),
    },
    caveat:
      'Worst over the frames where the object is wholly visible, from a single click on frame zero and no further input. A frame showing a sliver of an object scores badly however well a tracker is doing, so the partial frames either side of the occlusion are reported separately in the results rather than folded in here. The masks are identical to the PyTorch reference on every frame of every clip, which is the other half of what this run checks.',
    command: 'python tools/edgetam-export/verify.py --sweep',
  };
}

function pointers(tracking: unknown): Section {
  /**
   * How late it was back, and "never" is a real answer.
   *
   * The harness reports null when the object was never picked up again, which
   * is a possible outcome now the occlusion outlasts the memory bank and is the
   * one worth being able to print. Reading it through `num` would fail the
   * build on the most interesting result this table can produce.
   */
  const delay = (which: string): string => {
    const value = at(tracking, [`occlusion, ${which}`, 'reacquisition_delay']);
    if (value === null) return 'never';
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`research: reacquisition_delay for ${which} is ${JSON.stringify(value)}`);
    }
    return value.toFixed(0);
  };
  const worst = (scene: string, which: string): string =>
    num(tracking, [`${scene}, ${which}`, 'worst_iou']).toFixed(3);
  return {
    heading: 'Object pointers buy back the frames it matters most to have',
    prose: [
      'The published mask decoder does not expose `object_pointer`, the token that carries an object’s identity between frames, so an implementation either re-exports the decoder or goes without. Measured on the old fixture, going without cost nothing, and that result was published with a warning attached to it: pointers exist for re-identification after occlusion, and the fixture had none. It has one now, the decoder has been re-exported, and both halves of that warning turned out to be right.',
      'With an occlusion in the clip the cost appears, and it is exactly where the warning said it would be. It is not a swap and it is not drift: without pointers the tracker produces no mask at all on the frame the object comes back on, and finds it again some frames later. The occlusion is eight frames long, which is more than the seven a memory bank holds, so by the time the object returns nothing in that bank has ever seen it and re-identification is the only thing that could work.',
      'Every average hides that. The worst IoU over whole frames is a shade better without pointers on every clip, because a run that skips the hardest frame is not scored on it. What lengthening the occlusion from three hidden frames to eight adds is that both numbers grew and the gap between them did not: pointers buy back one frame either way, and the frame the object first shows again is a five per cent sliver that nothing segments well. Coming back late from a re-entry is a small thing on a fixture and a visible thing on a clip somebody exports, and it is the reason to re-export the decoder rather than a reason not to.',
    ],
    table: {
      columns: ['', 'with pointers', 'without'],
      rows: [
        ['frames late returning from an occlusion', delay('with pointers'), delay('no pointers')],
        ['worst IoU, occlusion', worst('occlusion', 'with pointers'), worst('occlusion', 'no pointers')],
        ['worst IoU, crossing', worst('crossing', 'with pointers'), worst('crossing', 'no pointers')],
        ['worst IoU, motion blur', worst('blur', 'with pointers'), worst('blur', 'no pointers')],
      ],
    },
    caveat:
      'One occlusion on one synthetic clip, now long enough to outlast the bank rather than merely to interrupt it. What it still does not say is how the cost grows with the number of objects, which is the other half of what pointers are for.',
    command: 'python tools/edgetam-export/verify.py --sweep',
  };
}

// --- what a tracked frame costs, now that there is one -----------------------

const TRACKED_CLIPS = ['720p30-gop30', '1080p30-gop30'] as const;

/**
 * One run out of the list, by clip and by how many objects it followed.
 *
 * A list rather than a keyed object because the harness reports what it ran
 * rather than what somebody expected it to run, and finding a row by its two
 * fields is what makes an added configuration cost nothing here.
 */
function trackedRun(tracked: unknown, clip: string, objects: number): unknown {
  const runs = at(tracked, ['tracked-frame', 'runs']);
  if (!Array.isArray(runs)) throw new Error('research: tracked-frame has no runs');
  const found = runs.find(
    (run: unknown) =>
      typeof run === 'object' &&
      run !== null &&
      Object.getOwnPropertyDescriptor(run, 'clip')?.value === clip &&
      Object.getOwnPropertyDescriptor(run, 'objects')?.value === objects,
  );
  if (found === undefined) {
    throw new Error(`research: no tracked-frame run for ${clip} with ${String(objects)} objects`);
  }
  return found;
}

const trackedMs = (tracked: unknown, clip: string, objects: number): number =>
  num(trackedRun(tracked, clip, objects), ['frame_ms', 'median']);

function trackedCost(tracked: unknown): Section {
  const cell =
    (objects: number): ((clip: string) => string) =>
    (clip) =>
      ms(trackedMs(tracked, clip, objects));
  const derived = (clip: string): number => trackedMs(tracked, clip, 2) - trackedMs(tracked, clip, 1);
  const perSecond = Math.round(1000 / trackedMs(tracked, TRACKED_CLIPS[0], 1));
  return {
    heading: `${String(perSecond)} tracked frames a second, where the sum said nine to eleven`,
    prose: [
      'The figure this project designed tracking around was summed from four graphs measured separately, and published saying plainly that nothing had been run end to end because there was nothing to run. There is now, so this drives the product’s own code: the two engines it loads, the scene it walks, the loop it runs, writing into a real command log.',
      'The conclusion survives and gets firmer. Playback is thirty frames a second and this is seven, so tracking is a job, the playhead is free to ignore it, and no amount of tidying makes it a render-loop activity.',
      'Frame size does not enter into it, exactly as predicted: the vision encoder always works at 1024 square, and 720p and 1080p differ by two tenths of a millisecond.',
      'The two-object row was a property of the loop when this was taken and is a thing the product does now. A selection made of two model answers is two objects to follow, which the command log has recorded since object selection landed, so the second row is what somebody who clicked two things waits for rather than a capability nothing could reach. What it costs is the row: not another frame, one more advance.',
    ],
    table: {
      columns: ['a tracked frame', '720p', '1080p'],
      rows: [
        ['one object', ...TRACKED_CLIPS.map(cell(1))],
        ['two objects', ...TRACKED_CLIPS.map(cell(2))],
        ['a second object, by difference', ...TRACKED_CLIPS.map((clip) => ms(derived(clip)))],
        [
          'reading the frame, by difference',
          ...TRACKED_CLIPS.map((clip) => ms(trackedMs(tracked, clip, 1) - derived(clip))),
        ],
      ],
    },
    caveat:
      'The split is derived rather than timed, and that is not fussiness. A run has two seams and a stopwatch on each of them does not add up to a frame: the segmentation engine asks for gpu-buffer outputs, so its run returns before the GPU has finished and reading a frame measures seven milliseconds, with the rest landing in whatever asks for those outputs next. A second tracked object is exactly one more advance and not one more read, so the difference between one object and two is an advance and what is left over is the read. Both are fenced by construction.',
    command: 'node tools/video-bench/run.mjs tracked-frame',
  };
}

function trackedArithmetic(tracked: unknown): Section {
  const each = (name: string): number => num(tracked, ['tracked-frame', 'arithmetic', name, 'median']);
  const row = (label: string, name: string, times: number): readonly string[] => [
    label,
    ms(each(name)),
    `×${String(times)}`,
  ];
  const perObject =
    each('to_channel_major') * 2 +
    each('to_token_major') +
    each('at_memory_resolution') +
    each('mask_for_memory');
  return {
    heading: 'The missing forty-five milliseconds are not in a graph',
    prose: [
      'Five passes over a million elements of JavaScript run per tracked object, and not one of them is a model, which is exactly why none of them was in the sum. With the three graphs an advance is 38 plus 19 plus 13, which is 70; plus these and a four-megabyte readback of the conditioned map it is 91, to within the noise.',
      'So the sum was not wrong about the graphs. It was a sum of graphs, in a frame that is a third something else. That is the general shape of the finding rather than a detail of this one: a cost model built out of the expensive parts is a lower bound, and the arithmetic between them is where the rest lives.',
      '`toChannelMajor` runs twice because attention answers token-major and both the memory encoder and the mask decoder want the other way round. One of the two is avoidable, since the memory encoder’s input is the vision encoder’s own layout with one constant subtracted, and it is being rebuilt from a transpose of itself. It is four per cent of a frame, so it is written down rather than done.',
    ],
    table: {
      columns: ['the arithmetic between the graphs', 'per call', 'a frame'],
      rows: [
        row('toChannelMajor', 'to_channel_major', 2),
        row('toTokenMajor', 'to_token_major', 1),
        row('atMemoryResolution', 'at_memory_resolution', 1),
        row('maskForMemory', 'mask_for_memory', 1),
        ['all of it, per tracked object', ms(perObject), ''],
      ],
    },
    caveat: `The vision position encoding is ${ms(
      each('vision_position_encoding'),
    )} and runs once a session rather than once a frame, which is the whole of what computing four megabytes costs against shipping them: a third of the shared attention graph's entire download, for five milliseconds, once.`,
    command: 'node tools/video-bench/run.mjs tracked-frame',
  };
}

// --- the host, against the reference ----------------------------------------

const SCENES_MEASURED = ['crossing', 'occlusion', 'blur', 'lighting'] as const;

/**
 * The worst a stage was over the four clips.
 *
 * Worst rather than mean, and over every clip rather than the one the export
 * was verified against, because what these say is "this piece of arithmetic
 * agrees with the reference", and one clip where it does not is the whole
 * finding.
 */
function worstStage(host: unknown, stage: string): number {
  return Math.max(...SCENES_MEASURED.map((scene) => num(host, [scene, 'stages', stage])));
}

/** A difference measured as an absolute error, at the scale it lives on. */
const absoluteError = (value: number): string => (value === 0 ? 'exact' : value.toExponential(1));

function hostArithmetic(host: unknown): Section {
  const row = (label: string, stage: string): readonly string[] => [
    label,
    absoluteError(worstStage(host, stage)),
  ];
  return {
    heading: 'The tracker is the reference, and three of the pieces were not',
    prose: [
      'Two graphs of a tracked frame were exported here and verified against the modules they came from. The other half of a tracked frame is not in any graph: it is two published graphs either side of them, four transposes between four sessions, the layout of the memory bank and the arithmetic the memory encoder is fed. All of it is host code, and every one of those fails by producing a plausible mask of roughly the right object rather than by producing an error.',
      'So each piece is run against the reference’s own inputs and its answer compared with the reference’s own. Teacher-forced on purpose: a free-running tracker diverges a little on every frame, and then every later stage is being compared against a slightly different frame, which turns several sharp answers into one blurred one.',
      'Three of them were wrong when this was taken, and two of the three are in the table below this one. The bank was the third, and it is the one that is now exact: laid out from the entries the memory encoder produced, it reproduces the reference’s own bank to the bit, all 233,472 floats of it, on every frame of every clip.',
    ],
    table: {
      columns: ['what the host computes', 'worst against the reference'],
      rows: [
        row(
          'the frame’s features, token-major, no-memory embedding off',
          "the frame's features, token-major, no-memory off",
        ),
        row('the vision position encoding, computed rather than served', 'vision position encoding'),
        row('the memory bank', "the bank, laid out against the reference's own"),
        row(
          'the bank’s positions, with the temporal row added',
          "the bank's positions, with the temporal row on",
        ),
        row('the conditioned features, off that bank', 'the conditioned features, off a laid-out bank'),
        row('the mask a memory is encoded from', 'the mask a memory is encoded from'),
        row('the mask decoder, given one point labelled -1', 'the published decoder, one point labelled -1'),
      ],
    },
    caveat:
      'Everything above the mask decoder is a graph’s own numerical error rather than the arithmetic’s: the published vision encoder and the reference agree to about 2e-5 on features whose values run to 2.5, and the two exact rows are exact because a permutation of floats either is or is not the same permutation.',
    command: 'python tools/edgetam-export/host.py --sweep',
  };
}

function hostMistakes(host: unknown): Section {
  const row = (label: string, stage: string): readonly string[] => [
    label,
    absoluteError(worstStage(host, stage)),
  ];
  return {
    heading: 'The two that answered, answered plausibly, and answered wrongly',
    prose: [
      'The mask decoder accepts empty `input_points` and empty `input_boxes` together. It was never sent them, because the object-selection path returns early when a prompt has neither, so the tracked-frame path was unexercised. It turns out to run, and to give a different answer from the reference’s.',
      'The reason is one line in the reference: a prompt made of points is padded with a trailing "not a point" token, and the published graph was traced with that padding baked in. So a graph handed zero points appends one and produces ONE such token where the reference has two. What a tracked frame has to send is one point with a label of -1, whose coordinates are then discarded and whose embedding is replaced wholesale. With that, the published decoder is the reference’s decoder to 1e-4.',
      'The second was the mask on its way into the memory encoder, which is 256 px from the decoder and 1024 px in the graph. This resampled it nearest, on the reasoning that the reference upsamples a high-resolution mask it already holds while a host reconstructs a decision. The reference holds no such mask: `pred_masks_high_res` is a bilinear interpolation of exactly these logits and nothing else.',
    ],
    table: {
      columns: ['the same stage, done the way it was written first', 'worst against the reference'],
      rows: [
        row('the mask decoder, given no prompt tensors at all', 'the same, with no prompt tensors at all'),
        row(
          'the mask resampled nearest rather than bilinear',
          'the same, resampled nearest instead of bilinear',
        ),
      ],
    },
    caveat:
      'The second number is on a field the memory encoder receives in the range −10 to 10, so being out by twenty is being out by the whole of it, along every edge of every mask. Neither of these produces an error, a warning or an obviously wrong picture, which is the reason this page exists rather than a screenshot.',
    command: 'python tools/edgetam-export/host.py --sweep',
  };
}

function hostEndToEnd(host: unknown): Section {
  const cell = (which: string, name: string): string =>
    num(host, [name, 'differences', which, 'worst_agreement']).toFixed(4);
  const row = (label: string, which: string): readonly string[] => [
    label,
    ...SCENES_MEASURED.map((scene) => cell(which, scene)),
  ];
  const absent = (which: string): number => {
    const frames = at(host, ['occlusion', 'differences', which, 'absent']);
    if (!Array.isArray(frames)) throw new Error(`research: no absent list for ${which}`);
    return frames.length;
  };
  return {
    heading: 'What it takes for a clip to price any of this',
    prose: [
      'The obvious way to judge the corrections above is to run the whole tracker with and without each of them and see which masks are better. For a long time that said nothing: every configuration, including three known-wrong ones, landed between 0.91 and 0.99 against the reference with an ordering that was not consistent between clips. That was the clips rather than the corrections, and the fixtures were rebuilt around it.',
      `The largest row is the object pointer, which is what the re-exported mask decoder exists for. Without it the tracker reports the object absent from ${absent(
        'no object pointers',
      ).toFixed(
        0,
      )} frames of the occlusion clip, which is hidden for eight: it comes back two frames late and draws nothing at all until it does. With it, ${absent(
        'as it is built',
      ).toFixed(
        0,
      )}, which is exactly the frames the object is behind the bar for. On the three clips with no occlusion it is worth between six and thirteen points of agreement instead.`,
      'An anchored memory bank is insurance against the recent frames being WRONG, so pricing it needs a clip carrying a moment where the tracker could plausibly go wrong. Length alone does not supply one: a version of the control that merely converged and stayed close moved the sliding bank by nothing at all over twenty-two frames of divergence. Crossing head-on and pulling apart afterwards does supply one, and so does hiding the object for longer than the bank remembers.',
    ],
    table: {
      columns: ['worst-frame agreement with the reference', ...SCENES_MEASURED],
      rows: [
        row('as it is built', 'as it is built'),
        row('with no object pointers', 'no object pointers'),
        row('with a sliding bank', 'a sliding bank, no anchor'),
        row('resampling nearest', 'nearest, not bilinear'),
        row('with a full-precision decoder', 'a full-precision decoder'),
        row('seeded with raw logits rather than coverage', 'the seed as raw logits'),
      ],
    },
    caveat:
      'THE OCCLUSION COLUMN NEEDS READING CAREFULLY, and a zero in it is not a failure. Agreement is worst-frame, and on the frame the object reappears the model’s own score sits within a tenth of a per cent of zero, so what a run scores there is which side of a coin flip it landed on. The reference lands late; this tracker at half precision lands on time, and is scored zero for disagreeing with it. Running the same graph at full precision agrees with the reference and comes back a frame later, which is the whole of what that row shows: not that one precision is better, but that neither earns the frame. The three clips without an occlusion have no such frame and their columns read straight.',
    command: 'python tools/edgetam-export/host.py --sweep',
  };
}

function download(video: unknown, shrink: unknown): Section {
  const mb = (variant: string): string =>
    `${num(video, ['half-precision', 'memory_attention', variant, 'model_mb']).toFixed(1)} MB`;
  const perFrame = (variant: string): string =>
    `${num(video, ['half-precision', 'memory_attention', variant, 'run_ms', 'median']).toFixed(1)} ms`;
  const duplicated = num(shrink, ['memory_attention', 'duplicated_bytes']) / 1e6;
  const copies = num(shrink, ['memory_attention', 'removed']);
  const hoisted = num(shrink, ['memory_attention', 'hoisted_constants']);
  return {
    heading: 'The download is not halved, it is quartered',
    prose: [
      'The expensive graph exports at 69.6 MB and holds 11.8 MB of weights. Everything else is rotary tables, which the tracer captures once per layer and once per attention block because the module that produces them takes no inputs and can therefore be traced away. Turning constant folding off does not help: they are not folded, they are traced.',
      `Where they sit is the reason the obvious pass finds nothing. They are not initializers. They are ${hoisted.toFixed(
        0,
      )} Constant NODES, each carrying its own copy in an attribute, so a sweep over the graph's initializers reports no duplication at all. Hoisting them into initializers first, then sharing the ones whose bytes match, removes ${copies.toFixed(
        0,
      )} copies and ${duplicated.toFixed(1)} MB.`,
      'It costs nothing on either axis, which had to be checked rather than assumed: a tensor read from six places could plausibly be allocated differently by a WebGPU backend. The outputs are identical to the bit and the median run time moves by less than the run-to-run spread.',
      'So tracking’s marginal download is the shared half-precision attention graph at 12 MB plus the encoder at 6.7, which stays at full precision for the reason above. Nineteen megabytes on top of the twenty already fetched for object selection, against seventy-six.',
    ],
    table: {
      columns: ['memory attention', 'size', 'a frame', 'against fp32'],
      rows: [
        ['as exported', mb('fp32'), perFrame('fp32'), ''],
        ['half precision', mb('fp16'), perFrame('fp16'), '0.074 on values up to 2.53'],
        ['tables shared', mb('shared'), perFrame('shared'), 'identical'],
        ['both', mb('shared fp16'), perFrame('shared fp16'), '0.074, as fp16'],
      ],
    },
    caveat:
      'The memory encoder has no duplication worth removing, 6.7 MB before and after, and half precision is not a safe conversion for it: its worst output element moves by half the signal and that output conditions every later frame. So it ships whole, and it is the smaller of the two anyway.',
    command: 'python tools/edgetam-export/shrink.py --verify --fp16',
  };
}

function commandLog(video: unknown): Section {
  const fold = (frames: string): string =>
    `${num(video, ['log', 'fold', `${frames} frames`, 'at_the_end', 'median']).toFixed(1)} ms`;
  const megabytes = (frames: string): string =>
    `${num(video, ['log', 'fold', `${frames} frames`, 'raw_megabytes']).toFixed(0)} MB`;
  const packed = (frames: string): string =>
    `${num(video, ['log', 'fold', `${frames} frames`, 'packed_megabytes']).toFixed(0)} MB`;
  const size = (mask: string): string =>
    `${(num(video, ['log', 'compression', mask, 'packed_bytes']) / 1024).toFixed(1)} KB`;
  const ratio = (mask: string): string =>
    `${num(video, ['log', 'compression', mask, 'ratio']).toFixed(0)} times`;
  const unpacking = (mask: string): string =>
    `${num(video, ['log', 'compression', mask, 'unpacking_300_ms', 'median']).toFixed(1)} ms`;
  const sparse = (frames: string): string =>
    `${num(video, ['log', 'one_in_thirty', `${frames} frames`, 'packed_megabytes']).toFixed(1)} MB`;
  return {
    heading: 'A tracked clip belongs in the command log, and the mask had to change shape to fit',
    prose: [
      'Tracking contributes one applyMask command per frame it has followed the object to, which is the mechanism the document already has and needs no new command type. Whether that scales is a different question from whether it fits, and the log is what makes undo and device-loss recovery cheap enough to be free.',
      `The objection that looked most likely turns out not to be one. Folding a frame's commands filters and sorts the whole log, which is nothing at ten commands and could have been a per-frame cost at ten thousand. It is not: ${fold(
        '18000',
      )} for a ten-minute clip with a mask on every frame, against a 33 ms frame.`,
      `What did not fit is the bytes. A mask at the engine's own 256 px square is 64 KB held plainly, so ten seconds was ${megabytes(
        '300',
      )} and ten minutes ${megabytes(
        '18000',
      )}, which is the same wall a clip export already meets arriving sooner. Coverage is nearly binary and packs like it: ${size(
        'roughness 0.5',
      )} for a mask this shape, ${ratio(
        'roughness 0.5',
      )} smaller, and the ragged end of the sweep is barely worse because the cost is the perimeter rather than the area. Ten minutes is ${packed(
        '18000',
      )}.`,
      `What the packing does not pay for by itself is the replay. Unpacking is cheap once and is not once: a rebuild of the mask walks every command the frame folded to, and ${unpacking(
        'roughness 0.5',
      )} of a 33 ms frame goes on three hundred masks before any of them reaches the GPU. So the fold cuts at the last command that decides the frame by itself, which a run of replaces makes the last one. Three hundred commands become one, and so does eighteen thousand.`,
      'Per object, which every figure on this page is and none of them said until a run could follow more than one thing. A run replaces for its FIRST seed and adds for the rest, so the cut lands on the first one and a frame folds to one command per object rather than to one. What each of these figures comes back as at one, two and three objects is the page on the four figures that were about one object, in a file of its own so that asking did not re-take this one.',
    ],
    table: {
      columns: ['a mask on every frame', 'held plainly', 'packed', 'folding one frame'],
      rows: [
        ['10 seconds', megabytes('300'), packed('300'), fold('300')],
        ['100 seconds', megabytes('3000'), packed('3000'), fold('3000')],
        ['10 minutes', megabytes('18000'), packed('18000'), fold('18000')],
      ],
    },
    caveat: `A wide boundary is what costs the packing, not a ragged one, because the engine maps its decision boundary across the whole range and an answer it is unsure about never leaves the ramp: ${ratio(
      'a boundary 6 texels wide',
    )} on one six texels across against ${ratio(
      'roughness 0.5',
    )} on a crisp one. The cheap alternative to all of it was one command a second rather than one a frame, letting the hold-forward rule cover the gap, which is ${sparse(
      '18000',
    )} for ten minutes. It is the wrong trade and worth stating as one: the gap it leaves holding is exactly the drift tracking exists to remove, so it buys memory back from the feature rather than from its representation.`,
    command: 'node tools/video-bench/run.mjs log',
  };
}

// --- the document -----------------------------------------------------------

/** Sub-millisecond figures read as zero, which is a timer rather than a finding. */
const quick = (value: number): string => (value < 0.05 ? 'under 0.1 ms' : ms(value));

const megabytes = (bytes: number): string =>
  bytes < 1e6 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1e6).toFixed(2)} MB`;

const CASES = [
  ['one stroke on a photograph', 'one stroke'],
  ['a three hundred frame tracked run', 'a tracked run'],
  ['ten minutes of tracking', 'ten minutes'],
] as const;

function documentCost(document: unknown): Section {
  const of = (key: string, path: readonly string[]): number => num(document, ['document', key, ...path]);
  const held = num(document, ['document', 'ten minutes', 'held_megabytes']);
  return {
    heading: 'A ten-minute tracked run is a 65 MB file that writes in eleven milliseconds',
    prose: [
      'What a brush stroke costs to write down is nothing and everybody knows it. What decides whether saving is a file format or a paragraph in known limits is what a TRACKED RUN costs: one command per frame PER OBJECT, a mask on each, packed, which the chapter before this one measured at 3.4 KB a mask and 62 MB for ten minutes of following one thing. Every figure on this page is per object for that reason, and none of them said so until the interface could reach a second seed; what they come back as at several is the page on the four figures that were about one object.',
      `Those 62 MB survive the trip. The file is ${megabytes(
        of('ten minutes', ['container', 'bytes']),
      )} against ${held.toFixed(
        1,
      )} MB held, and the difference is the header rather than the masks: they are the log's own arrays handed to the writer, so a save touches every byte once and copies none of them.`,
      'None of the three sizes is slow enough to need an indicator, which is the finding that made everything after it simple. A document can be an ordinary thing somebody presses rather than an operation with a progress bar on it.',
    ],
    table: {
      columns: [
        'a saved selection',
        'commands',
        'the file',
        'building it',
        'assembling the bytes',
        'reading it back',
      ],
      rows: CASES.map(([label, key]) => [
        label,
        of(key, ['commands']).toLocaleString('en-GB'),
        megabytes(of(key, ['container', 'bytes'])),
        quick(of(key, ['container', 'encode_ms', 'median'])),
        quick(of(key, ['container', 'through_a_blob_ms', 'median'])),
        quick(of(key, ['container', 'read_ms', 'median'])),
      ]),
    },
    caveat:
      '"Building it" is the header and the chunk list. "Assembling the bytes" is the one pass over every one of them, measured through a real Blob, which is what a browser with nowhere to write the file does; given a file handle the chunks go straight into the stream and that column is the disk rather than the heap. "Reading it back" is the whole file returned as a command log, with the header parsed and every mask handed back as a view into the buffer it was read into rather than copied out of it.',
    command: 'node tools/video-bench/run.mjs document',
  };
}

function documentShape(document: unknown): Section {
  const of = (key: string, path: readonly string[]): number => num(document, ['document', key, ...path]);
  const larger = of('ten minutes', ['json_base64', 'larger_by']);
  const slower =
    of('ten minutes', ['json_base64', 'write_ms', 'median']) /
    of('ten minutes', ['container', 'encode_ms', 'median']);
  return {
    heading: 'JSON with the masks base64 encoded is a third larger and a hundred times slower',
    prose: [
      'The obvious shape for a document is the one the command log already nearly is: JSON, with each packed mask turned into text. It needs no format and no reader, and the argument against it was arithmetic, which is the half that does not decide anything on its own. Base64 is four bytes for every three before anything else happens.',
      `It is that, and it is also ${slower.toFixed(0)} times slower to write and ${(
        of('ten minutes', ['json_base64', 'read_ms', 'median']) /
        of('ten minutes', ['container', 'read_ms', 'median'])
      ).toFixed(
        0,
      )} times slower to read, because every mask has to be built into a string on the way out and taken apart on the way back. A second of work to press Save is a different product from eleven milliseconds.`,
      'So the header is JSON and the payload is not, which is the shape every honest container has. Everything small enough to read in a text editor stays legible, and the one thing that is neither goes in a region the header points into. It needs no library, which a document format in a 46 KB application has to be able to say.',
    ],
    table: {
      columns: ['ten minutes of tracking', 'the file', 'writing', 'reading'],
      rows: [
        [
          'a container, masks as bytes',
          megabytes(of('ten minutes', ['container', 'bytes'])),
          ms(of('ten minutes', ['container', 'encode_ms', 'median'])),
          ms(of('ten minutes', ['container', 'read_ms', 'median'])),
        ],
        [
          'JSON, masks base64 encoded',
          megabytes(of('ten minutes', ['json_base64', 'bytes'])),
          ms(of('ten minutes', ['json_base64', 'write_ms', 'median'])),
          ms(of('ten minutes', ['json_base64', 'read_ms', 'median'])),
        ],
      ],
    },
    caveat: `A third larger is ${((larger - 1) * 100).toFixed(
      1,
    )}% here rather than the 33% base64 costs by itself, because the header is the same in both and the JSON one is marginally the smaller of the two on a photograph, where there are no masks at all and a container still pays twelve bytes of prefix. The comparison is written out in tools/video-bench/document.ts rather than shipped, which is the rule the sink that used to hold a whole clip follows: the thing being compared against has to exist next to the measurement that rejected it.`,
    command: 'node tools/video-bench/run.mjs document',
  };
}

function documentReplay(document: unknown): Section {
  const of = (key: string, path: readonly string[]): number => num(document, ['document', key, ...path]);
  return {
    heading: 'Opening one is a fold and one upload, so the file can be dumb',
    prose: [
      'This is the measurement that decided the shape of the file rather than its encoding. A document that could be read quickly and then took a second to become a picture would have to carry something a replay cannot recompute, which is a cached mask, which is a second source of truth in the one structure this architecture exists to have exactly one of.',
      `It does not. Folding a ten-minute log to the frame it was saved on cuts at the last command that decides that frame by itself, so eighteen thousand commands fold to ${of(
        'ten minutes',
        ['replay', 'folded_to'],
      ).toFixed(0)}, and unpacking that one mask and the fold together are ${ms(
        of('ten minutes', ['replay', 'ms', 'median']),
      )}. Everything after it is the texture upload the renderer does on every frame anyway.`,
      'One per object, which is the one line on this page that following more than one thing did not merely re-scale. The cut lands on a run’s FIRST seed, because that is the one that replaces and the rest add, so a frame folds to one command per object and a replay unpacks that many masks. It is still a fraction of a frame and the file is still allowed to be dumb, and the arithmetic is on the page about the four figures that were about one object.',
      'So the document carries the log and nothing derived from it. No mask, no thumbnail, no rendered anything: replaying is cheaper than reading whatever a cache of it would have been.',
    ],
    table: {
      columns: ['after loading', 'commands', 'folded to', 'fold and unpack'],
      rows: CASES.map(([label, key]) => [
        label,
        of(key, ['commands']).toLocaleString('en-GB'),
        of(key, ['replay', 'folded_to']).toFixed(0),
        quick(of(key, ['replay', 'ms', 'median'])),
      ]),
    },
    caveat:
      'The fold is the product’s own commandsForFrame over the log that came back out of the file, not over the one that went in. A reader that produced commands in a different order, or lost the frame numbers, would fold to something else and would be caught here rather than on a screen.',
    command: 'node tools/video-bench/run.mjs document',
  };
}

function documentIdentity(document: unknown): Section {
  const whole = (size: string, path: readonly string[]): number =>
    num(document, ['document', 'identity', 'the_whole_file', size, ...path]);
  const probe = (size: string): number =>
    num(document, ['document', 'identity', 'the_first_and_last_megabyte', size, 'ms', 'median']);
  const rate = whole('1024 MB', ['megabytes_per_second']);
  return {
    heading: 'The whole file cannot be digested here, and does not need to be',
    prose: [
      'A browser has no paths. A document names media it cannot address, so somebody supplies the file again, and the only question left is whether it is the same file: a selection replayed over the wrong clip is a wrong answer that looks like a right one. A name and a byte length are cheap and weak. A digest of the whole file is strong.',
      `And a digest of the whole file is not available here, which is a fact about the platform rather than a budget. crypto.subtle.digest takes a BufferSource and there is no streaming form of it, so digesting two gigabytes means holding two gigabytes at once, which is the exact thing a clip export was rebuilt to stop doing. Where it fits it runs at ${rate.toFixed(
        0,
      )} MB a second, so a two gigabyte clip would be a second of work on top of two gigabytes of heap.`,
      `A digest of the first megabyte, the last megabyte and the length costs ${ms(
        probe('1024 MB'),
      )} whatever the file is, and the shape of the media is free because the loader already read it. What a bounded probe cannot see is a file that agrees at both ends and in length and differs in the middle, which on media is a re-encode with the same container layout and the same byte count. That is in known limits rather than left implied.`,
    ],
    table: {
      columns: ['identifying the media', '2 MB', '64 MB', '1 GB'],
      rows: [
        [
          'the whole file',
          ms(whole('1 MB', ['ms', 'median']) * 2),
          ms(whole('64 MB', ['ms', 'median'])),
          ms(whole('1024 MB', ['ms', 'median'])),
        ],
        ['the first and last megabyte', ms(probe('2 MB')), ms(probe('64 MB')), ms(probe('1024 MB'))],
      ],
    },
    caveat: `The first row is measured on 1, 16, 64, 256 and 1024 MB and is linear across all of them at ${whole(
      '64 MB',
      ['megabytes_per_second'],
    ).toFixed(0)} to ${whole('1 MB', ['megabytes_per_second']).toFixed(
      0,
    )} MB a second, so the 2 MB cell is the 1 MB figure doubled rather than a rung of its own. Below two megabytes the two slices of the second row meet and the whole file is digested anyway, which is the strong answer arriving free on the files small enough to give it away. What the comparison then decides is what happens on a mismatch, and that is two answers rather than one: a file of a different shape cannot replay the log at all and is refused, and a file of the same shape and different bytes replays perfectly and opens with a sentence beside its name.`,
    command: 'node tools/video-bench/run.mjs document',
  };
}

// --- crash recovery ---------------------------------------------------------

function whereAJournalCanBeWritten(saved: unknown): Section {
  const opening = (held: string): string =>
    ms(num(saved, ['recovery', 'opening_a_writable', `${held} MB already in it`, 'ms', 'median']));
  return {
    heading: 'The API a page can reach copies the file to open it',
    prose: [
      'Saving is a thing somebody presses, so a crash costs whatever has happened since they last pressed it, which on a tracked run is three quarters of a minute per press they did not make. Writing the log down as it happens is the obvious answer, and whether it is affordable is a question about one API rather than about the log.',
      'A browser with no save dialog still has the origin private file system, and there are two ways to write into it. createWritable is the one a page can reach, and it is not an append: opening a stream on a file copies what is already in it, so the cost of adding three and a half kilobytes to a journal is the cost of the journal.',
      `The other is createSyncAccessHandle, and asked of the browser rather than remembered, ${text(saved, [
        'recovery',
        'sync_access_handle_on_the_main_thread',
      ])}. So a journal either lives in a Web Worker or does not use it, and this project had never had one.`,
    ],
    table: {
      columns: ['opening a writable stream', '0 MB', '1 MB', '16 MB', '64 MB'],
      rows: [['already in the file', opening('0'), opening('1'), opening('16'), opening('64')]],
    },
    caveat:
      'Linear at about 1.8 ms per megabyte already there, which is a copy rather than a cost model anybody would design around. It is the right API for the thing it is for, which is writing a file once: a clip export opens one stream and writes a gigabyte through it. A journal opens one per edit.',
    command: 'node tools/video-bench/run.mjs recovery',
  };
}

function whatAnEditCosts(saved: unknown): Section {
  const of = (label: string, path: readonly string[]): number =>
    num(saved, ['recovery', 'appending_one_record', label, ...path]);
  const writable = (label: string): string => ms(of(label, ['through_create_writable_ms', 'median']));
  const worker = (label: string): string => `${of(label, ['inside_the_worker_per_append_ms']).toFixed(2)} ms`;
  return {
    heading: 'In a worker it is flat, and the main thread pays nothing at all',
    prose: [
      'The same record, appended the two ways, onto journals that already hold nothing, a three hundred frame run, and ten minutes of tracking. One of the rows depends on how much is already there and the other does not.',
      `Ninety eight milliseconds per edit is not a journal, it is a stutter with a file underneath it. ${worker(
        'ten minutes already in it',
      )} is, and it is the same figure on an empty file, so the length of the session stops being a variable.`,
      'And the interface pays none of it. The record is framed on the main thread and handed over, which measures below the clock’s own resolution at every size, because the write happens somewhere else. Nothing appears while it runs: no indicator, no line, because there is nothing to say about that.',
    ],
    table: {
      columns: ['appending one record', 'an empty journal', 'a 300-frame run in it', 'ten minutes in it'],
      rows: [
        [
          'through createWritable',
          writable('an empty journal'),
          writable('a 300-frame run already in it'),
          writable('ten minutes already in it'),
        ],
        [
          'in a worker, flushed each time',
          worker('an empty journal'),
          worker('a 300-frame run already in it'),
          worker('ten minutes already in it'),
        ],
      ],
    },
    caveat: `The record is ${(num(saved, ['recovery', 'a_journal_record_bytes']) / 1024).toFixed(
      1,
    )} KB, which is one tracked frame's mask packed plus the command around it. Flushing after every write costs nothing at all: on a 64 MB journal the two are identical, ${of(
      'ten minutes already in it',
      ['without_flushing_per_append_ms'],
    ).toFixed(3)} ms against ${of('ten minutes already in it', ['inside_the_worker_per_append_ms']).toFixed(
      3,
    )}, so the journal is durable per record rather than when the browser feels like it. The worker figures are timed as batches of two thousand and divided, because performance.now() is coarsened to a tenth of a millisecond there and a per-write median would be a measurement of the clock.`,
    command: 'node tools/video-bench/run.mjs recovery',
  };
}

function whyNotTheDocument(saved: unknown): Section {
  const rewrite = (label: string): string =>
    ms(num(saved, ['recovery', 'rewriting_the_whole_document', label, 'ms', 'median']));
  const written = (label: string): string =>
    megabytes(num(saved, ['recovery', 'rewriting_the_whole_document', label, 'bytes']));
  return {
    heading: 'And the format that needs no second format is 2.5 seconds an edit',
    prose: [
      'There is already a way to write the log to a file, and it needs nothing new: the document a save produces. Writing that on every edit means no journal format, no records, no reader, and one shape for both. It is also the one thing here that gets worse the longer somebody works.',
      'A document is one JSON header with the masks in a region behind it, so the header is at the front and grows with the log. Written once that is the right shape and 11 ms. Written per edit it is quadratic, and it crosses from unnoticeable to unusable somewhere between a stroke and a tracked run.',
      'So there are two shapes of the same log, and the second one exists because of this row rather than because two formats seemed nicer than one. A record carries its own lengths, nothing points backwards, and a reader walks forward and stops where the bytes stop, which is also what makes a journal cut off mid-write recoverable up to the last whole record.',
    ],
    table: {
      columns: ['rewriting the whole document', 'the file', 'per edit'],
      rows: [
        ['one stroke', written('one stroke'), rewrite('one stroke')],
        ['a 300-frame run', written('a 300-frame run'), rewrite('a 300-frame run')],
        ['ten minutes of tracking', written('ten minutes'), rewrite('ten minutes')],
      ],
    },
    caveat:
      'Into the origin private file system through createWritable, which is what a page has. The stream is opened once per rewrite rather than once per chunk, so the copy in the row above is paid once here and is not what makes this quadratic: the header and the payload both grow with the log, and every edit writes all of both.',
    command: 'node tools/video-bench/run.mjs recovery',
  };
}

function comingBack(saved: unknown): Section {
  const reading = (label: string): string =>
    ms(num(saved, ['recovery', 'reading_a_journal_back', label, 'ms', 'median']));
  const records = (label: string): string =>
    num(saved, ['recovery', 'reading_a_journal_back', label, 'records']).toLocaleString('en-GB');
  return {
    heading: 'Coming back is one read, so it can happen before anything is on screen',
    prose: [
      'A recovery walks every record and turns it back into a command. That is the same work reading a document does, plus the framing, and it lands in the same place: a document, which then goes through the same path a dropped .rotyl takes. The media check is the same, the replay is the same, and a file that does not match is refused with the same sentence.',
      'It is also on the main thread and without a worker, deliberately. It runs once, at start-up, before any file is open and therefore before any journal is being written, so it is an ordinary read of an ordinary file. Spinning a worker up to do it would cost every session that never opens anything a thread.',
    ],
    table: {
      columns: ['reading a journal back', 'records', 'to a command log'],
      rows: [
        ['a 300-frame run', records('a 300-frame run'), reading('a 300-frame run')],
        ['ten minutes of tracking', records('ten minutes'), reading('ten minutes')],
      ],
    },
    caveat: `Every record parsed rather than skipped, because what a recovery pays is turning bytes back into commands and a walk that only added up lengths would be measuring the disk. What it lands in has room: the origin private file system reports ${num(
      saved,
      ['recovery', 'quota', 'quota_megabytes'],
    ).toFixed(
      0,
    )} MB of quota here, against 65 MB for the longest session this project has ever measured, and the real ceiling is the one in known limits, which is a write refused just past a gigabyte.`,
    command: 'node tools/video-bench/run.mjs recovery',
  };
}

// --- writing a clip ---------------------------------------------------------

function pipeline(exported: unknown): Section {
  const rung = (size: string, name: string): string =>
    ms(num(exported, ['encode', `${size}, ladder (poster)`, name, 'ms_per_frame']));
  const row = (label: string, name: string): readonly string[] => [
    label,
    rung('720p', name),
    rung('1080p', name),
  ];
  return {
    heading: 'The encoder is the pipeline',
    prose: [
      'A VideoEncoder is asynchronous and holds its own queue, so timing one frame answers nothing. What decides whether a clip export is a wait or an ordeal is sustained throughput with everything in flight at once, measured as a ladder where each rung adds exactly one step to the one below it.',
      'It does not add up, and that is the finding. The encoder handed the same picture with the GPU taken out of the loop measures 4.7 ms a frame at 1080p, against 5.0 for the whole thing: every rung below it runs on threads the encoder is not using. At 1080p with a style that fits in a frame there is nothing worth optimising except the encoder.',
      'Writing the packets into a container rather than binning them costs a tenth of a millisecond. Whatever a muxer costs, it is not per frame.',
    ],
    table: {
      columns: ['ms per frame, poster, export tier', '720p', '1080p'],
      rows: [
        row('decode the frame and upload it', 'decode'),
        row('and the style chain and composite', 'composite'),
        row('and capture the canvas as a frame', 'capture, canvas'),
        row('and encode it', 'encode'),
        row('and write it into an MP4', 'mux'),
      ],
    },
    caveat:
      'Ninety frames of a 1080p30 clip, wall clock, at the export quality tier. The alternative to capturing the canvas, copying the composite into a buffer and rebuilding a frame from the bytes, costs 1.4 ms a frame more at 1080p and needs every row de-padded to undo the 256-byte alignment WebGPU imposes on texture-to-buffer copies.',
    command: 'node tools/video-bench/run.mjs encode',
  };
}

function clipThroughput(exported: unknown): Section {
  const endToEnd = (size: string, style: string, key: string): number =>
    num(exported, ['encode', `${size}, end to end`, style, key]);
  const row = (style: string): readonly string[] => [
    style,
    `${ms(endToEnd('720p', style, 'ms_per_frame'))} (${endToEnd('720p', style, 'frames_per_s').toFixed(0)} fps)`,
    `${ms(endToEnd('1080p', style, 'ms_per_frame'))} (${endToEnd('1080p', style, 'frames_per_s').toFixed(0)} fps)`,
  ];
  return {
    heading: 'What a clip costs to write, per style',
    prose: [
      'Decode, style, composite, capture, encode and mux, end to end. Two of the three styles write a clip several times faster than it plays. The third is the style-cost table again with an encoder underneath it that never has to wait.',
      'A minute of 1080p through the comic chain is five and a half minutes of work. That is what makes progress and a way to stop part of the feature rather than polish on it.',
    ],
    table: {
      columns: ['end to end', '720p', '1080p'],
      rows: [row('poster'), row('print'), row('comic')],
    },
    command: 'node tools/video-bench/run.mjs encode',
  };
}

function rateControl(exported: unknown): Section {
  const rate = (name: string, key: string): number =>
    num(exported, ['encode', 'rate control (1080p, poster)', name, key]);
  const row = (label: string, name: string): readonly string[] => [
    label,
    ms(rate(name, 'ms_per_frame')),
    `${(rate(name, 'bytes') / 1e6).toFixed(2)} MB`,
    `${rate(name, 'megabits_per_s').toFixed(1)} Mbit/s`,
  ];
  return {
    heading: 'Rate control is a decision about size, not about speed',
    prose: [
      `A qualitative quality level resolves to a quantizer where the codec supports one, which is constant quality and therefore an unbounded file. It is also the default, so a clip export that says nothing about rate control ships ${(
        rate('high, quantizer', 'bytes') / rate('high, bitrate', 'bytes')
      ).toFixed(1)} times the bytes for no time at all.`,
      'Asking for the same level as a bitrate is a predictable file and a variable picture. Rotyl asks for very-high as a bitrate, which is about 12 Mbit/s at 1080p and scales with resolution.',
      'The first row is the one figure here that is not repeatable to the tenth, and for the reason the row is about: a quantizer is constant QUALITY, so what it costs in bits belongs to the picture rather than to the setting, and the same three seconds came back at 30.0 Mbit/s on one run and 23.4 on another. The three bitrate rows agree to a hundredth of a megabyte between runs, which is the point of them.',
    ],
    table: {
      columns: ['what was asked for', 'ms per frame', 'file', 'rate'],
      rows: [
        row('high, as a quantizer', 'high, quantizer'),
        row('high, as a bitrate', 'high, bitrate'),
        row('very-high, as a bitrate', 'very-high, bitrate'),
        row('12 Mbit/s, stated', '12 Mbit/s'),
      ],
    },
    caveat:
      'Ninety frames of styled 1080p, three seconds. Measured on the styled output rather than on the source, because that is what an export encodes and flat areas compress nothing like film grain does.',
    command: 'node tools/video-bench/run.mjs encode',
  };
}

function encodeColour(exported: unknown): Section {
  const worst = (who: string): string =>
    `${num(exported, ['encode-colour', who, 'round_trip', 'worst']).toFixed(0)} codes`;
  const median = (who: string): string =>
    `${num(exported, ['encode-colour', who, 'round_trip', 'median_abs']).toFixed(0)} codes`;
  return {
    heading: 'The encoder is not what moves colour',
    prose: [
      'Colour had been measured on the way in and never on the way out, which is the direction a clip export depends on. Pixels leave through a canvas, become a video frame, are converted to YCbCr by the encoder and come back through the browser’s own conversion, and every one of those steps can apply a transfer function.',
      'The same sixteen patches, put through the real composite at zero coverage, which returns the source byte for byte, then written out and decoded back. All sixteen come back bit-identical to ffmpeg’s round trip, not merely close: the error is entirely the midtone shift the upload puts into any 4:2:0 frame whose transfer is unspecified, which is measured and attributed on its own page and is the same on both sides of this comparison.',
      'The container is tagged correctly too, which matters for every player that is not this one. So there is no export colour path either; there is the colour path, and this is one more thing that already sits in it.',
    ],
    table: {
      columns: ['sixteen patches, round tripped', 'worst error', 'median'],
      rows: [
        ['through Rotyl’s encoder', worst('ours'), median('ours')],
        [
          'through ffmpeg, same decode path',
          worst('ffmpeg, same decode path'),
          median('ffmpeg, same decode path'),
        ],
      ],
    },
    command: 'node tools/video-bench/run.mjs encode-colour',
  };
}

function containerBytes(bundle: unknown): Section {
  const gzip = (name: string): string => asBytes(num(bundle, ['cases', name, 'gzip']));
  const delta = (name: string): string => asBytes(num(bundle, ['deltas', name]));
  return {
    heading: 'Writing a container costs as much as the application',
    prose: [
      'Measured through Rotyl’s own build, so the answer is what this bundler’s tree shaking actually produces rather than what a standalone one would.',
      `Writing costs ${delta('writing, on top of reading')} gzipped on top of a chunk that already reads, which is nine tenths of the entire application bundle and was all of it until saving a selection was added to that bundle. So the writer is its own dynamic import, fetched by an export and by nothing else, the same treatment the demuxer and the model get.`,
      `A second container to write costs ${delta('a second container to write')}: QuickTime is the same muxer with a different brand list, exactly as it is on the read side. A soundtrack copied across costs ${delta('a soundtrack copied across')}, which is a second track and a second source on a muxer that was already paid for. The encoder wrapper is ${delta('the encoder wrapper')} of the writer, and driving the encoder by hand instead would save that and cost five per cent a frame.`,
      'Shipped, there are two consumers of one library and the bundler puts what they share in a chunk of its own, so opening a video costs 8.8 KB more than it did for somebody who never exports one. The alternative arrangements are worse: one chunk makes every video session pay for the writer, and no split at all puts it in the application.',
    ],
    table: {
      columns: ['gzipped', 'size'],
      rows: [
        ['read MP4 and QuickTime', gzip('read MP4 QTFF')],
        ['write MP4, from packets', gzip('write MP4, packets only')],
        ['write MP4, encoding as well', gzip('write MP4')],
        ['write MP4, and copy a soundtrack into it', gzip('write MP4, with sound')],
        ['read MP4 and QuickTime, and write MP4', gzip('read MP4 QTFF + write MP4')],
      ],
    },
    command: 'node tools/video-bench/bundle-size.mjs',
  };
}

/**
 * One field of a row, without asserting what a row is.
 *
 * The rows on this page come out of a benchmark that reports a rung differently
 * depending on whether it finished, so a shape asserted here would be a shape
 * that is right on this laptop and wrong on the next one.
 */
function field(row: unknown, key: string): unknown {
  if (typeof row !== 'object' || row === null) return undefined;
  return Object.getOwnPropertyDescriptor(row, key)?.value;
}

/** A field that should be a number, or a word where the rung has none. */
function numberIn(row: unknown, key: string, format: (value: number) => string): string {
  const value = field(row, key);
  return typeof value === 'number' ? format(value) : 'none';
}

/**
 * The rows of the ladder, read as a list rather than by index.
 *
 * Which rung fails depends on the machine, so a page that named the fifth one
 * would be a page that renders on this laptop and throws on the next.
 */
function ladder(long: unknown): readonly unknown[] {
  const rows = at(long, ['long-clip', 'held in memory, the ladder']);
  if (!Array.isArray(rows)) throw new Error('research: the long-clip ladder is not a list');
  return rows;
}

const mb = (value: number): string => `${value.toFixed(0)} MB`;

function heldCeiling(long: unknown): Section {
  const rows = ladder(long);
  return {
    heading: 'Where a clip export stopped working, which was not where the note said',
    prose: [
      'Every clip export this project had written was assembled in the tab and handed over at the end, and the known limits page said a ten-minute one would be about a gigabyte and that there was no answer to that beyond failing. The consequence was right and the number was a guess.',
      `Ten minutes works. It is ${numberIn(rows[1], 'file_mb', mb)} and it peaks at ${numberIn(rows[1], 'peak_heap_mb', mb)} against a heap limit of ${mb(num(long, ['long-clip', 'heap_limit_mb']))}. What fails is twenty-five, and it fails at finalize with a catchable RangeError after three and a half minutes of encoding, which is the worst possible moment for one and still better than a dead tab.`,
      `The heap tracks the file one for one: fitted across the rungs, this path held about ${num(long, ['long-clip', 'held in memory, the ladder', '0', 'heap_mb_per_1000_frames']).toFixed(0)} MB more per thousand frames written, and a thousand frames at this bitrate is 46 MB of file. So the ceiling is arithmetic rather than luck. It is also worth noticing that the twenty-minute rung peaked above the limit the browser reports and survived, so that figure is not a wall external buffers hit exactly.`,
    ],
    table: {
      columns: ['minutes', 'file', 'heap while writing', 'peak heap', 'peak ÷ file', 'finalize'],
      rows: rows.map((row) => [
        numberIn(row, 'minutes', (value) => value.toFixed(0)),
        numberIn(row, 'file_mb', mb),
        numberIn(row, 'heap_while_writing_mb', mb),
        numberIn(row, 'peak_heap_mb', mb),
        numberIn(row, 'peak_over_file', (value) => value.toFixed(1)),
        field(row, 'ok') === false
          ? 'failed'
          : numberIn(row, 'finalize_seconds', (value) => `${value.toFixed(1)} s`),
      ]),
    },
    caveat:
      'The seconds in the last column are not the container writer. With the encoder taken out of it and 790 MB of packets pushed straight into the muxer, finalizing costs 0.17 s held in memory and 0.07 s with the index reserved. They are a tab with two gigabytes in it being asked for another one.',
    command: 'node tools/video-bench/run.mjs long-clip',
  };
}

function intoAFile(long: unknown): Section {
  const row = (path: string, key: string, format: (value: number) => string): string =>
    format(num(long, ['long-clip', path, key]));
  return {
    heading: 'Given a file to write into, nothing is held',
    prose: [
      'The same loop, the same sink, the same settings, with a file handle behind it instead of a buffer. The last column is the finding: writing into a file grows the heap by a fraction of a megabyte per thousand frames, which is the noise of a decode loop rather than a trend. One of the rungs fits a NEGATIVE slope, which is the same statement said more bluntly: there is nothing accumulating, so the length of the clip stops being a variable and there is no ceiling to quote.',
      `And it costs nothing per frame. ${row('into a file', 'ms_per_frame', (value) => `${value.toFixed(2)} ms`)} a frame at 1080p against the 5.0 the encode ladder committed to, which is the encoder's own cost with the disk underneath it disappearing into threads it was not using.`,
      `A soundtrack changes neither. The last two rows are the same twenty-five minutes with and without one: ${row('into a file, with a soundtrack, discarded at the writer', 'ms_per_frame', (value) => `${value.toFixed(2)} ms`)} a frame against ${row('into a file, discarded at the writer', 'ms_per_frame', (value) => `${value.toFixed(2)} ms`)}, and ${mb(num(long, ['long-clip', 'into a file, with a soundtrack, discarded at the writer', 'peak_heap_mb']))} of peak heap against ${mb(num(long, ['long-clip', 'into a file, discarded at the writer', 'peak_heap_mb']))} on a file that is ${mb(num(long, ['long-clip', 'into a file, with a soundtrack, discarded at the writer', 'file_mb']))} rather than ${mb(num(long, ['long-clip', 'into a file, discarded at the writer', 'file_mb']))}. The eight megabytes are the second track's sample table in the reserved index, and they are a fact about the index rather than about the length: ${num(long, ['long-clip', 'into a file, with a soundtrack, discarded at the writer', 'audio_packets_written']).toLocaleString('en-GB')} packets went in, counted at the sink rather than predicted.`,
      `Read back through the product's own frame provider, the ten-minute file is a clip: ${num(long, ['long-clip', 'decoded back', 'frames']).toFixed(0)} frames, ${num(long, ['long-clip', 'decoded back', 'seconds']).toFixed(0)} seconds, ${num(long, ['long-clip', 'decoded back', 'keyframes']).toFixed(0)} keyframes, and its boxes are ftyp, moov, free, mdat in that order. The index is at the front, which a stream does not do by default: the room for it is reserved before the first frame and seeked back to at the end.`,
    ],
    table: {
      columns: ['where it went', 'minutes', 'file', 'peak heap', 'peak ÷ file', 'heap per 1000 frames'],
      rows: [
        [
          'a file',
          '25',
          row('into a file, discarded at the writer', 'file_mb', mb),
          row('into a file, discarded at the writer', 'peak_heap_mb', mb),
          row('into a file, discarded at the writer', 'peak_over_file', (value) => value.toFixed(2)),
          row(
            'into a file, discarded at the writer',
            'heap_mb_per_1000_frames',
            (value) => `${value.toFixed(1)} MB`,
          ),
        ],
        [
          'a file, with sound',
          '25',
          row('into a file, with a soundtrack, discarded at the writer', 'file_mb', mb),
          row('into a file, with a soundtrack, discarded at the writer', 'peak_heap_mb', mb),
          row('into a file, with a soundtrack, discarded at the writer', 'peak_over_file', (value) =>
            value.toFixed(2),
          ),
          row(
            'into a file, with a soundtrack, discarded at the writer',
            'heap_mb_per_1000_frames',
            (value) => `${value.toFixed(1)} MB`,
          ),
        ],
        [
          'a file',
          '10',
          row('into a file', 'file_mb', mb),
          row('into a file', 'peak_heap_mb', mb),
          row('into a file', 'peak_over_file', (value) => value.toFixed(2)),
          row('into a file', 'heap_mb_per_1000_frames', (value) => `${value.toFixed(1)} MB`),
        ],
        [
          'memory',
          '10',
          row('in memory', 'file_mb', mb),
          row('in memory', 'peak_heap_mb', mb),
          row('in memory', 'peak_over_file', (value) => value.toFixed(2)),
          row('in memory', 'heap_mb_per_1000_frames', (value) => `${value.toFixed(1)} MB`),
        ],
      ],
    },
    caveat:
      'The twenty-five minute row counted its bytes and discarded them, which is the harness rather than the export: Playwright cannot drive a native save dialog, so the origin private file system stands in for one, and it has a quota a real disk does not. It reports three gigabytes and refuses a write just past one, with and without exclusive mode and with durable storage granted. So one rung isolates the export from the disk and the other writes a real file and reads it back.',
    command: 'node tools/video-bench/run.mjs long-clip',
  };
}

function theBudget(long: unknown): Section {
  const blob = at(long, ['long-clip', 'handing it over', 'rows']);
  if (!Array.isArray(blob)) throw new Error('research: the blob sweep is not a list');
  const budgeted = (key: string, format: (value: number) => string): string =>
    format(num(long, ['long-clip', 'in memory, past the budget', key]));
  return {
    heading: 'So the path with nowhere to write stops at a budget',
    prose: [
      'Four times the file is what has to fit at the moment it is finished: up to twice in the buffer it is assembled in, since that buffer grows by doubling, once more for the copy sliced out of it, and once more for the blob a download is handed. So the budget is the heap limit over four.',
      `Asked for thirty minutes with nowhere to write it, the export stops at ${budgeted('minutes_written', (value) => value.toFixed(1))} minutes and ${budgeted('file_mb', mb)}, peaks at ${budgeted('peak_heap_mb', mb)}, and produces ftyp, moov, free, mdat: a valid clip of the part that was rendered, which is the same thing pressing Stop produces and for the same reason.`,
      `That blob is the other thing with a limit. In a clean tab this browser gives a byte back out of ${mb(num(long, ['long-clip', 'handing it over', 'largest_readable_mb']))}, and a two gigabyte buffer cannot be allocated at all. But a finished export is not holding a clean tab: with the buffer the file was assembled in still alive alongside the blob made from it, which is exactly what the sink holds at the moment it hands one over, a 790 MB blob comes back unreadable on every attempt. As a download that is a file that never arrives and no word about why, so the download path asks for one byte before handing the blob to an anchor.`,
    ],
    table: {
      columns: ['blob handed over', 'made', 'one byte read back'],
      rows: blob.map((entry: unknown) => {
        const failure = field(entry, 'error');
        return [
          numberIn(entry, 'mb', mb),
          field(entry, 'made') === true ? 'yes' : 'no',
          field(entry, 'read') === true
            ? 'yes'
            : typeof failure === 'string'
              ? (failure.split(':')[0] ?? 'no')
              : 'no',
        ];
      }),
    },
    caveat:
      'None of this is a guarantee and nothing can make it one. How much a tab can hold depends on what else the machine is doing: the same sweep taken an hour apart read a gigabyte and a half once and refused half of that the next time, on a browser that had been running exports in between. What the budget buys is that the common case ends in a file rather than in a dead tab.',
    command: 'node tools/video-bench/run.mjs long-clip',
  };
}

// --- where the sound goes ---------------------------------------------------

/** The arrangement rows, read as a list: one of them does not produce a file. */
function arrangements(sound: unknown): readonly unknown[] {
  const rows = at(sound, ['interleave', 'the arrangements']);
  if (!Array.isArray(rows)) throw new Error('research: the arrangements are not a list');
  return rows;
}

function pick(sound: unknown, arrangement: string, seconds: number): unknown {
  const found = arrangements(sound).find(
    (row) => field(row, 'arrangement') === arrangement && field(row, 'seconds') === seconds,
  );
  if (found === undefined) {
    throw new Error(`research: no ${arrangement} arrangement at ${String(seconds)} seconds`);
  }
  return found;
}

function theArrangements(sound: unknown): Section {
  const rows = arrangements(sound);
  const worst = (arrangement: string, seconds: number): string =>
    numberIn(pick(sound, arrangement, seconds), 'worst_gap_mb', (value) => `${value.toFixed(1)} MB`);
  return {
    heading: 'A file with its sound in one run is not a file anybody can stream',
    prose: [
      'The index goes at the front of every file this writes, so a player can start before the last byte has arrived. Adding a second track is the first thing capable of quietly undoing that. A file whose video is one contiguous run and whose audio is another satisfies "the index is at the front" on paper and violates it completely in practice, because a player has to hold the whole video to reach the first audio sample.',
      `So this asks, for every whole second of the clip, how far away in the file the sound that plays with it is. Gathered at one end the answer is most of the file and it GROWS with the clip: ${worst('primed', 30)} at thirty seconds, ${worst('primed', 120)} at two minutes and ${worst('primed', 300)} at five. Interleaved it is a constant ${worst('interleaved', 300)} at every length measured, which is about two and a half seconds of media.`,
      'And the cheapest arrangement of all does not produce a file at all. With the index reserved, the muxer cannot size the movie box until it has seen a packet from every track it was told about, so a run of video with the audio behind it queues every frame in memory, and on a track carrying B-frames it fails outright before a byte is written. One audio packet in front of the video is what makes the second row exist, and it is also all that separates the second row from the third: after that, interleaving is one comparison per frame.',
    ],
    table: {
      columns: ['arrangement', 'seconds', 'file', 'worst reach', 'median reach', 'of the file'],
      rows: rows.map((row) => [
        String(field(row, 'arrangement')),
        numberIn(row, 'seconds', (value) => value.toFixed(0)),
        numberIn(row, 'file_mb', (value) => `${value.toFixed(0)} MB`),
        numberIn(row, 'worst_gap_mb', (value) => `${value.toFixed(2)} MB`),
        numberIn(field(row, 'gap'), 'median', (value) => `${(value / 2 ** 20).toFixed(2)} MB`),
        field(row, 'ok') === false
          ? 'no file'
          : numberIn(row, 'worst_gap_over_file', (value) => `${(value * 100).toFixed(1)}%`),
      ]),
    },
    caveat:
      'Both tracks are passed through as encoded packets, with no encoder anywhere in it, which is what a clip export does with audio and is also what isolates this from the encode ladder. What is being laid out here is the muxer\u2019s arrangement of bytes. Memory is not in the table because it does not separate the arrangements: both stream, and what grows is the sample table a reserved index keeps per track, which both need in equal measure.',
    command: 'node tools/video-bench/run.mjs interleave',
  };
}

function countingFirst(sound: unknown): Section {
  const rows = at(sound, ['interleave', 'counting it first', 'rows']);
  if (!Array.isArray(rows)) throw new Error('research: the counting rows are not a list');
  const longest = rows.at(-1);
  return {
    heading: 'Knowing how much sound there is, before the first frame is rendered',
    prose: [
      'The movie box is reserved at the front of the file, which means its sample tables are sized before the first sample lands, which means every track needs a maximum packet count up front. The video has one for nothing: an export knows how many frames it is writing before it renders the first one. The audio does not, and the only way to get one is to walk the whole track.',
      `It is a metadata-only walk, which reads the sample tables and none of the payload, and it is about a microsecond a packet: ${numberIn(longest, 'ms', (value) => `${value.toFixed(0)} ms`)} for the ${numberIn(longest, 'packets', (value) => value.toLocaleString('en-GB'))} packets in twenty minutes of 48 kHz audio. Linear, and paid once, before anything slow, which is the rule the destination already follows.`,
    ],
    table: {
      columns: ['audio', 'packets', 'to walk it', 'per packet'],
      rows: rows.map((row) => [
        numberIn(row, 'minutes', (value) =>
          value < 1 ? `${(value * 60).toFixed(0)} seconds` : `${value.toFixed(0)} minutes`,
        ),
        numberIn(row, 'packets', (value) => value.toLocaleString('en-GB')),
        numberIn(row, 'ms', (value) => `${value.toFixed(1)} ms`),
        numberIn(row, 'us_per_packet', (value) => `${value.toFixed(2)} \u00b5s`),
      ]),
    },
    command: 'node tools/video-bench/run.mjs interleave',
  };
}

function whatItWillNotCarry(sound: unknown): Section {
  const rows = at(sound, ['interleave', 'what the container will not carry', 'rows']);
  if (!Array.isArray(rows)) throw new Error('research: the codec rows are not a list');
  const codecs = at(sound, ['interleave', 'what the container will not carry', 'mp4_audio_codecs']);
  if (!Array.isArray(codecs)) throw new Error('research: the codec list is not a list');
  return {
    heading: 'A soundtrack the container will not take, said before any of the work',
    prose: [
      'QuickTime carries mu-law and MP4 does not, so a .mov off an older camera is a perfectly ordinary file whose sound has nowhere to go. Losing it silently is the thing this chapter existed to fix, so the question is not whether it can be answered but when.',
      `It is answered from the track and the format alone, with nothing decoded and nothing encoded, in no time at all: an MP4 holds ${String(codecs.length)} audio codecs and the file already says which one it has. So it is said while the file is merely open, in the same row as its name and its size, and again in the button's own sentence before the minutes of encoding rather than after them.`,
    ],
    table: {
      columns: ['file', 'its soundtrack', 'an MP4 can carry it', 'to decide'],
      rows: rows.map((row) => [
        String(field(row, 'file')),
        String(field(row, 'codec')),
        field(row, 'mp4_can_carry_it') === true ? 'yes' : 'no',
        numberIn(row, 'ms_to_decide', (value) => `${value.toFixed(0)} ms`),
      ]),
    },
    caveat:
      'The codecs an MP4 holds are written out in export.ts rather than asked of the container writer, because the writer is behind a dynamic import only a clip export fetches and the question has to be answerable while a video is merely open. A copied list can drift, so a unit test asserts it against the writer\u2019s own.',
    command: 'node tools/video-bench/run.mjs interleave',
  };
}

// --- what holds a clip still ------------------------------------------------

/** One row of the attribution, by subject, condition and case. */
function attributed(sound: unknown, subject: string, condition: string, item: string): unknown {
  return at(sound, ['attribution', subject, condition, item]);
}

const ratio = (value: number): string => value.toFixed(2);
const codes = (value: number): string => value.toFixed(1);

const CHAINS = ['comic, default', 'comic, detail 1', 'poster, default', 'poster, no line', 'print, default'];

function residueComesFrom(still: unknown): Section {
  const amp = (subject: string, item: string): string =>
    ratio(num(attributed(still, subject, 'as it is', item), ['amplification', 'p99']));
  return {
    heading: 'The residue is the input, and what a chain does with it depends on the picture',
    prose: [
      'Every stage runs per frame with no knowledge of the last one, so a chain is a pure function of its frame: hand it the same picture twice and it gives the same answer twice. That is not an argument, it is the second row of the table. On a clip encoded with no temporal grain the input moves by 1.4 codes at the 99th percentile, which is the codec, and every chain answers with 1.0, which is the floor. There is nothing in a styled frame that was not in the source frame.',
      `So the question is only what a chain does with the change it was given, and the answer depends on the picture rather than on the chain. On the drawn scene every chain but print attenuates: comic ${amp('the synthetic scene, five cars moving', 'comic, default')}, poster ${amp('the synthetic scene, five cars moving', 'poster, default')}, print ${amp('the synthetic scene, five cars moving', 'print, default')}. On a photograph of a brick wall the same poster chain amplifies at ${amp('facade, fixed camera', 'poster, default')} and the comic chain at full detail at ${amp('facade, fixed camera', 'comic, detail 1')}.`,
      `And where the amplification is has already been found once. Poster with its outline drawn is ${amp('facade, fixed camera', 'poster, default')} on the wall and ${amp('facade, fixed camera', 'poster, no line')} without it, ${amp('foliage, fixed camera', 'poster, default')} against ${amp('foliage, fixed camera', 'poster, no line')} on foliage. The comic chain's rises with the detail control: ${amp('facade, fixed camera', 'comic, detail 1')} at full detail against ${amp('facade, fixed camera', 'comic, detail 0')} at none. This sentence used to say that was the Kuwahara radius falling until the flatten stopped flattening, which is the wrong mechanism; what it turned out to be has its own page.`,
    ],
    table: {
      columns: ['amplification, p99', 'the drawn scene', 'facade', 'foliage', 'fog', 'portrait'],
      rows: CHAINS.map((item) => [
        item,
        amp('the synthetic scene, five cars moving', item),
        amp('facade, fixed camera', item),
        amp('foliage, fixed camera', item),
        amp('fog, fixed camera', item),
        amp('portrait, fixed camera', item),
      ]),
    },
    caveat:
      'Measured over the pixels no moving thing touched, which on a photograph is the whole frame and on the drawn scene is everything the five cars did not cross. The two film shots are not here: an input denoise applied to a clip with actors in it smears the actors, so the row would report a shrinking input for the wrong reason, and there is no still population to restrict to. What the film says about amplification is on the real-footage page.',
    command: 'node tools/style-bench/run.mjs motion',
  };
}

function denoisingTheInput(still: unknown): Section {
  const cell = (subject: string, condition: string, item: string, path: readonly string[]): number =>
    num(attributed(still, subject, condition, item), path);
  const row = (subject: string, item: string): readonly string[] => [
    `${subject.split(',')[0] ?? subject}, ${item}`,
    codes(cell(subject, 'as it is', item, ['input', 'p99'])),
    codes(cell(subject, 'input denoised', item, ['input', 'p99'])),
    codes(cell(subject, 'as it is', item, ['styled', 'p99'])),
    codes(cell(subject, 'input denoised', item, ['styled', 'p99'])),
    ratio(cell(subject, 'as it is', item, ['amplification', 'p99'])),
    ratio(cell(subject, 'input denoised', item, ['amplification', 'p99'])),
  ];
  return {
    heading: 'A cleaner input does not touch the thing that amplifies',
    prose: [
      'If the residue is the input, the cheapest fix is to give the chain a quieter one: average each frame against the one before it on the way IN, which is one pass, needs no motion estimation on a fixed camera, and is nothing like a temporal filter on the output. It was measured before it was argued about, at the weakest weight worth measuring, a quarter.',
      'It works, and it works less than it looks. A quarter of the last frame takes the input down by about a fifth and the styled output down with it, roughly in proportion, on every chain and every picture.',
      'The last two columns are the finding, and they were not what this expected. Amplification goes UP wherever it was already above one: the poster chain on a brick wall goes from 1.36 to 1.54, on foliage from 1.46 to 1.63, and the comic chain at full detail from 1.75 to 2.15. What a denoise removes is the high-frequency part of the input, which is the part these chains attenuate hardest; what is left is the part they amplify. So a cleaner input lowers the number and leaves the mechanism exactly where it was.',
    ],
    table: {
      columns: [
        'input p99, then styled p99, then amplification',
        'in, as it is',
        'in, denoised',
        'out, as it is',
        'out, denoised',
        'amp, as it is',
        'amp, denoised',
      ],
      rows: [
        row('facade, fixed camera', 'poster, default'),
        row('foliage, fixed camera', 'poster, default'),
        row('facade, fixed camera', 'comic, detail 1'),
        row('fog, fixed camera', 'print, default'),
        row('the synthetic scene, five cars moving', 'comic, default'),
      ],
    },
    command: 'node tools/style-bench/run.mjs motion',
  };
}

/** One method's figures on the traffic clip, for the counter-metric table. */
function method(still: unknown, clip: string, item: string, name: string): unknown {
  return at(still, ['motion', clip, item, name]);
}

function theCounterMetric(still: unknown): Section {
  const cell = (name: string, path: readonly string[]): string =>
    codes(num(method(still, 'traffic-720p', 'comic, default', name), path));
  const detail = (name: string): string =>
    ratio(num(method(still, 'traffic-720p', 'poster, default', name), ['detail_against_per_frame']));
  return {
    heading: 'And the expensive answer is worse than the disease, measured before it was built',
    prose: [
      'Every temporal method improves flicker trivially, and some of them do it by making the picture worse. Blend enough of the last frame in and a fixed camera is perfectly steady while a moving one smears. Neither of the clips this project had could catch that: one has a fixed camera and nothing in it can expose a ghost, and the other pans a still, so every pixel moves together, which is the one case a warp of the last frame gets right by construction.',
      'So this runs on a clip where five cars move against a city that does not, with a mask drawn from the same geometry as the picture saying which pixels a moving thing covered. And a straw man is measured beside every row, because a counter-metric with no failing case is not a check: the previous stylised frame blended in at a fixed weight, with no motion compensation, which is the cheapest thing anybody would try.',
      `It fails, and the shape of the failure is the point. Half of the last frame takes the residue from ${cell('per frame', ['residue', 'p99'])} codes to ${cell('blend 0.5', ['residue', 'p99'])}, which is the number everybody quotes, improved by two fifths. It pays for it with ${cell('blend 0.5', ['deviation', 'vacated', 'p99'])} codes of deviation in the band a car has just left and ${cell('blend 0.5', ['deviation', 'moving', 'p99'])} on the car itself, and with ${detail('blend 0.5')} of the gradient energy inside a moving car, against ${detail('per frame')} for the render it replaced.`,
      'On the clip with no moving grain, where the residue is already at the codec floor, the same blend makes the residue flicker WORSE and still costs the same fifty-five codes of deviation. That is the cure being worse than the disease with nothing left to cure, in one row.',
    ],
    table: {
      columns: [
        'comic, on five cars moving',
        'residue p99',
        'residue %',
        'deviation, still',
        'deviation, vacated',
        'deviation, on the car',
        'detail',
      ],
      rows: ['per frame', 'blend 0.25', 'blend 0.5'].map((name) => [
        name,
        cell(name, ['residue', 'p99']),
        pct(num(method(still, 'traffic-720p', 'comic, default', name), ['residue', 'flicker'])),
        cell(name, ['deviation', 'still', 'p99']),
        cell(name, ['deviation', 'vacated', 'p99']),
        cell(name, ['deviation', 'moving', 'p99']),
        ratio(num(method(still, 'traffic-720p', 'comic, default', name), ['detail_against_per_frame'])),
      ]),
    },
    caveat:
      'The deviation is split three ways because the picture said so. The first version of this measured it only in the band a car had just left, on the argument that a ghost can live nowhere else. The trail map the harness writes says otherwise: most of what a blend does is on and around the moving object itself, and a vacated-band figure alone would have missed the larger half.',
    command: 'node tools/style-bench/run.mjs motion',
  };
}

// --- what the tracker knew ---------------------------------------------------

function whatDied(): Section {
  return {
    heading: 'The model answers the question and the answer stopped three files short',
    prose: [
      'A tracker is asked, on every frame, whether the object is in it at all. EdgeTAM answers with an object score rather than with a pixel count, which is the right shape: an object behind something is not an object that got smaller. edgetam-tracker.ts reads that score and does three things with it. It swaps the mask for an empty one, so a decoder told there is nothing there cannot draw something anyway. It swaps the memory entry for a large negative placeholder, so an occlusion cannot teach the tracker what the occluder looks like. And it swaps the object pointer for the checkpoint’s own stand-in, so identity survives the gap.',
      'Then it puts the verdict on the value it returns, and that is where it used to stop. tracking-job.ts read it once, to add one to a counter, and wrote an ordinary applyMask with op replace and an all-zero mask. The counter went into a TrackingResult that the store awaited and discarded. So what reached the log was a command that is indistinguishable, by shape, from a selection somebody erased down to nothing: hasAnyCoverage said the frame had a selection on it, the overlay lifted the whole picture toward paper on a frame with nothing selected, and the timeline drew a mark saying an edit was made there.',
      'That is a defect in the log rather than in the interface, and it is worth separating the two, because the answer is different. Every other question this chapter could have asked, how confident the model was, how large each rejected candidate is, how many frames playback dropped, is a fact about the tool, the same on every file anybody opens, and this project has put every one of those on these pages. An occlusion is a fact about THIS clip, on a numbered frame, that somebody has to act on: the selection is gone there, and the only way to know whether that is a tracker failing or a tracker answering was to have been watching when it happened.',
      'So it is a field on the command. Not on the run, which is the other candidate and the one that loses: a run is a thing that happened once in a session that ends, and the question "why is there no selection on frame 412" is asked of a document that was saved, reloaded and undone. group already established that a command may carry a fact about how it came to be rather than about what it does. This is the second of those, and it is the only shape that survives the file.',
    ],
    caveat:
      'One consequence arrived for nothing. hasAnyCoverage is documented as deliberately approximate in one direction, because answering exactly would mean reading the mask back from the GPU on the render path. The occlusion case no longer needs a readback to be exact: a mask that says it is empty on purpose, applied with replace, means the frame has nothing on it, which is what clear already means there. Erasing a selection away by hand is still approximate, and still for the reason it always was.',
  };
}

function whatTheTimelineDrew(hidden: unknown): Section {
  const marks = (run: string): string => num(hidden, ['occlusion', 'timeline', run, 'marks']).toFixed(0);
  const elements = (run: string): string =>
    num(hidden, ['occlusion', 'timeline', run, 'elements']).toFixed(0);
  const projection = (run: string): string =>
    `${num(hidden, ['occlusion', 'timeline', run, 'projection_ms', 'median']).toFixed(1)} ms`;
  return {
    heading: 'The timeline was drawing one gesture as three hundred edits, and one element each',
    prose: [
      'The marks under the timeline exist because a selection that leaves no trace cannot be found again, and they were fed by a projection that returned the frame numbers an edit was made on and nothing else. That is exactly right for a stroke. For a tracking run it says the opposite of what happened: a run is ONE gesture, group has recorded that since the day tracking landed so that undo could take the whole thing back in one press, and the projection threw it away.',
      `It also drew one absolutely positioned element per entry, so a ten-minute run put ${marks(
        '18000 frames, nothing hidden',
      )} of them on a track six hundred pixels wide, every one saying the same thing. Joined along the group it is ${elements(
        '18000 frames, nothing hidden',
      )}: the user’s own command on the anchor frame, which the run deliberately writes nothing for, and the run itself. With the object going behind something three times it is ${elements(
        '18000 frames, hidden three times',
      )}, because each occlusion is a stretch the run reached and found nothing in, drawn faintly rather than left as a gap.`,
      `So the projection that carries more information draws fewer things, which is the only reason it needed no argument about cost. It is run on every render of the editor, which is why it is timed at all: ${projection(
        '18000 frames, hidden three times',
      )} at ten minutes of tracking, against the 33 ms frame the same log is folded inside.`,
    ],
    table: {
      columns: ['a run', 'commands', 'marks, as it was', 'elements, joined', 'the projection'],
      rows: [
        [
          '10 seconds, hidden once',
          num(hidden, ['occlusion', 'timeline', '300 frames, hidden once', 'commands']).toFixed(0),
          marks('300 frames, hidden once'),
          elements('300 frames, hidden once'),
          projection('300 frames, hidden once'),
        ],
        [
          '100 seconds, hidden three times',
          num(hidden, ['occlusion', 'timeline', '3000 frames, hidden three times', 'commands']).toFixed(0),
          marks('3000 frames, hidden three times'),
          elements('3000 frames, hidden three times'),
          projection('3000 frames, hidden three times'),
        ],
        [
          '10 minutes, hidden three times',
          num(hidden, ['occlusion', 'timeline', '18000 frames, hidden three times', 'commands']).toFixed(0),
          marks('18000 frames, hidden three times'),
          elements('18000 frames, hidden three times'),
          projection('18000 frames, hidden three times'),
        ],
      ],
    },
    caveat:
      'Every row above has the object going behind something, so the element counts are the interesting case rather than the flattering one; each occlusion is two seconds, and how many fit is a property of the clip rather than a setting. With none at all a run of any length is two elements, because there is nothing to break it. What does not depend on any of that is the marks column, which is one element per edited frame whatever produced it.',
    command: 'node tools/video-bench/run.mjs occlusion',
  };
}

function whatSayingSoCost(hidden: unknown): Section {
  const fileOf = (path: readonly string[]): string => asFile(num(hidden, path));
  const carrying = num(hidden, ['occlusion', 'frames_hidden']).toFixed(0);
  const perCommand = num(hidden, ['occlusion', 'the_field', 'bytes_per_command']).toFixed(0);
  const flagBytes = num(hidden, ['occlusion', 'the_field', 'bytes']);
  const share = num(hidden, ['occlusion', 'the_field', 'per_cent_of_the_file']);
  const saved = num(hidden, ['occlusion', 'the_occlusion', 'megabytes_saved']).toFixed(2);
  const silhouette = (num(hidden, ['occlusion', 'a_packed_mask_bytes']) / 1024).toFixed(1);
  const nothing = num(hidden, ['occlusion', 'an_empty_packed_mask_bytes']).toFixed(0);
  return {
    heading: 'What it costs to write down, in the file and in the application',
    prose: [
      `A document is a JSON object per command with the packed masks in a region behind it, so a field added to a command is added as many times as there are commands, and a ten-minute tracked run is eighteen thousand of them. That is a fair objection and it is answered with arithmetic: the same log written twice, once with the field and once without, at one occlusion of two seconds every hundred. ${carrying} of the eighteen thousand commands carry it, at ${perCommand} bytes each, which is ${asBytes(flagBytes)} and ${share.toFixed(3)}% of the file.`,
      `The field is written only where it is true, which is why it is absent rather than false. It also has to be measured that way rather than read off two file sizes, because the frames it lands on differ from ordinary tracked frames in a second way at the same time and in the opposite direction: an occluded frame’s mask is empty, and an empty mask packs to ${nothing} bytes against a silhouette’s ${silhouette} KB. So the run WITH occlusions in it is the smaller document by ${saved} MB, and a comparison of the two files alone would price the field at better than free.`,
      `A mask of nothing costing a kilobyte is worth a sentence of its own, because the obvious guess is a byte or two and this was written down as three before it was run. The packing caps a repeat at 128, so sixty-five thousand zeroes are five hundred and twelve repeats rather than one, and the number is three hundred times the guess. It is still under a third of what a silhouette costs, which is the claim this makes; it is not nothing, which is the claim the guess would have made.`,
      'The application bundle is the other price and it is the one that had to be argued for, because this product’s position on its own interface is load-bearing enough to have decided a framework: React was rejected at 59.5 KB gzipped against Preact’s 6.1 for an application whose interface is a canvas and eight buttons. It is still eight buttons. Nothing here is a mode, a panel or a control, and the two things that changed were already on the screen: a mark on a track, and the line a finished export writes into.',
      'Measured through the real build rather than asserted, the application goes from 50.8 KB gzipped to 51.4. Built twice to say which half: carrying the fact through the log, the file and the projection the marks are drawn from is 0.38 KB, and saying what a run found when it is over is the other 0.22. The second is nearly all sentence, and it is a sentence with three cases in it, because a run that walked to the end of the clip and found the object on every frame says nothing at all. The stylesheet is 0.02 KB, which is two rules.',
    ],
    table: {
      columns: ['ten minutes of tracking, as a file', 'bytes'],
      rows: [
        ['nothing hidden', fileOf(['occlusion', 'the_occlusion', 'nothing_hidden_bytes'])],
        [`hidden ${carrying} frames, not said`, fileOf(['occlusion', 'the_field', 'without_it_bytes'])],
        [`hidden ${carrying} frames, said`, fileOf(['occlusion', 'the_field', 'with_it_bytes'])],
      ],
    },
    caveat:
      'Its own command and its own results file, for both halves of this page, which is the harness’s own rule rather than a preference. Either would have fitted somewhere else: the file cost beside what a document costs, the projection beside what the fold costs. Measured there they re-took those measurements and moved figures six documents quote, by noise, on code paths neither touches.',
    command: 'node tools/video-bench/run.mjs occlusion',
  };
}

// --- which figures were about one object -------------------------------------

/** The three columns, named once so the table and the prose cannot disagree. */
const COUNTS = ['1 object', '2 objects', '3 objects'] as const;

function fourFigures(perObject: unknown): Section {
  const cell = (count: string, path: readonly string[]): number =>
    num(perObject, ['objects', 'per_objects', count, ...path]);
  const row = (label: string, render: (count: string) => string): readonly string[] => [
    label,
    ...COUNTS.map(render),
  ];
  // Read off the table rather than typed beside it, which is the rule this
  // whole chapter is about: a ratio in prose is a number waiting to go stale,
  // and the four it describes went stale by standing still.
  const against = (count: string, path: readonly string[]): string =>
    `${(cell(count, path) / cell('1 object', path)).toFixed(2)}×`;
  return {
    heading: 'Three of the four move with the number of objects, and the fourth does not',
    prose: [
      'A run writes one applyMask per frame it followed an object to, and for as long as there was exactly one object a figure about a run and a figure about an object were the same figure. Four of them are quoted in three of this project’s documents, and each is exactly true of one object and says nothing about several. They are taken here at one, two and three.',
      `The file is the one that really is arithmetic, and it is measured anyway rather than multiplied: N objects is N commands per frame and N packed masks behind them, and the run comes back at ${against(
        '2 objects',
        ['file_bytes'],
      )} and ${against('3 objects', ['file_bytes'])} of a single object’s ${asFile(
        cell('1 object', ['file_bytes']),
      )}. So a ten-minute clip with three things followed through it is a ${asFile(
        cell('3 objects', ['file_bytes']),
      )} document, and what had to change about that figure is the two missing words rather than the figure.`,
      `The projection is the one that matters most, because it is the only one of the four on the render path: editSpans runs over the whole log on every render of the editor. It is also the one that moves LEAST. Three times the commands is ${against(
        '3 objects',
        ['projection', 'ms', 'median'],
      )} the time, because what it sorts is the distinct frames a log touched and there are still eighteen thousand of those however many commands landed on each of them.`,
      `And what it DRAWS does not move at all: ${cell('3 objects', ['projection', 'elements']).toFixed(
        0,
      )} elements at three objects, the same ${cell('1 object', ['projection', 'elements']).toFixed(
        0,
      )} as at one. A run is one gesture whatever it followed, every command in it carries the same group, and the timeline joins along that. Following a third car does not put a third bar on the track.`,
    ],
    table: {
      columns: ['ten minutes of tracking', 'one object', 'two', 'three'],
      rows: [
        row('commands in the log', (count) => cell(count, ['commands']).toLocaleString('en-GB')),
        row('the file', (count) => asFile(cell(count, ['file_bytes']))),
        row('writing it', (count) => ms(cell(count, ['write_ms', 'median']))),
        row('the fold, at the last frame', (count) => ms(cell(count, ['fold', 'ms', 'median']))),
        row('what the fold leaves', (count) => cell(count, ['fold', 'folded_to']).toFixed(0)),
        row('a replay: fold and unpack', (count) => ms(cell(count, ['replay', 'ms', 'median']))),
        row('the projection, per render', (count) => ms(cell(count, ['projection', 'ms', 'median']))),
        row('elements it draws', (count) => cell(count, ['projection', 'elements']).toFixed(0)),
      ],
    },
    caveat:
      'The same silhouette for every object, which is the rule the mask helper already sets for the two measurements this one has to be comparable with: two harnesses drawing their own masks would make “62 MB held” and “62 MB written” two numbers about two different logs. A real second object is a different silhouette, and the packing charges for the perimeter rather than for the identity, so what differs between two of them is the spread the compression sweep on the command-log page already brackets.',
    command: 'node tools/video-bench/run.mjs objects',
  };
}

function foldsToN(perObject: unknown): Section {
  const cell = (count: string, path: readonly string[]): number =>
    num(perObject, ['objects', 'per_objects', count, ...path]);
  return {
    heading: 'One of the four was not a figure that moved. It was a sentence that stopped being true',
    prose: [
      'The fold cuts at the last command that decides a frame by itself, which is a clear or a mask applied with replace, because everything before one of those is discarded by it. A run following one object writes replace on every frame it reached, so eighteen thousand commands fold to one and a replay unpacks one mask. That is what made a document able to be dumb: nothing derived has to be stored in it, because rebuilding it is a fold and a texture upload.',
      `A run following several writes replace for the FIRST object and add for the rest, which is what makes two objects two regions rather than a race. So the cut lands on the first object’s command and everything after it survives: the frame folds to ${cell(
        '3 objects',
        ['fold', 'folded_to'],
      ).toFixed(0)} commands at three objects rather than to one, and a replay unpacks ${cell('3 objects', [
        'replay',
        'masks_unpacked',
      ]).toFixed(0)} masks rather than one.`,
      `That is the only one of the four where the correction is not a number. “A fold to one and a texture upload” had no N in it to be wrong about; it was a claim about shape, and the shape changed underneath it when the interface reached a second seed. What it costs is ${ms(
        cell('3 objects', ['replay', 'ms', 'median']),
      )} against ${ms(
        cell('1 object', ['replay', 'ms', 'median']),
      )}, which is linear in objects and is still a fraction of one frame, so the conclusion the sentence was written to support survives being said correctly.`,
    ],
    caveat:
      'Its own command and its own results file, which is the rule the occlusion measurement was written to establish arriving at the door it was written for. Every one of the four figures above already has a home: the file cost belongs to what a document costs, the fold and the replay to what a tracked clip does to the command log, and the projection to what the timeline was given to draw. An objects dimension added to any of the three re-takes that measurement and moves figures this chapter did not change. The one-object column duplicates those three and is taken here rather than quoted from them for the opposite reason: a control that sits in another file taken on another day is not a control, and every ratio above is a ratio between two cells of one run.',
    command: 'node tools/video-bench/run.mjs objects',
  };
}

// --- whether a full-range clip needs a path of its own -----------------------

/** A boolean out of the results, which `num` cannot read and a table needs. */
function flag(source: unknown, path: readonly string[]): boolean {
  const value = at(source, path);
  if (typeof value !== 'boolean') throw new Error(`research: ${path.join(' / ')} is not a boolean`);
  return value;
}

const CLIP = { tv: 'probe-420-tv', pc: 'probe-420-pc' } as const;

function theClipWasAlwaysRight(perRange: unknown): Section {
  const of = (clip: string, path: readonly string[]): number =>
    num(perRange, ['range', 'clips', clip, ...path]);
  const said = (clip: string): string =>
    flag(perRange, ['range', 'reported_full_range', clip]) ? 'full' : 'limited';
  const row = (label: string, render: (clip: string) => string): readonly string[] => [
    label,
    render(CLIP.tv),
    render(CLIP.pc),
  ];
  return {
    heading: 'Two files that differ in the flag and in the bytes, and one answer',
    prose: [
      'The colour probe has always had two 4:2:0 clips in it, the same sixteen patches encoded limited range and full range. The measurement that owns them reported that both came back at the same values and that the browser called both of them limited, concluded that the range path had never been exercised, and asked for a clip whose flag is verifiably in the bitstream and actually differs.',
      `It already was that clip. Read out of the decoder configuration the browser is handed, rather than off the command line that produced the file, one carries video_full_range_flag ${of(
        CLIP.tv,
        ['sps', 'video_full_range_flag'],
      ).toFixed(0)} and the other ${of(CLIP.pc, ['sps', 'video_full_range_flag']).toFixed(
        0,
      )}. The files are ${of(CLIP.tv, ['file_bytes']).toLocaleString('en-GB')} and ${of(CLIP.pc, [
        'file_bytes',
      ]).toLocaleString('en-GB')} bytes, so they are not one clip measured twice.`,
      `So two files that genuinely differ come back through the product’s own upload path within ${num(
        perRange,
        ['range', 'worst_between_the_two_codes', 'copyExternalImageToTexture'],
      ).toFixed(
        0,
      )} code of each other. That is not a measurement which failed to run. It is the answer for these two clips, and it went unread for four chapters because nothing in the harness had ever looked inside either file. What it is not is the answer for every clip, which is the section below.`,
    ],
    table: {
      columns: ['the same patches, encoded', 'limited range', 'full range'],
      rows: [
        row('the file, in bytes', (clip) => of(clip, ['file_bytes']).toLocaleString('en-GB')),
        row('video_full_range_flag, in the SPS', (clip) =>
          of(clip, ['sps', 'video_full_range_flag']).toFixed(0),
        ),
        row('luma a page reads back, at black', (clip) => of(clip, ['luma_at_the_greys', '0']).toFixed(0)),
        row('luma a page reads back, at white', (clip) => of(clip, ['luma_at_the_greys', '9']).toFixed(0)),
        row('what VideoFrame.colorSpace says', said),
        row('worst error, sRGB round trip', (clip) => `${of(clip, ['srgb_back', 'worst']).toFixed(0)} codes`),
      ],
    },
    caveat:
      'The luma row is not the clip, it is what a page can see of it. Stored, the full-range clip’s luma runs 0 to 255 where the other runs 16 to 235, which is what ffprobe reads out of either file. copyTo hands a page the same limited range for both, so the browser has applied the flag and normalised before a frame exists to look at. That reading was written to prove the two clips differ and cannot; the byte comparison in the row above it does that instead.',
    command: 'node tools/video-bench/run.mjs range',
  };
}

/** A difference in output codes, which is how every colour figure here reads. */
const inCodes = (value: number): string => `${value.toFixed(0)} code${Math.abs(value) === 1 ? '' : 's'}`;

function whichDecoder(perRange: unknown): Section {
  const rung = (size: string): number =>
    num(perRange, ['range', 'the_ladder', size, 'worst_against_its_twin']);
  const asked = (key: string): number =>
    num(perRange, ['range', 'which_decoder', key, 'worst_against_its_twin']);
  return {
    heading: 'The answer is not the same at every size, and the size is not the reason',
    prose: [
      `One pair of clips at one size cannot see this, and that is how it stayed open. On the 1920x1080 probes the flag is honoured and there is nothing to do. The same eight greys at 320x180 come back ${inCodes(
        rung('320x180'),
      )} from their limited-range twin, contrast-stretched exactly as a full-range payload read as limited would be. The probe that owns the colour contract is 1080p, and 1080p is on the working side of the line.`,
      `Four sizes put that line between 480x270 and 640x360 on this machine, which is a number about this machine. Asked directly, hardwareAcceleration says what it is really about: told to prefer hardware, a 320x180 full-range clip is ${inCodes(
        asked('320x180, prefer-hardware'),
      )} from its twin; told to prefer software, a 1280x720 one is ${inCodes(
        asked('1280x720, prefer-software'),
      )}. The hardware decoder honours the flag at every size and the software decoder ignores it at every size. Frame size only decides which one the browser picks.`,
      'That is worth having as a mechanism rather than as a threshold. Where the line falls belongs to this Mac and this build of Chrome; "the software decoder does not implement it" is a sentence somebody on other hardware can check, and it says why the boundary moves.',
    ],
    table: {
      columns: ['a full-range clip, against its limited-range twin', 'worst'],
      rows: [
        ...(['320x180', '480x270', '640x360', '1280x720'] as const).map((size) => [
          `${size}, whichever decoder the browser picks`,
          inCodes(rung(size)),
        ]),
        ['320x180, told to prefer hardware', inCodes(asked('320x180, prefer-hardware'))],
        ['1280x720, told to prefer software', inCodes(asked('1280x720, prefer-software'))],
      ],
    },
    caveat:
      'Every figure here is against the limited-range encode of the same picture and never against the source, because the GPU upload puts eleven codes into the midtones of any 4:2:0 frame whichever range it is. That is Chrome converting from the transfer the file declares, which on these clips is nothing at all defaulted to BT.709, and it is the page after this one. It has nothing to do with the flag either way, and two encodes of one picture cancel it and leave only what the flag decided.',
    command: 'node tools/video-bench/run.mjs range',
  };
}

function theMetadataIsNoHelp(perRange: unknown): Section {
  const of = (clip: string, path: readonly string[]): number =>
    num(perRange, ['range', 'clips', clip, ...path]);
  return {
    heading: 'And nothing in the frame says which of the two you got',
    prose: [
      `VideoFrame.colorSpace reports fullRange false on a full-range file, both where the decode was right and where it was wrong, so it is not a signal a page could branch on. Two more of that object\u2019s four fields are inventions rather than readings: both probes declare colour_primaries ${of(
        CLIP.pc,
        ['sps', 'colour_primaries'],
      ).toFixed(0)} and transfer_characteristics ${of(CLIP.pc, ['sps', 'transfer_characteristics']).toFixed(
        0,
      )} in their SPS, which is "unspecified" for both, and the browser reports bt709 for both. Only matrix_coefficients, at ${of(
        CLIP.pc,
        ['sps', 'matrix_coefficients'],
      ).toFixed(0)}, is a value anybody wrote down.`,
      'The flag itself is readable, out of the SPS in the avcC, which is how the rows above know the two clips differ. What is not readable is whether the decoder acted on it, and that is the one thing a correction would need. So what is left is a limit rather than a fix: a full-range clip small enough to land on the software decoder comes back contrast-stretched, and this product cannot tell that it did.',
      'It is a narrow limit and it is worth saying how narrow. Camera and phone footage is limited range; full range on H.264 is mostly screen recordings and synthetic output, and it has to be small as well. What it is not is invisible: thirteen codes across the whole picture is a contrast error somebody would see and would have no way to explain.',
    ],
    caveat:
      'Its own command and its own results file, sharing its clips, its patches and its upload path with the colour probe, which is the reason rather than an objection to it: that probe is inside the run that writes the results the decode ladder, the readback ladder and two ONNX timings are read from. Adding a row there by re-running it would re-date every one of them for a question none of them touches.',
    command: 'node tools/video-bench/run.mjs range',
  };
}

// --- whether the eleven codes are ours ---------------------------------------

/** A grey ramp out of the results, which is ten numbers rather than one. */
function ramp(source: unknown, path: readonly string[]): readonly number[] {
  const value = at(source, path);
  if (!Array.isArray(value)) throw new Error(`research: ${path.join(' / ')} is not a ramp`);
  return value.map((entry: unknown) => {
    if (typeof entry !== 'number') throw new Error(`research: ${path.join(' / ')} holds a non-number`);
    return entry;
  });
}

const HONEST = 'probe-trc709-709';

function theTagDecidesIt(declared: unknown): Section {
  const stated = (clip: string): number =>
    num(declared, ['transfer', 'the_transfer_reaches_the_bitstream', clip]);
  const drawn = (label: string): number => num(declared, ['transfer', 'the_tag_decides_it', label]);
  return {
    heading: 'The eleven codes are the transfer the file declares, and no probe here declared one',
    prose: [
      'A decoded frame comes back eleven codes out in the midtones on the way to the GPU, which the page before this measured and attributed to the browser. It is the browser, and it is the browser doing what it was told: every clip this project has ever encoded declares transfer_characteristics 2, "unspecified", which Chrome defaults to BT.709, and the values inside them are sRGB. The probes have been asking a reader to convert a picture that was already converted.',
      'So the same sixteen patches were encoded three more times, differing only in what the file says about itself. The content and the encode are identical; the declaration is the variable, and the answer follows it.',
      `Told sRGB, the upload converts nothing and the patches come back ${inCodes(
        drawn('says sRGB, and is sRGB'),
      )} from what was drawn, which is the 4:2:0 encode's own rounding. Told BT.709 it converts, by ${inCodes(
        drawn('says bt709, and is sRGB'),
      )}. Told nothing it converts by exactly as much, which is a default behaving as a default rather than an accident. The 2D canvas returns the patches unchanged in all three, so it is right in precisely the two cases where the file is wrong.`,
    ],
    table: {
      columns: [
        'the same sixteen patches, encoded',
        'transfer_characteristics',
        'uploaded, worst from what was drawn',
      ],
      rows: [
        ['says sRGB', stated('probe-trcsrgb-srgb').toFixed(0), inCodes(drawn('says sRGB, and is sRGB'))],
        ['says BT.709', stated('probe-trc709-srgb').toFixed(0), inCodes(drawn('says bt709, and is sRGB'))],
        [
          'says nothing, which is every older probe',
          stated('probe-420-tv').toFixed(0),
          inCodes(drawn('says nothing, and is sRGB')),
        ],
      ],
    },
    caveat:
      'The transfer goes into these three through -x264-params rather than through -color_trc, because -color_trc is what make-clips.sh has always passed and it does not reach the bitstream. What each file ended up declaring is read back out of the SPS in the decoder configuration the browser is handed, by the parser measurement 16 already checked against ffmpeg -bsf:v trace_headers on all six colour fields.',
    command: 'node tools/video-bench/run.mjs transfer',
  };
}

function whatAnHonestClipDoes(declared: unknown): Section {
  const row = (label: string, path: readonly string[]): readonly string[] => [
    label,
    ...ramp(declared, path).map((value) => value.toFixed(0)),
  ];
  const uploaded = 'copyExternalImageToTexture';
  const canvas = 'drawImage, then copyExternalImageToTexture';
  const stat = (which: string, part: string): number =>
    num(declared, ['transfer', 'on_a_clip_that_means_what_it_says', which, part]);
  return {
    heading: 'And on a clip that means what it says, the two answers are not close',
    prose: [
      'The clip that settles it says BT.709 and is BT.709: the same patches taken into linear light and back out through the BT.709 curve, so what is stored is darker than the sRGB it was drawn from and a correct reader puts it back. ffmpeg is the control, because "correct" needs somebody who is not the browser, and it comes back at what was drawn to within a code. That is the check that the probe is honest, before anything is concluded from it.',
      `Against that reading, the upload this product already does is within a code from mid grey up and walks away below it: ${inCodes(
        stat(uploaded, 'worst'),
      )} at worst, at the patch drawn as 32. What it applies behaves like a pure power where BT.709 has a linear toe, so what is left of the error is entirely in the shadows.`,
      `A 2D canvas applies nothing, which this clip needed, so it is out across the whole ramp. The worst says the two paths are the same answer, ${inCodes(
        stat(uploaded, 'worst'),
      )} against ${inCodes(
        stat(canvas, 'worst'),
      )}, and the worst is the wrong statistic: the median of the ramp is ${inCodes(
        stat(uploaded, 'median_of_the_ramp'),
      )} for the upload and ${inCodes(stat(canvas, 'median_of_the_ramp'))} for the canvas.`,
    ],
    table: {
      columns: ['the grey ramp', '0', '16', '32', '64', '96', '128', '160', '192', '235', '255'],
      rows: [
        row('what was drawn', ['transfer', 'what_was_drawn']),
        row('stored in the file, read by ffmpeg', ['transfer', 'clips', HONEST, 'ffmpeg', 'as_stored']),
        row('ffmpeg, converted to an sRGB transfer', [
          'transfer',
          'clips',
          HONEST,
          'ffmpeg',
          'converted_to_srgb',
        ]),
        row('copyExternalImageToTexture', ['transfer', 'clips', HONEST, 'paths', uploaded, 'ramp']),
        row('drawImage, then the same copy', ['transfer', 'clips', HONEST, 'paths', canvas, 'ramp']),
      ],
    },
    caveat:
      'The columns are what the patches were drawn as, so the first row is the header repeated on purpose: it is the answer a correct reader gives, and every row under it is a distance from it. importExternalTexture answers identically to copyExternalImageToTexture on all four clips and is left out of the table rather than duplicating it.',
    command: 'node tools/video-bench/run.mjs transfer',
  };
}

function theHardwareDecoderAgain(declared: unknown): Section {
  const rung = (key: string): { format: string; converted: string } => ({
    format: text(declared, ['transfer', 'which_decoder', key, 'format']),
    converted: flag(declared, ['transfer', 'which_decoder', key, 'converted']) ? 'yes' : 'no',
  });
  const row = (label: string, key: string): readonly string[] => {
    const value = rung(key);
    return [label, value.format, value.converted];
  };
  return {
    heading: 'And it belongs to the hardware decoder, which is the same pair of decoders again',
    prose: [
      'The page before this found that this browser has two H.264 decoders, that frame size picks one, and that only one of them applies the range flag. This is the same pair disagreeing about a second thing: asked of the one clip where converting and not converting look different, the software decoder converts nothing. So the eleven codes and the thirteen are two independent ways for one browser to answer a colour question twice.',
      'It also closes the other half of what the decode page said. That page attributes the conversion to the NV12 path rather than the I444 one, which is true and is not the reason. Asked to decode the 4:4:4 probe on the hardware decoder, the browser answers that the configuration is only supported by the software decoder. The 4:4:4 probe was never converted because there was no hardware decoder that could have converted it.',
    ],
    table: {
      columns: ['the clip that says BT.709 and is BT.709, decoded by', 'the frame', 'converted'],
      rows: [
        row('whichever decoder the browser picks', `${HONEST}, no-preference`),
        row('told to prefer hardware', `${HONEST}, prefer-hardware`),
        row('told to prefer software', `${HONEST}, prefer-software`),
        row('the 4:4:4 probe, either way', 'probe-444-lossless, no-preference'),
      ],
    },
    caveat:
      'The two decoders hand back different pixel formats, NV12 from one and I420 from the other on the same file, which is a readable difference where VideoFrame.colorSpace has none. It is still not the signal the range measurement wanted. It is a fact about this platform rather than anything the specification promises, and it names a chroma layout rather than a decoder, so correcting colour from it would be reading one thing in order to learn another and would be silently wrong on the first machine whose software decoder hands back NV12.',
    command: 'node tools/video-bench/run.mjs transfer',
  };
}

function whatACanvasWouldCost(declared: unknown): Section {
  const median = (label: string): number => num(declared, ['transfer', 'cost_ms', label, 'median']);
  const added = num(declared, ['transfer', 'cost_ms', 'added_by_the_canvas']);
  return {
    heading: 'And what the other answer would cost per frame',
    prose: [
      'The canvas reading above is getImageData, which brings twelve megabytes back through system memory a frame and is a reading rather than a design. The version somebody would ship draws the frame into a canvas and uploads the canvas, and returns the same values, so the price and the picture are answered about one piece of code.',
      `That is ${ms(added)} a frame at 1080p, taken as a difference between two rows of one run rather than between two runs, because the direct copy is the noisiest thing in this table on this machine. Against the 5.0 ms a 1080p export frame costs it is a quarter again; against the 33 ms a playing frame has it is nothing.`,
      'It is also almost exactly the 1.4 ms the export ladder prices for the readback path and rejects, and it is a worse trade than that one was. The readback bought nothing. This buys the wrong answer on any clip that declares its transfer honestly, which is all real footage, in exchange for the right one on probes that declare nothing, which is only ever this repository.',
    ],
    table: {
      columns: ['1920×1080, per frame, fenced', 'median'],
      rows: [
        [
          'copyExternalImageToTexture, which is what the product does',
          ms(median('copyExternalImageToTexture')),
        ],
        ['drawImage into a 2D canvas', ms(median('drawImage'))],
        [
          'drawImage, then copyExternalImageToTexture from the canvas',
          ms(median('drawImage, then copyExternalImageToTexture')),
        ],
        ['what the canvas adds', ms(added)],
      ],
    },
    caveat:
      'Timed on the decode clip rather than on a probe, so the first row is the same call the decode page reports and this table can be read against it. A flat probe is not a fair thing to time an upload with. Its own command and its own results file, sharing its patches and its upload path with the colour probe and its pair of decoders with the range ladder, which is the argument for a file of its own rather than against one: the colour probe sits in the run that writes the decode ladder, the readback ladder and two ONNX timings, and the range ladder owns a finding two documents quote.',
    command: 'node tools/video-bench/run.mjs transfer',
  };
}

// --- entries ----------------------------------------------------------------

/**
 * Every results file the pages read, as one value rather than as an argument
 * each.
 *
 * Four harnesses now write six files between them, and a positional list of
 * them is a shape where adding a measurement edits three call sites and where
 * two `unknown`s can be swapped without the compiler noticing.
 */
/**
 * What the perception layer computed and dropped, and where the one fact that
 * mattered ended up.
 *
 * Three sections, and the first one carries no table on purpose: it is the
 * shape of a code path rather than a quantity, and a page that put a number
 * under it would be dressing an argument as a measurement.
 */
export interface Results {
  readonly style: unknown;
  readonly real: unknown;
  readonly video: unknown;
  /** The export ladder, apart from the rest of video-bench; see run.mjs. */
  readonly exported: unknown;
  readonly tracking: unknown;
  readonly tracked: unknown;
  readonly host: unknown;
  readonly shrink: unknown;
  readonly bundle: unknown;
  readonly log: unknown;
  readonly long: unknown;
  readonly sound: unknown;
  readonly still: unknown;
  readonly saved: unknown;
  readonly kept: unknown;
  /**
   * What one more optional field on a command costs, in its own file for the
   * reason the section that reads it gives.
   */
  readonly hidden: unknown;
  /**
   * Which of the figures about a tracked log are per run and which are per
   * object. Its own file because every one of the four it answers is quoted
   * from one of the three above, so an objects dimension added to any of them
   * re-takes a measurement this chapter did not change.
   */
  readonly perObject: unknown;
  /**
   * Whether a full-range clip needs a colour path of its own. Its own file
   * because it shares its clips and its patches with the colour probe, which
   * sits inside the run that writes results.json.
   */
  readonly perRange: unknown;
  /**
   * Whether the eleven codes a decoded frame picks up on the way to the GPU are
   * the browser's or the probe's. Its own file for the reason above and once
   * more: it is kept out of results-range.json as well, which owns a finding
   * two documents quote and would be re-dated by a question about a different
   * field of the same header.
   */
  readonly declared: unknown;
}

export function entries(results: Results): readonly Entry[] {
  const { style, real, video, exported, tracking, tracked, host, shrink, bundle, log, long, sound, still } =
    results;
  const { saved } = results;
  const { kept } = results;
  const { hidden } = results;
  const { perObject } = results;
  const { perRange } = results;
  const { declared } = results;
  return [
    {
      slug: 'the-look',
      results: 'tools/style-bench/results.json',
      title: 'Style timing and flicker',
      standfirst:
        'Comic, Poster and Print compared for render time, control cost and frame-to-frame stability.',
      harness: 'tools/style-bench',
      lede: [
        'Everything that decides whether a selection is correct was already built and measured. What was not settled was whether what comes out is worth looking at, and, on video, whether it stays worth looking at while it moves.',
        'Three things were unknown, each capable of forcing a different architecture. One of the three was answered backwards.',
      ],
      hero: {
        name: 'styles',
        // Read from the table below it rather than typed above it, because a
        // caption is exactly as capable of going stale as a cell is.
        caption: `One frame through each style at full quality: ${STYLES.map((name) =>
          ms(num(style, ['chain', '720p', `${name}, default`, 'full', 'median'])),
        ).join(', ')} at 720p respectively.`,
      },
      sections: [
        styleCost(style),
        detailCost(style),
        stability(style),
        perturbation(style),
        transitionFloor(),
        paletteFit(),
      ],
    },
    {
      slug: 'real-footage',
      results: 'tools/style-bench/results-real.json',
      title: 'Style tests on real footage',
      standfirst:
        'Synthetic scenes hid an outline problem. Six real images exposed it and changed the shader.',
      harness: 'tools/style-bench',
      lede: [
        'Everything on the page before this was measured against a scene drawn by a script, including the finding that decided per-frame stylisation was acceptable at all. This is that page again, with the picture changed and nothing else.',
        'Three things came back. The cost table does not depend on the content, which was expected to and was warned about. The comic chain is as steady on a photograph as it is on a drawing. And the poster chain, which the scene reports as the second steadiest of the three, amplified its input by five on a brick wall.',
        'That third one is why the poster style’s outline is a different operator now than it was when this page was first written. The tables below are taken after that change and say so where the old number is worth keeping.',
      ],
      sections: [
        realInputs(),
        realCost(real),
        realStability(real),
        realOutline(real),
        outlineAttempts(),
        realLightness(real),
      ],
    },
    {
      slug: 'the-detail-control',
      results: 'tools/style-bench/results-real.json',
      title: 'Comic detail response',
      standfirst:
        'High settings amplify changes between frames. Isolating the three moving parts traced the problem to the flatten stage.',
      harness: 'tools/style-bench',
      lede: [
        'One column of the table on the page before this had been in the repository across six pictures and nobody had read it. The comic chain’s amplification is not a number, it is a slope in the detail control, and the top of that slope is the only measured defect left in what this product actually draws.',
        'A control whose upper half is worse than its lower half is a control with a broken end, and this project has been here once before: the poster style’s outline came out of it with a different operator and a better picture. That finding does not transfer, which took a measurement to find out rather than an argument.',
      ],
      sections: [detailRows(real), filmStills(real), theFlatten(real)],
    },
    {
      slug: 'holding-still',
      results: 'tools/style-bench/results-motion.json',
      title: 'Frame-to-frame stability',
      standfirst:
        'The remaining flicker comes from one stage in Comic. Blending frames adds visible ghosts without fixing it.',
      harness: 'tools/style-bench',
      lede: [
        'Earlier chapters softened the individual decisions in each chain and the numbers moved a long way. What is left is the residue, and there were three stories about where it comes from: the input moves, a stage amplifies, or the decisions genuinely are per frame. They imply completely different features at completely different prices, and building the expensive one before finding out which dominates would have been this project’s first unforced error.',
        'So the measurement came first, and so did the thing that catches a cure being worse than the disease. Both are here. Between them they say the expensive answer solves a problem that does not exist, the cheap one lowers a number without touching what causes it, and the residue that is left is in one stage of one chain, where this project has already been once.',
      ],
      hero: {
        name: 'smear',
        caption:
          'Half of the last stylised frame blended into this one, with no motion compensation, and where the two differ. The rim around every moving car is the ghost the residue figure would have called an improvement.',
      },
      sections: [residueComesFrom(still), denoisingTheInput(still), theCounterMetric(still)],
    },
    {
      slug: 'video',
      results: 'tools/video-bench/results.json',
      title: 'Video decode and colour',
      standfirst:
        'Demux, decode, seek and upload timed across two keyframe layouts, followed by a direct check of the colour path.',
      harness: 'tools/video-bench',
      lede: [
        'Four things were unknown before video could be built, all of them capable of forcing a different design. These settled the shape of the frame provider and the colour contract; the model’s side of it is on its own page.',
      ],
      sections: [decode(video), upload(video), colour(video)],
    },
    {
      slug: 'full-range',
      results: 'tools/video-bench/results-range.json',
      title: 'Full-range H.264 decoding',
      standfirst: 'Hardware decode honours the range flag at 1080p. Software decode ignores it at 320×180.',
      harness: 'tools/video-bench',
      lede: [
        'A decoded frame needs no colour path of its own, which is measured, and there was one case the measurement could not reach: a clip tagged full range rather than limited. Both probes came back identical and the browser called both of them limited, so the conclusion written down was that the range path had never been exercised and that a better clip was needed.',
        'The clip was fine. What was missing was somebody reading the flag out of it, and what reading it turned up is that the reassuring answer was only half of one: the same picture at 320x180 is thirteen codes out where at 1080p it is exact, because this browser has two H.264 decoders and only one of them implements the flag.',
      ],
      sections: [theClipWasAlwaysRight(perRange), whichDecoder(perRange), theMetadataIsNoHelp(perRange)],
    },
    {
      slug: 'the-transfer',
      results: 'tools/video-bench/results-transfer.json',
      title: 'Video transfer metadata',
      standfirst:
        'The measured colour change was declared by the file, not introduced by decoding or the WebGPU path.',
      harness: 'tools/video-bench',
      lede: [
        'A decoded frame needs no colour path of its own, which is measured, and one thing was filed beside that finding as a cost of doing business: the midtones come back eleven codes out, said to be Chrome\u2019s and beyond correcting. Then the range measurement, asking something else, found the same VideoFrame drawn into a 2D canvas does not have them. So it was never the decode, and one path in this browser gets a different answer from the other about a picture neither of them touched.',
        'Which of them is right is not a question these probes could answer, because none of them says what it is. So three more were encoded that do, with ffmpeg as the control, and the answer is that the browser has been reading a declaration this project never wrote: the path the product already takes is the one that reads it, and the alternative costs a millisecond a frame to be wrong on every clip that means what it says.',
      ],
      sections: [
        theTagDecidesIt(declared),
        whatAnHonestClipDoes(declared),
        theHardwareDecoderAgain(declared),
        whatACanvasWouldCost(declared),
      ],
    },
    {
      slug: 'the-clip',
      results: 'tools/video-bench/results-export.json',
      title: 'Video export performance',
      standfirst:
        'Composite, encode, bitrate, container overhead and colour measured as one complete pipeline.',
      harness: 'tools/video-bench',
      lede: [
        'Export had only ever written one frame. Three things stood between that and a clip, all of them capable of forcing a different design: what an encoded frame costs when everything is in flight at once, what a container writer costs in bytes, and whether the colour contract survives being written back out.',
        'A fourth turned up on the way. A canvas is presented rather than read, so capturing one is a claim about when as much as about what, and being one frame out would be invisible in every timing number here.',
      ],
      sections: [
        pipeline(exported),
        clipThroughput(exported),
        rateControl(exported),
        encodeColour(exported),
        containerBytes(bundle),
      ],
    },
    {
      slug: 'a-long-clip',
      results: 'tools/video-bench/results-long-clip.json',
      title: 'Long video exports',
      standfirst:
        'Buffering the whole export fails as clips grow. Writing packets directly to a file keeps memory bounded.',
      harness: 'tools/video-bench',
      lede: [
        'The known limits page said a ten-minute clip export would be about a gigabyte and that there was no answer to that beyond failing. It named a consequence and measured nothing, and the two failures worth telling apart are a tab that dies and a tab that swaps for four minutes and finishes.',
        'So this drives the product’s own export loop over a source that hands the same clip round again, at the export’s own bitrate, for as long as it is asked for. One thing in it is not the product’s code, and it is the thing being compared against: the sink that shipped before this chapter, which held every encoded packet until the end and no longer exists to import.',
      ],
      sections: [heldCeiling(long), intoAFile(long), theBudget(long)],
    },
    {
      slug: 'sound',
      results: 'tools/video-bench/results-interleave.json',
      title: 'Audio interleaving',
      standfirst:
        'Copying encoded audio is cheap. Placing it beside the matching video packets is what keeps playback progressive.',
      harness: 'tools/video-bench',
      lede: [
        'What audio passthrough costs was never the question worth asking. Copying packets that are already encoded costs nothing and everybody knows it. What nobody here had measured is interleaving, and it decides whether the last chapter\u2019s central commitment was real: the index goes at the front so a file starts playing before it has finished arriving, and a second track is the first thing capable of undoing that without moving a single box.',
        'So this writes the same clip three ways and asks, for every second of it, how far away in the file the sound that plays with that second is. If the distance grows with the length of the clip, the file is not progressive whatever order the boxes are in.',
      ],
      sections: [theArrangements(sound), countingFirst(sound), whatItWillNotCarry(sound)],
    },
    {
      slug: 'the-document',
      results: 'tools/video-bench/results-document.json',
      title: 'Rotyl file size and replay',
      standfirst:
        'Save size, load time, replay cost and media identity measured for tracked edits that need to survive a tab.',
      harness: 'tools/video-bench',
      lede: [
        'Strokes rather than pixels have been the source of truth since the first chapter. Undo is a cursor into the log, export replays it rather than asking the app what applies, and a lost graphics device is survivable because the log belongs to the work and not to the device. Reloading the page threw all of it away.',
        'A photograph’s log is a handful of strokes and nobody needed a measurement for that. A tracked run is one command per frame per object with a mask on each, which the chapter before this one measured at 62 MB in memory for ten minutes of following one thing, and what happens to those 62 MB on the way to a disk is what decides whether saving is a file format or a paragraph in known limits.',
      ],
      sections: [documentCost(saved), documentShape(saved), documentReplay(saved), documentIdentity(saved)],
    },
    {
      slug: 'crash-recovery',
      results: 'tools/video-bench/results-recovery.json',
      title: 'Crash recovery performance',
      standfirst:
        'The edit journal now writes off the main thread, preserving unsaved work without making brush and tracking actions wait on storage.',
      harness: 'tools/video-bench',
      lede: [
        'The chapter before this one gave the command log a file and a button. What a button cannot do is protect the work between presses, and on a tracked run that is three quarters of a minute of following an object per press somebody did not make.',
        'Writing it down as it happens is the obvious answer and is exactly the kind of obviously cheap that has been wrong here before. Three things were measured before any of it was built, and two of them ruled out the version anybody would write first.',
      ],
      sections: [
        whereAJournalCanBeWritten(kept),
        whatAnEditCosts(kept),
        whyNotTheDocument(kept),
        comingBack(kept),
      ],
    },
    {
      slug: 'tracking',
      results: 'tools/edgetam-export/results.json',
      title: 'EdgeTAM tracking feasibility',
      standfirst:
        'Two missing graphs, model traffic, mask readback and command-log growth showed the feature could fit before implementation began.',
      harness: 'tools/video-bench, tools/edgetam-export',
      lede: [
        'Tracking does not exist yet. These are the numbers that say what it would cost and what shape it would have to take, taken before writing it rather than after.',
      ],
      sections: [
        trackedFrame(video),
        tracksWhat(tracking),
        pointers(tracking),
        download(video, shrink),
        commandLog(log),
        readback(video),
      ],
    },
    {
      slug: 'tracked-frame',
      results: 'tools/video-bench/results-tracked-frame.json',
      title: 'EdgeTAM tracking performance',
      standfirst:
        'The complete path added 45 ms beyond the four ONNX graphs. Host-side work explained the gap.',
      harness: 'tools/video-bench',
      lede: [
        'Every number this project has quoted about tracking was taken before a tracked frame existed: four graphs timed one at a time and added up. That was the honest thing to do and it was published saying so. This is the same question asked of the thing itself.',
        'It needs somewhere to fetch two graphs from, so unlike everything else here it is not part of a run anybody can take without setting one up. What it drives is the product’s own code and not a reimplementation of it, which is the only way the number is about the product.',
      ],
      sections: [trackedCost(tracked), trackedArithmetic(tracked)],
    },
    {
      slug: 'the-occlusion',
      results: 'tools/video-bench/results-occlusion.json',
      title: 'Occlusion handling',
      standfirst:
        'EdgeTAM knew which frames lost the object, but the command log discarded that answer. Carrying it costs 14 bytes per command.',
      harness: 'tools/video-bench',
      lede: [
        'Everything measured in this project so far has been about what it draws. This one is about what it knows and never says. Five things the perception layer computes reached nobody: the model’s own occlusion verdict, each candidate’s area, each candidate’s confidence, a store’s prompt points, and the result a completed tracking run hands back. Two of them are carried now. The verdict is a field on a command, which is what this page is mostly about, and the run’s own result is a sentence in the line a finished export already writes into. The other three are still dropped, on purpose and with the reason written down.',
        'What separates them is not how interesting they are. It is whether they are true of the tool or true of the document somebody has open. An occlusion is a numbered frame of this clip with no selection on it that somebody has to act on; a confidence score is the same thing on every file anybody ever opens. The first belongs in the editor. The second belongs on a page like this one, which is where it has stayed.',
      ],
      sections: [whatDied(), whatTheTimelineDrew(hidden), whatSayingSoCost(hidden)],
    },
    {
      slug: 'per-object',
      results: 'tools/video-bench/results-objects.json',
      title: 'Multi-object tracking costs',
      standfirst:
        'Four published figures assumed one object. Three grow with object count; one barely moves.',
      harness: 'tools/video-bench',
      lede: [
        'The feature that reached this was small: the command log had been recording which objects somebody pointed at since object selection landed, so a run follows one object per answer the selection is made of and there is no new gesture, no mode and no list to manage. What it did do is turn a constant into a variable, and four numbers in three documents were written when it was still a constant.',
        'None of the four is wrong. Each is still exactly true of one object, and not one of them says so, which leaves a reader holding a product that can multiply all four by however many things they clicked. Three of them move with N, one of them barely does, and one of the four is not a number at all.',
      ],
      sections: [fourFigures(perObject), foldsToN(perObject)],
    },
    {
      slug: 'the-host',
      results: 'tools/edgetam-export/host.json',
      title: 'EdgeTAM host validation',
      standfirst:
        'Reference inputs exposed errors in transposes, memory and prompting that still produced plausible masks.',
      harness: 'tools/edgetam-export',
      lede: [
        'The two graphs a tracker needs were exported and checked against the modules they came from. That leaves the other half of a tracked frame, which is host code: two published graphs either side of the exported pair, the transposes between four sessions, the bank’s layout, and the arithmetic the memory encoder is fed either side of it.',
        'None of that is in a graph and all of it fails silently. A transposed field, a bank that forgets the frame the user pointed at, a mask resampled the wrong way and a prompt that is nearly the right prompt all produce a plausible mask of roughly the right object. So none of it is judged by looking at one.',
      ],
      sections: [hostArithmetic(host), hostMistakes(host), hostEndToEnd(host)],
    },
    {
      slug: 'the-editor',
      results: 'tools/research/measurements.ts',
      title: 'Editing latency',
      standfirst:
        'Hand-timed interaction figures that guide product decisions but are not reproducible enough for the benchmark set.',
      harness: 'measured by hand, in a browser',
      lede: [
        'Nothing regenerates these and nothing notices if they drift. They are not less true than the rest, but a page that mixed them would be claiming a discipline it only has for half of what it shows.',
      ],
      sections: [
        {
          heading: 'Editing is the composite, not the style chain',
          prose: [
            'The style chain re-runs only when a style control changes, never while brushing, which is why these two rows are the numbers that decide how the tool feels. A brush stroke is one pass over the output; a stamp is one pass over the mask.',
          ],
          table: {
            columns: ['', '2 MP', '12 MP', '24 MP'],
            rows: [
              ['brush stroke (composite)', '1.0 ms', '2.0 ms', '3.1 ms'],
              ['brush stamp into the mask', '1.0 ms', '0.9 ms', '1.1 ms'],
            ],
          },
        },
        {
          heading: 'Object selection, once the model is loaded',
          prose: [
            'Reading the frame is expensive and happens once; answering "which object is under this point" is cheap and happens per click. A click is flat in image size because the model always works at 1024 px square. Only building that input scales with the photograph.',
          ],
          table: {
            columns: ['', '1 MP', '24 MP'],
            rows: [
              ['reading the frame (once)', '19 ms', '43 ms'],
              ['a click, model plus composite', '12 ms', '13 ms'],
            ],
          },
        },
        {
          heading: 'What ships',
          prose: [
            'Three runtime dependencies, all but the framework code-split, so what a session downloads depends on what it opens. A photograph fetches the application and the fonts and nothing else.',
            'Shaders reach the bundle as strings and this codebase comments them as heavily as its TypeScript, so a build-time transform removes the comments and keeps every newline, which is why adding a third style made the bundle smaller rather than larger.',
          ],
          table: {
            columns: ['gzipped', 'size', 'fetched'],
            rows: [
              ['application', '50.7 KB', 'always'],
              ['subset fonts', '31 KB', 'always'],
              ['inference runtime', '36.2 KB', 'first object click'],
              ['demuxer', '42.2 KB', 'first video'],
              ['container writer', '33.5 KB', 'first clip export'],
              ['saved by stripping shader comments', '17 KB', ''],
            ],
          },
        },
      ],
    },
  ];
}

/** What the results say they were taken on, rather than what anyone remembers. */
export function hardware(video: unknown): string {
  const agent = text(video, ['adapter', 'userAgent']);
  const chrome = /Chrome\/(\d+)/.exec(agent)?.[1] ?? 'an unknown build';
  const vendor = text(video, ['adapter', 'vendor']);
  const architecture = text(video, ['adapter', 'architecture']);
  return `an Apple M3 Pro, Chrome ${chrome}, adapter ${vendor} / ${architecture}`;
}
