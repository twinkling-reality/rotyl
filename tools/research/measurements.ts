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
    kind: 'audit',
    scope: 'The public Rotyl origin and the deployed artifact recorded on the measurement date.',
    repeatability: 'Automated; requires network access to the live origin.',
    harness: 'tools/launch-check',
    taken: `Anonymous HTTPS from Node ${text(launch, ['environment', 'node'])}`,
    lede: [
      'This audit checks the deployed artifact rather than inferring production state from a local build. It inspects the Sites output and requests the canonical hostname without credentials or redirect following.',
      `The recorded deployment uses ${direct ? 'one direct HTTPS origin' : 'an origin that is not direct'} for application code and the independently versioned ${text(launch, ['model_release'])} model release. The audit stores public response metadata, file sizes and derived digests only.`,
    ],
    sections: [
      {
        heading: 'Deployment artifact inventory',
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
        heading: 'Cache policy by asset type',
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
        heading: 'Model integrity after deployment',
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
    kind: 'benchmark',
    scope: 'Rotyl model assets, the current manifest and the current cache policy.',
    repeatability: 'Automated; rebuilds the model artifact and verifies its digests.',
    harness: 'tools/model-assets',
    taken: `${text(models, ['environment', 'cpu'])}, ${text(models, ['environment', 'platform'])}/${text(models, ['environment', 'architecture'])}, OS version not recorded, Node ${text(models, ['environment', 'node'])}`,
    lede: [
      'The earlier delivery path fetched selection graphs from a third-party host and relied on locally supplied tracking files. That allowed a successful application build to omit tracking or to load a different model release at runtime.',
      'The current manifest pins the upstream revisions, byte lengths and SHA-256 digests. The build vendors the complete release, and the browser verifies the same digest before passing any model to ONNX Runtime.',
    ],
    sections: [
      {
        heading: 'Model files do not delay the first render',
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
        heading: 'Download, cache and decompression costs',
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
        heading: 'Feature-specific model fetching',
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
        heading: 'Verification at build and runtime',
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
        heading: 'Clean-clone failure behaviour',
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
    kind: 'benchmark',
    scope: 'The Rotyl shader suite on the recorded local machine and runtime.',
    repeatability: 'Automated; the recorded study runs 32 complete suites.',
    harness: 'tools/ci-bench',
    taken: `${text(ci, ['environment', 'cpu'])}, ${text(ci, ['environment', 'platform'])}/${text(ci, ['environment', 'architecture'])}, OS version not recorded, Node ${text(ci, ['environment', 'node'])}`,
    lede: [
      'Dawn’s Node binding sometimes exited after all assertions passed and sometimes before a shader file finished. Treating every nonzero exit as a test failure produced false failures; rerunning a failed assertion would have hidden real defects.',
      'The harness records Vitest’s assertion report separately from the process exit. The gate can therefore distinguish a failed assertion, a missing report, an incomplete file and a teardown failure after completed work.',
    ],
    sections: [
      {
        heading: 'Native exit codes overstate failures',
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
        heading: 'Retry scope and residual risk',
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
    kind: 'benchmark',
    scope: 'The named GitHub macOS runner images, Chrome build and Rotyl shader suite.',
    repeatability: 'Automated in GitHub Actions; runner images may change over time.',
    harness: 'tools/ci-bench',
    taken: `${text(browser, ['environment', 'cpu'])}, ${text(browser, ['environment', 'image_os'])} image ${text(browser, ['environment', 'image_version'])}, Node ${text(browser, ['environment', 'node'])}`,
    lede: [
      'The local retry policy did not transfer to GitHub’s macOS runners. The hosted study tested the complete native suite and a process-isolated variant on each named runner shape.',
      'Neither native arrangement completed reliably. The same WGSL assertions completed in installed Chrome when the browser owned Dawn’s lifetime, so the required hosted gate moved to that path.',
    ],
    sections: [
      {
        heading: 'Native runner completion',
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
        heading: 'Larger runner comparison',
        prose: [
          `The GPU larger Mac completed ${ratio(native.xlarge, 'isolated')} isolated processes, against ${ratio(native.standard, 'isolated')} on the standard virtual Mac and ${ratio(native.intel, 'isolated')} on Intel. Paying for a runner advertised with GPU acceleration does not change who owns the native binding’s teardown, and did not buy a usable gate.`,
          'This is why CI does not select a more expensive machine and does not hide the result behind a larger retry budget. Both approaches preserve the failure boundary the measurement identified.',
        ],
        command: 'node tools/ci-bench/hosted.mjs --cycles 16',
      },
      {
        heading: 'Browser-owned Dawn stability',
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
        heading: 'Required workflow and failure policy',
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
    heading: 'Style-chain render cost',
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
    heading: 'Detail and quality-tier cost',
    prose: [
      `Turning detail up makes the comic chain ${faster('720p')} times faster at 720p, and a draft frame there is the same render as an export. Both of those sound like bugs and are consequences of one decision.`,
      'Each stage declares the apparent scale it wants and derives its own resolution to hold it. When the picture cannot supply that resolution, the kernel shrinks rather than the fraction drifting. Cost falls, and the tiers converge.',
      'The flatten reaches that bound sooner because it is held a factor of root two below the frame. Its downsample provides the chain’s grain rejection, while a full-size buffer does not downsample. The current 720p and two-megapixel columns include that change.',
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
    heading: 'Synthetic clip stability',
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
      'Measured in output codes over consecutive decoded frames of a fixed camera and scene. Differences are limited to grain and encoder noise. Mean change hides a small population of pixels moving a long distance, so the upper-percentile columns carry more weight. The separate real-image study checks whether the synthetic scene represents photographic texture.',
    command: 'node tools/style-bench/run.mjs clips',
  };
}

function perturbation(style: unknown): Section {
  const p99 = (sigma: string, name: string): string =>
    `${num(style, ['perturbation', sigma, name, 'p99']).toFixed(0)} codes`;
  return {
    heading: 'Codec-free perturbation control',
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
    heading: 'Transition floors for hard decisions',
    prose: [
      'Hard thresholds against fixed fields cause the measured instability. Halftone dots and unfiltered quantisation are examples. The first Poster implementation measured five to ten times worse than Comic on a fixed camera.',
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
      'Taken during development by rerunning the clip measurement against each version. The last row comes from the current results; reproducing the first two requires an earlier revision. The fix has no measurable cost and widens the transition only where the picture has no edge to sharpen. It cannot fix the Poster outline because that stage compared a neighbouring quantised colour and had no derivative to floor. Real-image testing led to a different outline operator.',
  };
}

function paletteFit(): Section {
  return {
    heading: 'Per-frame palette fitting',
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
    heading: 'Source-media controls',
    prose: [
      'The synthetic fixture cannot reproduce photographic texture statistics. This study therefore repeats the cost and stability measurements on images captured by cameras.',
      'The source media is fetched from fixed URLs and verified by SHA-256 before any derived input is created. A changed file fails the run instead of silently changing the benchmark.',
      'The sample contains the synthetic control, four photographs processed with the same clip recipe, and two stream-copied film shots. The photographs isolate image content; the film shots add sensor grain, codec noise and subject motion.',
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
    heading: 'Content sensitivity in render cost',
    prose: [
      'The expected result was higher Comic cost on strongly directional architecture than on isotropic foliage. The anisotropic Kuwahara sample bound grows with local anisotropy, so the original synthetic scene was treated as a hard case rather than a typical frame.',
      `The prediction does not appear. Foliage is the dearest of the four photographs and a brick wall is not, which is the ordering backwards. What does appear is a smaller effect running the other way: the portrait is the cheapest of the five, ${cheaper(
        'portrait',
      )} below the scene, and large out-of-focus areas are exactly where anisotropy is low.`,
      `The synthetic scene is atypical, but the effect is small. All five inputs sit inside a band ${band}% wide: the ${cheapest} is ${cheaper(
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
    heading: 'Real-image stability results',
    prose: [
      'Half of the original finding survived a photograph untouched. The comic chain really is steadier than its input, on a photograph as on a drawing, which is the part that was surprising and the part the design leans on.',
      'Poster failed the real-image control. The original outline amplified changes by 5.7 on brick and 4.9 on foliage, while the synthetic scene reported attenuation by a factor of two. The current table follows the operator replacement and reports 1.36 on the brick wall.',
      'The two rows that are not fixed cameras are read differently and are here for a different reason. An actor moving is a large honest change and it lands in the source column, so the ratio is the only thing those rows can say. What they said before the change was that the poster chain was four times its input on real footage while the other two were near one; what they say now is that all three sit between one and two.',
      'The Comic column reports the middle of the Detail control. Measurements across all three settings show a rising amplification curve, which the Comic detail investigation attributes to the flatten stage.',
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
    heading: 'Poster outline failure mechanism',
    prose: [
      'With the codec, the camera and the subject all taken out, the same result appeared and it had one cause. One picture is rendered twice with grain of a known size added the second time, so what is measured is the style and nothing else. On the wall a perturbation whose 99th percentile is six codes came out the far side at seventy-eight. Turned the outline off and it came out at eight.',
      'The outline compared each quantised colour with another one sample away. An infinitesimal change can move a rounded value across a complete band, shifting the comparison by one fifth of the Oklab range. That crosses the line threshold and produces a full-weight stroke. The synthetic scene contains large flat regions and few values near band edges; brick contains many such marginal boundaries.',
      'The quantiser contributed flicker without improving the outline. Pixels on opposite sides of a band returned a full-band difference regardless of their source distance, turning faint boundaries into dotted strokes. The current outline measures flattened colour directly and ramps the stroke weight to the threshold. The corrected row measures fifteen codes against a floor of eight.',
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
    heading: 'Rejected outline adjustments',
    prose: [
      'The old outline compared two quantised colours and thresholded the distance between them, so there were exactly two hard decisions in it and each could be softened independently. All four combinations were measured against the worst picture, and the useful result is the one that says none of them works.',
      'Softening the neighbour probe buys about a fifth and costs the look, because a soft probe reduces the distance at a genuine boundary as much as it reduces the noise at a marginal one. Centring the threshold’s transition rather than opening at it is free and buys nothing on its own. The two together get within three times of the floor and no closer, and the floor is the same picture with the outline switched off.',
      'The failure cannot be tuned away because the threshold input is a discrete distance between rounded colours. A hard probe offers too few values for transition width to help; a soft probe moves signal and noise together. The replacement reads flattened colour directly, making stroke strength continuous while preserving region boundaries from the bilateral result.',
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
      'The perturbation was rerun during development for each version. Five historical rows require an earlier revision; the last two come from the current results. Each candidate was also compared visually by differencing renders of the reference scene. The shipping operator changes 7.8% of that scene by more than eight codes, concentrated where the old operator followed the quantiser grid instead of image boundaries.',
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
    heading: 'Detail-response curve',
    prose: [
      'The middle Comic setting hides the shape of the response. Across detail 0, 0.5 and 1, amplification rises on every input and crosses above one at the top of the control.',
      'Before the current flatten bound, the brick wall measured 0.63, 0.88 and 2.00 across the three settings; the exterior film shot measured 1.40, 1.80 and 2.28. The current table records the corrected implementation. Reproducing the earlier values requires the earlier revision.',
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
    heading: 'Motion and shader amplification',
    prose: [
      'The film shots also amplify at detail 0, where the flatten is widest, while the photographs do not. That difference requires separating subject motion from the shader response before attributing both findings to one mechanism.',
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
      )} as a clip, so its figure is dominated by the actors rather than the chain. Combining those results had obscured two separate mechanisms.`,
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
    heading: 'Flatten-scale intervention',
    prose: [
      'Detail changes the flatten’s apparent scale, the ink’s apparent scale and tau, the local-lightness term in the difference-of-Gaussians decision. Each quantity was held at its detail-0 value while the production chain was rerun. This intervention attributes the result without replacing the shader under test.',
      'The sector weighting is the amplifier, and it is the amplifier at every setting rather than only at the top. Take it out, so that the eight sectors are averaged rather than chosen between, and a brick wall goes from 29 codes out of 6 to 8 and the film’s exterior from 17 to 5, at detail 1, and the wall’s detail-0 figure goes from 7 to 1. It cannot be taken out: an anisotropic Kuwahara that does not choose its sector is a blur, and the choosing is what makes this style painterly rather than smooth.',
      'A floor under the apparent scale, which is what known limits implied, is not the answer. Measured at four values it takes the wall from 29 down to 9 and takes the film’s exterior from 17 UP to 22 on the way, in the same run, because a wider ellipse spans more structure and a sector that flips then costs more codes. There is no radius that is right for both pictures, which is the honest reason the control exists.',
      'The downsample is the consistent intervention. The flatten buffer targets a radius near eight pixels; at detail 1 the derivation requests 1,356 pixels from a 720-pixel frame. Clamping to full frame size turns the box downsample into a copy and removes the chain’s only grain reduction before sector selection. Bounding the buffer by a factor of root two restores averaging at every setting, preserves apparent scale and lowers cost.',
    ],
    figure: {
      name: 'detail',
      caption:
        'The current Detail control at both ends and its default, rendered through the production compositor.',
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
      'Eight historical rows require an earlier revision; the shipping row is read from the current results. Two candidates were rejected on visual evidence rather than the primary metric. Holding tau removed window contours at detail 1 and changed 5.8% of the reference scene. A factor-of-two flatten bound changed 9.0% at detail 1 and 1.2% at detail 0. The shipping root-two bound changes 4.7% at detail 1, 1.5% at the default and no pixels at detail 0. It reduces mean gradient magnitude by 6.9% at detail 1 and 1.0% at the default, while reducing amplification by one quarter on the wall and one half on the film shot.',
    command: 'node tools/style-bench/run.mjs real-perturbation',
  };
}

function realLightness(real: unknown): Section {
  const of = (picture: string, key: string): string =>
    num(real, ['real-lightness', 'pictures', picture, key]).toFixed(3);
  const palette = (name: string, key: string): string =>
    num(real, ['real-lightness', 'palettes', name, key]).toFixed(3);
  return {
    heading: 'Palette range on photographs',
    prose: [
      'Real photographs support the palette-fitting decision. The synthetic scene was designed with a narrow, hazy lightness range and cannot validate a stage intended to correct that property.',
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
    heading: 'Decode and seek latency',
    prose: [
      'The next frame costs 0.46 ms. A seek costs 12 ms, or 88 on the same content encoded with one keyframe instead of thirty.',
      'There is no such thing as decoding frame N. There is decoding from the keyframe at or before N and discarding what comes between, so the cost of a scrub is set by keyframe spacing and by nothing else.',
      'The result sets a design constraint: forward scrubbing keeps one decoder open and feeds it sequentially. Rotyl starts a new decode only for backward or distant jumps.',
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
    heading: 'GPU upload cost',
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
    heading: 'Colour reconstruction',
    prose: [
      'A video frame belongs in the same source texture a photograph does, sampled through the same sRGB view. Nothing downstream needed a special case, and the colour contract survived video with no shader changes at all.',
      'Both ways of being wrong here are silent, so it was measured rather than assumed: sixteen flat patches with known sRGB bytes, encoded to H.264 and brought back. What an external texture samples turns out to be sRGB-encoded, exactly like the bytes of a decoded image.',
      'Writing it through an sRGB view instead encodes it twice. The second row is what that costs, and it is the kind of mistake that is obvious in a measurement and invisible in a review.',
      'The 4:2:0 column uses the limited-range clip. A separate range-flag investigation confirms that the full-range clip needs no additional colour path and that its flag was present in the bitstream.',
      'The eleven-code difference comes from Chrome applying the default transfer function to clips whose metadata is unspecified. The transfer-metadata investigation changes the attribution, not this table. For correctly tagged footage, the GPU upload path applies the declared transfer.',
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
    heading: 'Projected tracking throughput',
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
    heading: 'GPU readback cost',
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
    heading: 'Tracking under occlusion, blur and lighting change',
    prose: [
      'The original verification clip showed similar objects on converging paths but omitted occlusion, motion blur and lighting change. Those are the conditions a memory bank is intended to address, so the fixture did not test the claim adequately.',
      'The extended fixture changes each condition independently while preserving the paths and seed. The tracker keeps the correct object in every case. Motion blur lowers IoU by seven points because the visible boundary is ambiguous, not because identity switches.',
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
    heading: 'Object pointers and reacquisition',
    prose: [
      'The published mask decoder does not expose `object_pointer`, the token that carries an object’s identity between frames, so an implementation either re-exports the decoder or goes without. Measured on the old fixture, going without cost nothing, and that result was published with a warning attached to it: pointers exist for re-identification after occlusion, and the fixture had none. It has one now, the decoder has been re-exported, and both halves of that warning turned out to be right.',
      'With an occlusion in the clip the cost appears, and it is exactly where the warning said it would be. It is not a swap and it is not drift: without pointers the tracker produces no mask at all on the frame the object comes back on, and finds it again some frames later. The occlusion is eight frames long, which is more than the seven a memory bank holds, so by the time the object returns nothing in that bank has ever seen it and re-identification is the only thing that could work.',
      'Averages obscure the reacquisition delay. Worst IoU over whole frames is slightly higher without pointers because a run that skips the hardest frame is not scored on it. Increasing the occlusion from three hidden frames to eight raises both delays without changing their gap: pointers recover one frame in either case. That frame contains only a five-percent sliver of the object, so its mask is poor under both configurations. The earlier re-entry remains visible in exported footage and justifies the decoder export.',
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
    heading: `End-to-end tracking at ${String(perSecond)} frames per second`,
    prose: [
      'The figure this project designed tracking around was summed from four graphs measured separately, and published saying plainly that nothing had been run end to end because there was nothing to run. There is now, so this drives the product’s own code: the two engines it loads, the scene it walks, the loop it runs, writing into a real command log.',
      'The conclusion survives and gets firmer. Playback is thirty frames a second and this is seven, so tracking is a job, the playhead is free to ignore it, and no amount of tidying makes it a render-loop activity.',
      'Frame size does not enter into it, exactly as predicted: the vision encoder always works at 1024 square, and 720p and 1080p differ by two tenths of a millisecond.',
      'The two-object row measures a production path. A selection containing two model answers creates two tracked objects, and the command log records one advance for each. The additional cost is a second advance within the same frame.',
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
      'The split is derived because timers at the two API seams do not sum to a frame. The segmentation engine requests GPU-buffer outputs and returns before GPU completion, so downstream access absorbs part of the work. A second object adds one advance without another read. The difference between one-object and two-object runs isolates advance cost; the remainder is the fenced read.',
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
    heading: 'Host-side latency',
    prose: [
      'Five passes over a million elements of JavaScript run per tracked object, and not one of them is a model, which is exactly why none of them was in the sum. With the three graphs an advance is 38 plus 19 plus 13, which is 70; plus these and a four-megabyte readback of the conditioned map it is 91, to within the noise.',
      'The graph sum was accurate but incomplete. Host arithmetic accounts for roughly one third of the complete frame. A cost model built only from the expensive components is therefore a lower bound.',
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
    heading: 'Host-stage agreement with the reference',
    prose: [
      'Two graphs of a tracked frame were exported here and verified against the modules they came from. The other half of a tracked frame is not in any graph: it is two published graphs either side of them, four transposes between four sessions, the layout of the memory bank and the arithmetic the memory encoder is fed. All of it is host code, and every one of those fails by producing a plausible mask of roughly the right object rather than by producing an error.',
      'Each host stage runs on the reference implementation’s inputs and is compared with the corresponding reference output. Teacher forcing is intentional: a free-running tracker diverges slightly on each frame, which would blur the source of later errors.',
      'The first validation run found three host errors. Two remain in the historical comparison below. The corrected bank layout now matches all 233,472 reference floats on every frame of every test clip.',
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
      'Differences above the mask decoder come from graph precision rather than host arithmetic. The published vision encoder agrees with the reference to about 2e-5 on feature values up to 2.5. Pure layout permutations match exactly.',
    command: 'python tools/edgetam-export/host.py --sweep',
  };
}

function hostMistakes(host: unknown): Section {
  const row = (label: string, stage: string): readonly string[] => [
    label,
    absoluteError(worstStage(host, stage)),
  ];
  return {
    heading: 'Plausible masks from invalid host inputs',
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
      'The second error affects a field whose valid memory-encoder range is −10 to 10. An error of twenty spans the complete range along every mask edge. Neither defect produces an exception, warning or obviously invalid picture, so intermediate reference comparisons are required.',
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
    heading: 'Tracking fixture requirements',
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
    heading: 'Model compression and traffic',
    prose: [
      'The expensive graph exports at 69.6 MB and holds 11.8 MB of weights. Everything else is rotary tables, which the tracer captures once per layer and once per attention block because the module that produces them takes no inputs and can therefore be traced away. Turning constant folding off does not help: they are not folded, they are traced.',
      `Where they sit is the reason the obvious pass finds nothing. They are not initializers. They are ${hoisted.toFixed(
        0,
      )} Constant NODES, each carrying its own copy in an attribute, so a sweep over the graph's initializers reports no duplication at all. Hoisting them into initializers first, then sharing the ones whose bytes match, removes ${copies.toFixed(
        0,
      )} copies and ${duplicated.toFixed(1)} MB.`,
      'It costs nothing on either axis, which had to be checked rather than assumed: a tensor read from six places could plausibly be allocated differently by a WebGPU backend. The outputs are identical to the bit and the median run time moves by less than the run-to-run spread.',
      'Tracking adds the shared 12 MB half-precision attention graph and the 6.7 MB full-precision encoder. The marginal download is 19 MB after the 20 MB already fetched for object selection, compared with 76 MB before compression and sharing.',
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
    heading: 'Command-log mask storage',
    prose: [
      'Tracking contributes one applyMask command per frame it has followed the object to, which is the mechanism the document already has and needs no new command type. Whether that scales is a different question from whether it fits, and the log is what makes undo and device-loss recovery cheap enough to be free.',
      `The objection that looked most likely turns out not to be one. Folding a frame's commands filters and sorts the whole log, which is nothing at ten commands and could have been a per-frame cost at ten thousand. It is not: ${fold(
        '18000',
      )} for a ten-minute clip with a mask on every frame, against a 33 ms frame.`,
      `Uncompressed masks do not fit the memory budget. A mask at the engine's own 256 px square is 64 KB, so ten seconds was ${megabytes(
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
      `Packing alone does not control replay cost. Rebuilding a mask walks every command retained by the frame fold, and ${unpacking(
        'roughness 0.5',
      )} of a 33 ms frame goes on three hundred masks before any of them reaches the GPU. So the fold cuts at the last command that decides the frame by itself, which a run of replaces makes the last one. Three hundred commands become one, and so does eighteen thousand.`,
      'Every figure in this section is per object. A run writes replace for its first seed and add for each remaining seed, so a frame folds to one command per object. The multi-object benchmark reports the corresponding values at one, two and three objects without changing the date of this result.',
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
    heading: 'Document size and write time',
    prose: [
      'Tracked runs determine document capacity because they write one command with a packed mask per frame and object. The measured mask averages 3.4 KB, and a ten-minute one-object run occupies 62 MB in memory. Figures in this section are therefore per object; the multi-object benchmark reports how they scale.',
      `Those 62 MB survive the trip. The file is ${megabytes(
        of('ten minutes', ['container', 'bytes']),
      )} against ${held.toFixed(
        1,
      )} MB held, and the difference is the header rather than the masks: they are the log's own arrays handed to the writer, so a save touches every byte once and copies none of them.`,
      'None of the measured sizes is slow enough to require a progress indicator. Saving can remain a direct action instead of a separate operation state.',
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
      'Building covers the header and chunk list. Assembling measures one pass through every chunk using a real Blob, which represents a browser without a writable file handle. With a handle, chunks stream directly to disk. Reading parses the header and returns each mask as a view into the input buffer without another copy.',
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
    heading: 'Binary masks versus base64 JSON',
    prose: [
      'The obvious shape for a document is the one the command log already nearly is: JSON, with each packed mask turned into text. It needs no format and no reader, and the argument against it was arithmetic, which is the half that does not decide anything on its own. Base64 is four bytes for every three before anything else happens.',
      `Base64 also measures ${slower.toFixed(0)} times slower to write and ${(
        of('ten minutes', ['json_base64', 'read_ms', 'median']) /
        of('ten minutes', ['container', 'read_ms', 'median'])
      ).toFixed(
        0,
      )} times slower to read, because every mask has to be built into a string on the way out and taken apart on the way back. A second of work to press Save is a different product from eleven milliseconds.`,
      'The header remains JSON while packed masks occupy a binary region referenced by offsets. Human-readable metadata stays legible, and the large binary payload avoids base64 overhead. The format requires no additional library.',
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
    caveat: `The base64 document is ${((larger - 1) * 100).toFixed(
      1,
    )}% larger, not the raw encoding overhead of 33%, because both formats share the header and the binary container adds a twelve-byte prefix even when no masks exist. The rejected JSON variant remains in tools/video-bench/document.ts beside the measurement rather than in production code.`,
    command: 'node tools/video-bench/run.mjs document',
  };
}

function documentReplay(document: unknown): Section {
  const of = (key: string, path: readonly string[]): number => num(document, ['document', key, ...path]);
  return {
    heading: 'Document replay cost',
    prose: [
      'Replay cost determines whether the file needs derived state. A document that parsed quickly but took a second to render would need a cached mask. That mask would duplicate state already defined by the command log.',
      `It does not. Folding a ten-minute log to the frame it was saved on cuts at the last command that decides that frame by itself, so eighteen thousand commands fold to ${of(
        'ten minutes',
        ['replay', 'folded_to'],
      ).toFixed(0)}, and unpacking that one mask and the fold together are ${ms(
        of('ten minutes', ['replay', 'ms', 'median']),
      )}. Everything after it is the texture upload the renderer does on every frame anyway.`,
      'Replay unpacks one mask per object. The fold cuts at the run’s first seed because that command replaces the frame and later seeds add to it, leaving one command per object. The work remains a fraction of one frame; exact scaling appears in the multi-object benchmark.',
      'The document stores the command log without derived masks, thumbnails or rendered output. Replaying the log is cheaper than reading an equivalent cache.',
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
    heading: 'Media identity checks',
    prose: [
      'A browser document cannot reopen an arbitrary local path, so the user supplies the media again. Rotyl must then detect the wrong file before replaying selections over it. File name and byte length are weak identifiers; a whole-file digest is strong.',
      `The platform offers no streaming whole-file digest. crypto.subtle.digest takes a BufferSource, so digesting two gigabytes requires holding two gigabytes at once. Where it fits, the operation runs at ${rate.toFixed(
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
    caveat: `Whole-file digest cost was measured at 1, 16, 64, 256 and 1024 MB and remained linear at ${whole(
      '64 MB',
      ['megabytes_per_second'],
    ).toFixed(0)} to ${whole('1 MB', ['megabytes_per_second']).toFixed(
      0,
    )} MB per second. The 2 MB cell therefore doubles the 1 MB result. Below two megabytes, the first and last slices overlap and cover the complete file. A structural mismatch prevents replay; a same-shape byte mismatch remains replayable and opens with a warning.`,
    command: 'node tools/video-bench/run.mjs document',
  };
}

// --- crash recovery ---------------------------------------------------------

function whereAJournalCanBeWritten(saved: unknown): Section {
  const opening = (held: string): string =>
    ms(num(saved, ['recovery', 'opening_a_writable', `${held} MB already in it`, 'ms', 'median']));
  return {
    heading: 'Main-thread file access cost',
    prose: [
      'Saving is an explicit action, so a crash loses edits made since the last save. A tracked run can add roughly three quarters of a minute of work between saves. Continuous journalling addresses that gap, and its feasibility depends on the storage API.',
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
      'Opening cost grows by about 1.8 ms per existing megabyte because the API copies the file. That is acceptable for a clip export, which opens one stream and writes through it once. A journal would reopen the stream for every edit.',
    command: 'node tools/video-bench/run.mjs recovery',
  };
}

function whatAnEditCosts(saved: unknown): Section {
  const of = (label: string, path: readonly string[]): number =>
    num(saved, ['recovery', 'appending_one_record', label, ...path]);
  const writable = (label: string): string => ms(of(label, ['through_create_writable_ms', 'median']));
  const worker = (label: string): string => `${of(label, ['inside_the_worker_per_append_ms']).toFixed(2)} ms`;
  return {
    heading: 'Worker file access cost',
    prose: [
      'The same record, appended the two ways, onto journals that already hold nothing, a three hundred frame run, and ten minutes of tracking. One of the rows depends on how much is already there and the other does not.',
      `Ninety eight milliseconds per edit is not a journal, it is a stutter with a file underneath it. ${worker(
        'ten minutes already in it',
      )} is, and it is the same figure on an empty file, so the length of the session stops being a variable.`,
      'The interface does not wait for the write. The main thread frames each record and transfers it to the worker in less than the measurable clock resolution at every size. The operation therefore needs no progress indicator.',
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
    heading: 'Full-document journalling cost',
    prose: [
      'The saved document can also serve as the journal format, avoiding a second writer and reader. Its cost grows with the complete session, however, so each later edit rewrites more data than the previous edit.',
      'A document is one JSON header with the masks in a region behind it, so the header is at the front and grows with the log. Written once that is the right shape and 11 ms. Written per edit it is quadratic, and it crosses from unnoticeable to unusable somewhere between a stroke and a tracked run.',
      'The journal uses a second framing of the same command log because full-document writes scale poorly. Each record carries its own lengths and no backward pointers. A reader walks forward until bytes end, which recovers every complete record after an interrupted write.',
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
    heading: 'Recovery read time',
    prose: [
      'A recovery walks every record and turns it back into a command. That is the same work reading a document does, plus the framing, and it lands in the same place: a document, which then goes through the same path a dropped .rotyl takes. The media check is the same, the replay is the same, and a file that does not match is refused with the same sentence.',
      'Recovery reads on the main thread by design. The read runs once at startup before a file is open or a journal is active. Starting a worker for it would allocate a thread in sessions that have nothing to recover.',
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
    heading: 'Export pipeline breakdown',
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
    heading: 'Export throughput by style',
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
    heading: 'Bitrate control',
    prose: [
      `A qualitative quality level resolves to a quantizer where the codec supports one, which is constant quality and therefore an unbounded file. It is also the default, so a clip export that says nothing about rate control ships ${(
        rate('high, quantizer', 'bytes') / rate('high, bitrate', 'bytes')
      ).toFixed(1)} times the bytes for no time at all.`,
      'Asking for the same level as a bitrate is a predictable file and a variable picture. Rotyl asks for very-high as a bitrate, which is about 12 Mbit/s at 1080p and scales with resolution.',
      'The default quality row does not repeat to the nearest tenth because constant-quality bitrate depends on image content. The same three-second clip measured 30.0 Mbit/s in one run and 23.4 in another. Explicit bitrate rows agree within 0.01 MB between runs.',
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
    heading: 'Export colour round trip',
    prose: [
      'Colour had been measured on the way in and never on the way out, which is the direction a clip export depends on. Pixels leave through a canvas, become a video frame, are converted to YCbCr by the encoder and come back through the browser’s own conversion, and every one of those steps can apply a transfer function.',
      'The same sixteen patches pass through the production composite at zero coverage, which returns the source byte for byte, before export and decode. All sixteen match ffmpeg’s round trip exactly. The remaining midtone shift comes from Chrome’s treatment of unspecified transfer metadata and appears on both sides of this comparison.',
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
    heading: 'Container writer bundle cost',
    prose: [
      'Measured through Rotyl’s own build, so the answer is what this bundler’s tree shaking actually produces rather than what a standalone one would.',
      `Writing costs ${delta('writing, on top of reading')} gzipped on top of a chunk that already reads, which is nine tenths of the entire application bundle and was all of it until saving a selection was added to that bundle. So the writer is its own dynamic import, fetched by an export and by nothing else, the same treatment the demuxer and the model get.`,
      `A second container to write costs ${delta('a second container to write')}: QuickTime is the same muxer with a different brand list, exactly as it is on the read side. A soundtrack copied across costs ${delta('a soundtrack copied across')}, which is a second track and a second source on a muxer that was already paid for. The encoder wrapper is ${delta('the encoder wrapper')} of the writer, and driving the encoder by hand instead would save that and cost five per cent a frame.`,
      'The shipping build has two consumers of one library, so the bundler extracts their shared code. Opening a video costs 8.8 KB more even when the session never exports. A single video chunk would charge every session for the writer, while no split would place the writer in the initial application bundle.',
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
    heading: 'In-memory export limit',
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
    heading: 'Streaming export memory',
    prose: [
      'The same loop, the same sink, the same settings, with a file handle behind it instead of a buffer. The last column is the finding: writing into a file grows the heap by a fraction of a megabyte per thousand frames, which is the noise of a decode loop rather than a trend. One of the rungs fits a NEGATIVE slope, which is the same statement said more bluntly: there is nothing accumulating, so the length of the clip stops being a variable and there is no ceiling to quote.',
      `Streaming adds no measurable per-frame cost. The result is ${row('into a file', 'ms_per_frame', (value) => `${value.toFixed(2)} ms`)} at 1080p, compared with 5.0 ms in the encode ladder. Disk work runs on threads the encoder was not using.`,
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
    heading: 'Download-path memory budget',
    prose: [
      'Finalisation can require roughly four times the file size in memory. The growing assembly buffer may hold twice the final bytes, slicing creates another copy, and the download Blob creates a fourth. The practical file budget is therefore about one quarter of the heap limit.',
      `A thirty-minute in-memory request stops after ${budgeted('minutes_written', (value) => value.toFixed(1))} minutes and ${budgeted('file_mb', mb)}, with a peak heap of ${budgeted('peak_heap_mb', mb)}. It still contains valid ftyp, moov, free and mdat boxes, producing the same valid partial clip as an explicit Stop.`,
      `Blob handling has a separate limit. In a clean tab, this browser reads one byte from a ${mb(num(long, ['long-clip', 'handing it over', 'largest_readable_mb']))} Blob and cannot allocate a two-gigabyte buffer. During finalisation, the assembly buffer remains live beside the Blob; under that condition every 790 MB read failed. The download path now reads one byte before assigning the Blob to an anchor, turning silent failure into a reported error.`,
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
    heading: 'Packet layout and progressive playback',
    prose: [
      'The index goes at the front of every file this writes, so a player can start before the last byte has arrived. Adding a second track is the first thing capable of quietly undoing that. A file whose video is one contiguous run and whose audio is another satisfies "the index is at the front" on paper and violates it completely in practice, because a player has to hold the whole video to reach the first audio sample.',
      `The metric is the byte distance between audio and video that play at each whole second. Grouped tracks grow from ${worst('primed', 30)} at thirty seconds to ${worst('primed', 120)} at two minutes and ${worst('primed', 300)} at five. Interleaving holds the distance at ${worst('interleaved', 300)} for every measured length, or about two and a half seconds of media.`,
      'The lowest-work arrangement does not produce a file. With a reserved index, the muxer cannot size the movie box until it receives a packet from every declared track. Video followed by audio therefore queues all video frames in memory and fails before writing when the track contains B-frames. Priming the muxer with one audio packet allows output; full interleaving then adds one timestamp comparison per frame.',
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
    heading: 'Audio packet counting',
    prose: [
      'The movie box is reserved at the front of the file, which means its sample tables are sized before the first sample lands, which means every track needs a maximum packet count up front. The video has one for nothing: an export knows how many frames it is writing before it renders the first one. The audio does not, and the only way to get one is to walk the whole track.',
      `The count reads sample tables without media payload and costs about one microsecond per packet. Twenty minutes of 48 kHz audio contains ${numberIn(longest, 'packets', (value) => value.toLocaleString('en-GB'))} packets and takes ${numberIn(longest, 'ms', (value) => `${value.toFixed(0)} ms`)}. The linear cost is paid once before rendering.`,
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
    heading: 'Unsupported audio codecs',
    prose: [
      'QuickTime can carry mu-law audio while MP4 cannot. An older camera can therefore provide a valid .mov soundtrack that the target container cannot represent. Rotyl must report that incompatibility before rendering begins rather than discard the track silently.',
      `Compatibility follows from the source track and destination format without decoding or encoding. MP4 supports ${String(codecs.length)} audio codecs, and the file identifies its source codec. Rotyl reports an unsupported track when the file opens and again before export starts.`,
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
    heading: 'Source noise and shader amplification',
    prose: [
      'Every stage runs per frame with no knowledge of the last one, so a chain is a pure function of its frame: hand it the same picture twice and it gives the same answer twice. That is not an argument, it is the second row of the table. On a clip encoded with no temporal grain the input moves by 1.4 codes at the 99th percentile, which is the codec, and every chain answers with 1.0, which is the floor. There is nothing in a styled frame that was not in the source frame.',
      `Amplification depends on image content. On the synthetic scene, Comic measures ${amp('the synthetic scene, five cars moving', 'comic, default')}, Poster ${amp('the synthetic scene, five cars moving', 'poster, default')} and Print ${amp('the synthetic scene, five cars moving', 'print, default')}. On brick, Poster measures ${amp('facade, fixed camera', 'poster, default')} and Comic at detail 1 measures ${amp('facade, fixed camera', 'comic, detail 1')}.`,
      `The affected stages are already isolated. Poster measures ${amp('facade, fixed camera', 'poster, default')} on the wall with its outline and ${amp('facade, fixed camera', 'poster, no line')} without it; foliage measures ${amp('foliage, fixed camera', 'poster, default')} and ${amp('foliage, fixed camera', 'poster, no line')} respectively. Comic rises from ${amp('facade, fixed camera', 'comic, detail 0')} at detail 0 to ${amp('facade, fixed camera', 'comic, detail 1')} at detail 1. Controlled interventions attribute the Comic change to sector selection in the flatten stage.`,
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
      'Measured over pixels untouched by moving objects. That covers the full photograph and the static region of the synthetic traffic scene. The film shots are excluded because input averaging smears the actors and leaves no reliable static population for this comparison; their amplification results remain in the real-footage study.',
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
    heading: 'Input averaging results',
    prose: [
      'Input averaging is the lowest-cost response to source noise. It adds one pass and needs no motion estimation on a fixed camera. The benchmark uses a one-quarter previous-frame weight, the weakest setting expected to affect the metric.',
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
    heading: 'Output blending and ghosting',
    prose: [
      'A lower flicker metric does not guarantee a better moving image. Previous-frame blending can make a fixed camera perfectly steady while smearing motion. The existing fixed-camera and panning-still clips cannot expose that failure, so this test adds independently moving objects against a static scene.',
      'The fixture contains five moving cars against a static city and supplies an exact moving-pixel mask from the scene geometry. Each row is compared with a fixed-weight blend of the previous stylised frame. That deliberately weak method provides a failing case for the ghosting counter-metric.',
      `The primary residue metric improves by two fifths, from ${cell('per frame', ['residue', 'p99'])} codes to ${cell('blend 0.5', ['residue', 'p99'])}. The counter-metrics reject the method: deviation reaches ${cell('blend 0.5', ['deviation', 'vacated', 'p99'])} codes in the area a car has vacated and ${cell('blend 0.5', ['deviation', 'moving', 'p99'])} on the car itself. Gradient energy inside the moving car falls to ${detail('blend 0.5')}, compared with ${detail('per frame')} in the original render.`,
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
    heading: 'Lost occlusion state',
    prose: [
      'EdgeTAM reports object presence with an object score rather than a pixel count. When the score reports occlusion, edgetam-tracker.ts substitutes an empty mask, a negative memory placeholder and the checkpoint’s identity pointer. These substitutions prevent drawing the occluder, learning its appearance or losing the tracked identity.',
      'The earlier host returned the verdict but tracking-job.ts used it only for a counter. It still wrote an ordinary replace command with an all-zero mask, and the store discarded the counter. The command log could not distinguish model-reported occlusion from a selection erased by the user. Coverage, overlay and timeline projections therefore interpreted the frame incorrectly.',
      'This is a command-log defect rather than a missing diagnostic panel. Confidence, candidate area and dropped-frame counts describe the tool. An occlusion describes a numbered frame in the open document and changes how an empty selection should be interpreted. That document-specific fact must survive save, reload and undo.',
      'The occlusion flag belongs on the command rather than the run. A run ends with the session, while the missing selection on a numbered frame must remain explainable after save, reload and undo. The existing group field establishes that commands may retain provenance as well as an operation, so the design fits the current log model.',
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
    heading: 'Timeline representation of tracking',
    prose: [
      'The marks under the timeline exist because a selection that leaves no trace cannot be found again, and they were fed by a projection that returned the frame numbers an edit was made on and nothing else. That is exactly right for a stroke. For a tracking run it says the opposite of what happened: a run is ONE gesture, group has recorded that since the day tracking landed so that undo could take the whole thing back in one press, and the projection threw it away.',
      `It also drew one absolutely positioned element per entry, so a ten-minute run put ${marks(
        '18000 frames, nothing hidden',
      )} of them on a track six hundred pixels wide, every one saying the same thing. Joined along the group it is ${elements(
        '18000 frames, nothing hidden',
      )}: the user’s own command on the anchor frame, which the run deliberately writes nothing for, and the run itself. With the object going behind something three times it is ${elements(
        '18000 frames, hidden three times',
      )}, because each occlusion is a stretch the run reached and found nothing in, drawn faintly rather than left as a gap.`,
      `The richer projection produces fewer timeline elements. It still runs on every editor render, so its cost is measured: ${projection(
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
    heading: 'Storage and bundle cost',
    prose: [
      `A document is a JSON object per command with the packed masks in a region behind it, so a field added to a command is added as many times as there are commands, and a ten-minute tracked run is eighteen thousand of them. That is a fair objection and it is answered with arithmetic: the same log written twice, once with the field and once without, at one occlusion of two seconds every hundred. ${carrying} of the eighteen thousand commands carry it, at ${perCommand} bytes each, which is ${asBytes(flagBytes)} and ${share.toFixed(3)}% of the file.`,
      `The field is omitted when false. File-size comparison alone cannot price it because occluded frames also contain empty masks. An empty mask packs to ${nothing} bytes, compared with ${silhouette} KB for a silhouette, so the document with occlusions is ${saved} MB smaller despite the added field. Per-command arithmetic isolates the field cost.`,
      `A mask of nothing costing a kilobyte is worth a sentence of its own, because the obvious guess is a byte or two and this was written down as three before it was run. The packing caps a repeat at 128, so sixty-five thousand zeroes are five hundred and twelve repeats rather than one, and the number is three hundred times the guess. It is still under a third of what a silhouette costs, which is the claim this makes; it is not nothing, which is the claim the guess would have made.`,
      'Bundle size is the second cost. Rotyl previously chose Preact at 6.1 KB gzipped over React at 59.5 KB for an interface built around a canvas and eight buttons. This change adds no mode, panel or control. It reuses the existing track mark and completed-export message.',
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
      'Both measurements use a dedicated command and results file. Folding them into the document or replay benchmarks would rerun unrelated code paths and change the dates of several independent findings through measurement noise.',
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
    heading: 'Scaling with object count',
    prose: [
      'A run writes one applyMask per frame it followed an object to, and for as long as there was exactly one object a figure about a run and a figure about an object were the same figure. Four of them are quoted in three of this project’s documents, and each is exactly true of one object and says nothing about several. They are taken here at one, two and three.',
      `The file is the one that really is arithmetic, and it is measured anyway rather than multiplied: N objects is N commands per frame and N packed masks behind them, and the run comes back at ${against(
        '2 objects',
        ['file_bytes'],
      )} and ${against('3 objects', ['file_bytes'])} of a single object’s ${asFile(
        cell('1 object', ['file_bytes']),
      )}. A ten-minute clip with three tracked objects is a ${asFile(
        cell('3 objects', ['file_bytes']),
      )} document, and what had to change about that figure is the two missing words rather than the figure.`,
      `The projection is the one that matters most, because it is the only one of the four on the render path: editSpans runs over the whole log on every render of the editor. It is also the one that moves LEAST. Three times the commands is ${against(
        '3 objects',
        ['projection', 'ms', 'median'],
      )} the time, because what it sorts is the distinct frames a log touched and there are still eighteen thousand of those however many commands landed on each of them.`,
      `Rendered timeline complexity does not change: ${cell('3 objects', ['projection', 'elements']).toFixed(
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
    heading: 'Multi-object fold semantics',
    prose: [
      'The fold cuts at the last command that decides a frame by itself, which is a clear or a mask applied with replace, because everything before one of those is discarded by it. A run following one object writes replace on every frame it reached, so eighteen thousand commands fold to one and a replay unpacks one mask. That is what made a document able to be dumb: nothing derived has to be stored in it, because rebuilding it is a fold and a texture upload.',
      `A run following several writes replace for the FIRST object and add for the rest, which is what makes two objects two regions rather than a race. So the cut lands on the first object’s command and everything after it survives: the frame folds to ${cell(
        '3 objects',
        ['fold', 'folded_to'],
      ).toFixed(0)} commands at three objects rather than to one, and a replay unpacks ${cell('3 objects', [
        'replay',
        'masks_unpacked',
      ]).toFixed(0)} masks rather than one.`,
      `Fold semantics require a structural correction rather than a revised constant. “A fold to one and a texture upload” omitted object count because the interface originally exposed one seed. The multi-object result is ${ms(
        cell('3 objects', ['replay', 'ms', 'median']),
      )} against ${ms(
        cell('1 object', ['replay', 'ms', 'median']),
      )}, which is linear in objects and is still a fraction of one frame, so the conclusion the sentence was written to support survives being said correctly.`,
    ],
    caveat:
      'This benchmark has its own command and results file. Adding object count to the document, replay or timeline studies would change the dates of findings whose implementations did not move. The one-object control is repeated in this run so every ratio compares cells produced together under the same conditions.',
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
    heading: 'Range-probe integrity',
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
      `Two files with different payload bytes and range flags return through the production upload path within ${num(
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
    heading: 'Decoder-dependent range handling',
    prose: [
      `One pair of clips at one size cannot see this, and that is how it stayed open. On the 1920x1080 probes the flag is honoured and there is nothing to do. The same eight greys at 320x180 come back ${inCodes(
        rung('320x180'),
      )} from their limited-range twin, contrast-stretched exactly as a full-range payload read as limited would be. The probe that owns the colour contract is 1080p, and 1080p is on the working side of the line.`,
      `Four sizes put that line between 480x270 and 640x360 on this machine, which is a number about this machine. Asked directly, hardwareAcceleration says what it is really about: told to prefer hardware, a 320x180 full-range clip is ${inCodes(
        asked('320x180, prefer-hardware'),
      )} from its twin; told to prefer software, a 1280x720 one is ${inCodes(
        asked('1280x720, prefer-software'),
      )}. The hardware decoder honours the flag at every size and the software decoder ignores it at every size. Frame size only decides which one the browser picks.`,
      'The decoder mechanism is more portable than the measured threshold. The boundary belongs to this Mac and Chrome build, while the software decoder’s handling can be tested independently on other hardware.',
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
      'Every figure compares the full-range encode with the limited-range encode of the same picture, not with the source. Chrome’s GPU upload also changes the midtones of these 4:2:0 probes because their transfer metadata is unspecified. Comparing the paired encodes cancels that separate effect and isolates the range flag.',
    command: 'node tools/video-bench/run.mjs range',
  };
}

function theMetadataIsNoHelp(perRange: unknown): Section {
  const of = (clip: string, path: readonly string[]): number =>
    num(perRange, ['range', 'clips', clip, ...path]);
  return {
    heading: 'Unobservable decoder behaviour',
    prose: [
      `VideoFrame.colorSpace reports fullRange false on a full-range file, both where the decode was right and where it was wrong, so it is not a signal a page could branch on. Two more of that object\u2019s four fields are inventions rather than readings: both probes declare colour_primaries ${of(
        CLIP.pc,
        ['sps', 'colour_primaries'],
      ).toFixed(0)} and transfer_characteristics ${of(CLIP.pc, ['sps', 'transfer_characteristics']).toFixed(
        0,
      )} in their SPS, which is "unspecified" for both, and the browser reports bt709 for both. The matrix_coefficients field, at ${of(
        CLIP.pc,
        ['sps', 'matrix_coefficients'],
      ).toFixed(0)}, is the only field that matches an explicit value in the file.`,
      'The SPS range flag is readable from the avcC, but the frame does not reveal whether the decoder applied it. A reliable correction requires that missing signal. Rotyl therefore documents the case as a limit: a small full-range clip routed through the tested software decoder returns contrast-stretched, and the application cannot detect the failure.',
      'The affected case is narrow. Camera and phone H.264 footage is usually limited range; full-range material is more common in screen recordings and synthetic output, and the tested failure also requires software decoding. The thirteen-code contrast error remains visible across the frame.',
    ],
    caveat:
      'This study has its own command and results file despite sharing clips and upload code with the colour probe. The general video run also produces decode, readback and ONNX results. Rerunning that complete set for a range-flag question would change the dates of unrelated findings.',
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
    heading: 'Unspecified transfer metadata',
    prose: [
      'The GPU path differs by eleven midtone codes because the generated clips declare transfer_characteristics 2, or unspecified, while storing sRGB values. Chrome defaults the missing declaration to BT.709 and converts data that the probe had already encoded for display.',
      'The same sixteen patches were encoded three times with identical content and settings but different transfer declarations. The decoded result follows the declaration, isolating metadata as the variable.',
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
    heading: 'Explicit BT.709 control',
    prose: [
      'The control clip declares BT.709 and stores BT.709 values. Its patches are converted to linear light and encoded through the BT.709 curve, so a correct reader reconstructs the original display values. ffmpeg provides an independent decoder control and returns the patches within one code.',
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
    heading: 'Decoder-specific transfer handling',
    prose: [
      'Chrome 151 used separate hardware and software H.264 paths on the tested machine. The software path also skipped the transfer conversion on the tagged control clip. Its thirteen-code range error and the hardware path’s eleven-code transfer change are independent behaviours.',
      'The earlier correlation with NV12 and I444 was incidental. Chrome reported that the 4:4:4 probe was supported only by the software decoder, so that probe was never eligible for the hardware path that applied the transfer conversion.',
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
      'The two decoders return different pixel formats for the same file: NV12 from hardware and I420 from software. VideoFrame.colorSpace exposes no corresponding distinction. Pixel format is a platform observation, not a decoder identity promised by the specification, so using it to correct colour would fail when another software decoder returns NV12.',
    command: 'node tools/video-bench/run.mjs transfer',
  };
}

function whatACanvasWouldCost(declared: unknown): Section {
  const median = (label: string): number => num(declared, ['transfer', 'cost_ms', label, 'median']);
  const added = num(declared, ['transfer', 'cost_ms', 'added_by_the_canvas']);
  return {
    heading: 'Canvas detour cost',
    prose: [
      'The diagnostic getImageData path copies twelve megabytes through system memory per frame. The production candidate draws the frame into a canvas and uploads that canvas. It returns the same values, so its timing and colour result measure one shippable path.',
      `The canvas detour adds ${ms(added)} per 1080p frame. The value is derived from two rows in one run because direct-copy timing is noisy on this machine. It adds roughly one quarter to a 5.0 ms export frame and remains small against a 33 ms playback frame.`,
      'The detour costs almost the same 1.4 ms as the rejected export readback. It also removes the correct transfer conversion from properly tagged footage. The apparent benefit applies only to repository probes with unspecified metadata, not to valid real-world files.',
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
      'Timed on the decode clip rather than a flat probe, so the first row is directly comparable with the production upload measurement. This study has its own command and results file because rerunning it should not change the dates of the decode, readback, ONNX or range findings.',
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
      kind: 'benchmark',
      scope: 'Rotyl shader chains on the synthetic reference scene and recorded test environment.',
      repeatability: 'Automated in Chrome; uses committed synthetic inputs.',
      harness: 'tools/style-bench',
      lede: [
        'This benchmark compares the Comic, Poster and Print shader chains by render cost, control setting and frame-to-frame change. The synthetic scene keeps geometry, camera motion and source noise fixed so the shader remains the only changing component.',
        'The results establish local performance bounds and identify hard transitions that can turn small input changes into visible flicker. Real-image validation is reported separately because the synthetic scene does not represent photographic texture.',
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
      kind: 'investigation',
      scope: 'Four photographs and two film shots processed by Rotyl on the recorded test environment.',
      repeatability: 'Automated after downloading and verifying the pinned source media.',
      harness: 'tools/style-bench',
      lede: [
        'The synthetic fixture understated instability in the Poster outline. This study repeats the timing and stability tests with four photographs and two film shots whose source bytes are pinned by hash.',
        'Render cost changed little across the sample. Comic remained stable, but the original Poster outline amplified small changes by roughly five times on brick and foliage. The current operator was selected from the controlled perturbation tests reported below.',
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
      kind: 'investigation',
      scope: 'The Comic shader at three detail settings across the pinned real-image set.',
      repeatability: 'Automated after downloading and verifying the pinned source media.',
      harness: 'tools/style-bench',
      lede: [
        'Comic becomes less stable as the Detail control rises. The study measures the full control range, then holds each affected shader quantity constant to identify the source of the change.',
        'The amplification came from sector selection in the flatten stage, not from the outline mechanism found in Poster. Bounding the flatten scale reduced the instability while preserving the purpose of the Detail control.',
      ],
      sections: [detailRows(real), filmStills(real), theFlatten(real)],
    },
    {
      slug: 'holding-still',
      results: 'tools/style-bench/results-motion.json',
      title: 'Frame-to-frame stability',
      standfirst:
        'The remaining flicker comes from one stage in Comic. Blending frames adds visible ghosts without fixing it.',
      kind: 'investigation',
      scope: 'Rotyl style chains on fixed-camera and moving-object test clips.',
      repeatability: 'Automated in Chrome; uses committed and hash-verified inputs.',
      harness: 'tools/style-bench',
      lede: [
        'This study separates source noise, shader amplification and independent frame decisions. It also measures visible ghosting so a lower change metric cannot be mistaken for a better moving image.',
        'Input averaging lowers noise but does not change the stage that amplifies it. Output blending lowers the metric while adding ghosts around moving objects. The remaining defect is confined to the Comic flatten stage.',
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
      kind: 'benchmark',
      scope: 'Rotyl video ingestion in Chrome on the recorded machine and codec paths.',
      repeatability: 'Automated in Chrome; results depend on browser and hardware decode support.',
      harness: 'tools/video-bench',
      lede: [
        'This benchmark measures demux, sequential decode, seeking, GPU upload and colour reconstruction through Rotyl’s browser video path. Two keyframe layouts expose the cost difference between playback and random access.',
        'The findings determine the frame-provider interface and colour contract for the tested Chrome environment. They do not establish portable codec performance across browsers or hardware decoders.',
      ],
      sections: [decode(video), upload(video), colour(video)],
    },
    {
      slug: 'full-range',
      results: 'tools/video-bench/results-range.json',
      title: 'Full-range H.264 decoding',
      standfirst: 'Hardware decode honours the range flag at 1080p. Software decode ignores it at 320×180.',
      kind: 'investigation',
      scope: 'Chrome 151 H.264 decode paths on the recorded Apple hardware.',
      repeatability: 'Automated in Chrome; decoder selection and thresholds may differ elsewhere.',
      harness: 'tools/video-bench',
      lede: [
        'The probe encodes the same grey patches as limited-range and full-range H.264, verifies the bitstreams, and compares the decoded values. Chrome 151 selected different decoder paths by frame size on the tested Apple hardware.',
        'The hardware path honoured the range flag. The software path ignored it and contrast-stretched the full-range clip. The observed size boundary belongs to this environment; the decoder disagreement is the mechanism under test.',
      ],
      sections: [theClipWasAlwaysRight(perRange), whichDecoder(perRange), theMetadataIsNoHelp(perRange)],
    },
    {
      slug: 'the-transfer',
      results: 'tools/video-bench/results-transfer.json',
      title: 'Video transfer metadata',
      standfirst:
        'The measured colour change was declared by the file, not introduced by decoding or the WebGPU path.',
      kind: 'investigation',
      scope: 'Chrome 151 transfer handling for the generated H.264 probes on the recorded machine.',
      repeatability: 'Automated in Chrome with ffmpeg as an external control.',
      harness: 'tools/video-bench',
      lede: [
        'A colour probe showed an eleven-code midtone difference between Chrome’s GPU and canvas paths. This study adds clips with explicit transfer metadata and uses ffmpeg as an external control.',
        'The GPU path applied the declared transfer function correctly. Earlier Rotyl probes had left the transfer unspecified while storing sRGB values, which caused Chrome to apply a conversion the files did not describe accurately. Routing frames through a canvas removed the conversion but produced the wrong result for correctly tagged footage.',
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
      kind: 'benchmark',
      scope: 'Rotyl video export in Chrome on the recorded machine, styles and output sizes.',
      repeatability: 'Automated in Chrome; timings depend on browser and hardware.',
      harness: 'tools/video-bench',
      lede: [
        'This benchmark runs Rotyl’s complete export path: source frame, style, composite, encoder and container writer. It measures throughput, bitrate, container overhead and colour on the tested browser and hardware.',
        'A frame-identity check accompanies the timing data because canvas capture can be offset by one presentation cycle without changing aggregate performance figures.',
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
      kind: 'benchmark',
      scope: 'Rotyl export memory and storage behaviour in the recorded Chrome environment.',
      repeatability: 'Automated but resource intensive; browser memory and storage limits vary by machine.',
      harness: 'tools/video-bench',
      lede: [
        'This benchmark drives Rotyl’s export loop for progressively longer durations and separates slow memory pressure from an unrecoverable allocation or Blob failure.',
        'The comparison covers the former in-memory packet sink and the current streaming file sink. Exact ceilings depend on the browser and machine, while bounded memory use follows from writing packets as they are produced.',
      ],
      sections: [heldCeiling(long), intoAFile(long), theBudget(long)],
    },
    {
      slug: 'sound',
      results: 'tools/video-bench/results-interleave.json',
      title: 'Audio interleaving',
      standfirst:
        'Copying encoded audio is cheap. Placing it beside the matching video packets is what keeps playback progressive.',
      kind: 'investigation',
      scope: 'Rotyl container output for the measured audio and video packet layouts.',
      repeatability: 'Automated; structural findings are independent of benchmark speed.',
      harness: 'tools/video-bench',
      lede: [
        'Progressive playback requires matching audio and video packets to remain close in the file. A front-loaded index is insufficient if each track is written as one separate block.',
        'The harness writes the same clip with three packet arrangements and measures the byte distance between media that plays at the same time. A distance that grows with clip length identifies a layout that cannot stream progressively.',
      ],
      sections: [theArrangements(sound), countingFirst(sound), whatItWillNotCarry(sound)],
    },
    {
      slug: 'the-document',
      results: 'tools/video-bench/results-document.json',
      title: 'Rotyl file size and replay',
      standfirst:
        'Save size, load time, replay cost and media identity measured for tracked edits that need to survive a tab.',
      kind: 'benchmark',
      scope: 'The current Rotyl document format and measured tracked-edit fixtures.',
      repeatability: 'Automated; time figures depend on the recorded machine.',
      harness: 'tools/video-bench',
      lede: [
        'Rotyl stores edits as commands rather than changed pixels. Undo moves through the command log, export replays it, and device recovery rebuilds the current state from it. The document format extends that model across a page reload.',
        'Tracked edits are the capacity case because they store one packed mask per frame and object. This benchmark measures document size, write time, load time, replay cost and source-media identity for those logs.',
      ],
      sections: [documentCost(saved), documentShape(saved), documentReplay(saved), documentIdentity(saved)],
    },
    {
      slug: 'crash-recovery',
      results: 'tools/video-bench/results-recovery.json',
      title: 'Crash recovery performance',
      standfirst:
        'The edit journal now writes off the main thread, preserving unsaved work without making brush and tracking actions wait on storage.',
      kind: 'benchmark',
      scope: 'The current Rotyl recovery journal and browser storage implementation.',
      repeatability: 'Automated in Chrome; storage timing depends on the machine and browser profile.',
      harness: 'tools/video-bench',
      lede: [
        'Manual saves do not protect edits made after the last save. Rotyl therefore journals command changes to browser storage while the session is active.',
        'The benchmark compares full-document writes with incremental records, measures main-thread and worker behaviour, and times recovery. Full-document journalling scaled with session length; worker-written incremental records kept editing work independent of storage latency.',
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
      kind: 'historical',
      scope: 'Pre-implementation estimates for the EdgeTAM design that Rotyl later shipped.',
      repeatability: 'Mixed browser and Python harnesses; preserved to document the original decision.',
      harness: 'tools/video-bench, tools/edgetam-export',
      lede: [
        'This study was completed before Rotyl implemented tracking. It estimated model execution, model delivery, GPU readback and command-log growth to determine whether EdgeTAM could fit the browser product.',
        'Tracking has since shipped. The measurements remain here as a record of the constraints used to choose the original architecture, not as a statement of current end-to-end performance.',
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
      kind: 'benchmark',
      scope: 'The complete Rotyl EdgeTAM path on the recorded model release and machine.',
      repeatability: 'Automated after configuring access to the owned model files.',
      harness: 'tools/video-bench',
      lede: [
        'The feasibility estimate added four graph timings but did not include the completed host loop. This benchmark measures the production tracking path against the earlier estimate.',
        'The run uses Rotyl’s model loading, frame loop and command log. Repeating it requires access to the two owned model graphs that are not stored in the repository.',
      ],
      sections: [trackedCost(tracked), trackedArithmetic(tracked)],
    },
    {
      slug: 'the-occlusion',
      results: 'tools/video-bench/results-occlusion.json',
      title: 'Occlusion handling',
      standfirst:
        'EdgeTAM knew which frames lost the object, but the command log discarded that answer. Carrying it costs 14 bytes per command.',
      kind: 'decision',
      scope: 'Rotyl command, timeline and document behaviour when EdgeTAM reports occlusion.',
      repeatability: 'Automated with generated command logs and measured production builds.',
      harness: 'tools/video-bench',
      lede: [
        'EdgeTAM reports whether the tracked object is absent, but the earlier command log stored only an empty mask. That made a model-reported occlusion indistinguishable from a selection erased by the user.',
        'Rotyl now stores the occlusion verdict on the frame command and reports the run outcome at completion. The record measures the file-size and interface cost of carrying that document-specific fact while leaving diagnostic scores out of the document format.',
      ],
      sections: [whatDied(), whatTheTimelineDrew(hidden), whatSayingSoCost(hidden)],
    },
    {
      slug: 'per-object',
      results: 'tools/video-bench/results-objects.json',
      title: 'Multi-object tracking costs',
      standfirst:
        'Four published figures assumed one object. Three grow with object count; one barely moves.',
      kind: 'benchmark',
      scope: 'Rotyl tracking logs with one, two and three selected objects.',
      repeatability: 'Automated with generated command logs and production code.',
      harness: 'tools/video-bench',
      lede: [
        'Rotyl can follow several selected objects in one run, while earlier capacity figures assumed one object. This benchmark repeats the affected measurements with one, two and three objects.',
        'File size, fold size and replay work grow with object count. The timeline projection changes little because it reports spans rather than masks. The results state which earlier figures are per object and which remain per run.',
      ],
      sections: [fourFigures(perObject), foldsToN(perObject)],
    },
    {
      slug: 'the-host',
      results: 'tools/edgetam-export/host.json',
      title: 'EdgeTAM host validation',
      standfirst:
        'Reference inputs exposed errors in transposes, memory and prompting that still produced plausible masks.',
      kind: 'investigation',
      scope: 'Rotyl EdgeTAM host code compared with the pinned PyTorch reference implementation.',
      repeatability: 'Automated in Python with the pinned model and reference fixtures.',
      harness: 'tools/edgetam-export',
      lede: [
        'Graph-level validation does not cover the host code that transposes tensors, arranges the memory bank, resamples masks and prepares prompts. Errors in those operations can still produce plausible masks.',
        'The harness feeds reference inputs through each host stage and compares the intermediate values with the pinned PyTorch implementation. It also runs complete clips so local agreement and end-to-end tracking quality are checked together.',
      ],
      sections: [hostArithmetic(host), hostMistakes(host), hostEndToEnd(host)],
    },
    {
      slug: 'the-editor',
      results: 'tools/research/measurements.ts',
      title: 'Editing latency',
      standfirst:
        'Hand-timed interaction figures that guide product decisions but are not reproducible enough for the benchmark set.',
      kind: 'benchmark',
      scope: 'A manual spot check of Rotyl editing interactions on the recorded machine.',
      repeatability: 'Manual; use as a product check, not as a portable performance claim.',
      harness: 'measured by hand, in a browser',
      lede: [
        'These interaction timings were recorded by hand and are not regenerated by a benchmark harness. They are useful for spotting large product regressions, but they do not support portable or statistically precise performance claims.',
      ],
      sections: [
        {
          heading: 'Brush and composite latency',
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
          heading: 'Object-selection latency',
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
          heading: 'Release bundle size',
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
  const chrome = /Chrome\/([^ ]+)/.exec(agent)?.[1] ?? 'an unknown build';
  const vendor = text(video, ['adapter', 'vendor']);
  const architecture = text(video, ['adapter', 'architecture']);
  return `Apple M3 Pro, OS version not recorded, Chrome ${chrome}, adapter ${vendor} / ${architecture}`;
}

/**
 * The investigation that isolated a tracked selection leaving its subject.
 *
 * Kept as its own entry, and its own results file, because it is an
 * investigation rather than a benchmark: most of what it records is the
 * explanations that were measured and rejected, which is the part that stops
 * the same ground being covered again.
 */
export function trackedSelectionEntry(results: unknown): Entry {
  const grid = num(results, ['maskGrid']);
  const frames = num(results, ['confidence', 'frames']);
  const iouMin = num(results, ['confidence', 'predictedIouMin']);
  const iouMax = num(results, ['confidence', 'predictedIouMax']);
  const iouAt = num(results, ['confidence', 'predictedIouAtFrame185']);
  const absent = num(results, ['confidence', 'framesReportedAbsent']);
  const wideWidth = num(results, ['aspect', 'wide', 'maskWidthColumns']);
  const cropWidth = num(results, ['aspect', 'cropped', 'maskWidthColumns']);
  const cropRatio = num(results, ['aspect', 'cropRatio']);
  const measuredRatio = cropWidth / wideWidth;
  const maskFrom = num(results, ['exportAgreement', 'maskColumns', '0']);
  const maskTo = num(results, ['exportAgreement', 'maskColumns', '1']);
  const styledFrom = num(results, ['exportAgreement', 'styledColumns', '0']);
  const styledTo = num(results, ['exportAgreement', 'styledColumns', '1']);
  const exportFrame = num(results, ['exportAgreement', 'frame']);
  const renderWidth = num(results, ['exportAgreement', 'renderWidth']);
  const seededAt = num(results, ['lateSeed', 'seededAtFrame']);
  const lateArea = num(results, ['lateSeed', 'lateRunAtLastFrame', 'area']);
  const longArea = num(results, ['lateSeed', 'longRunAtLastFrame', 'area']);
  const lateFrom = num(results, ['lateSeed', 'lateRunAtLastFrame', 'minX']);
  const lateTo = num(results, ['lateSeed', 'lateRunAtLastFrame', 'maxX']);
  const longFrom = num(results, ['lateSeed', 'longRunAtLastFrame', 'minX']);
  const longTo = num(results, ['lateSeed', 'longRunAtLastFrame', 'maxX']);
  const clip = text(results, ['clip', 'name']);
  const clipFrames = num(results, ['clip', 'frames']);

  return {
    slug: 'tracked-selection',
    results: 'tools/shots/results-track-confidence.json',
    title: 'Tracked selection fault isolation',
    standfirst:
      'A selection that left its subject was traced to a cancelled object proposal. Four other explanations were measured first and none of them held.',
    kind: 'investigation',
    scope: `Object tracking in the shipped editor on one 2.40:1 clip, ${String(clipFrames)} frames, on the recorded Chrome build and machine.`,
    repeatability:
      'Scripted. The harness drives the shipped application, seeds a selection by clicking the canvas, and writes both the per-frame figures and the masks themselves.',
    harness: 'tools/shots/track-confidence.mjs',
    taken: `${text(results, ['environment', 'cpu'])}, ${text(results, ['environment', 'platform'])}, ${text(results, ['environment', 'browser'])}, Node ${text(results, ['environment', 'node'])}`,
    lede: [
      `A tracked selection on ${clip} finished the clip covering hedge and bridge instead of the walker it was seeded on. The fault was reproducible and the exported file showed it, which made it look like a limit of the tracker.`,
      'The fault was a keypress in the harness. Pressing Escape between choosing an object proposal and starting the run cancels the proposal, while the preview continues to show the one that was highlighted. The editor looked correct and the run followed the smaller default proposal.',
      'The measurements below were taken while that was still unknown. They are kept because each one rules an explanation out, and because two of them describe behaviour that would mislead the next reader in the same way.',
    ],
    sections: [
      {
        heading: 'The model reports high confidence while wrong',
        prose: [
          `Across ${String(frames)} tracked frames the decoder's predicted IoU stayed between ${iouMin.toFixed(3)} and ${iouMax.toFixed(3)}, and its object score reported the subject absent on ${String(absent)} frames. At frame ${String(exportFrame)}, where the mask was on the wrong region, the predicted IoU was ${iouAt.toFixed(3)}.`,
          'A mask that has settled on a stable piece of background is an easy mask to predict, so confidence rises as the result gets worse. Gating memory admission on either score would not have detected this fault on this clip.',
        ],
        table: {
          columns: ['signal', 'range across the run'],
          rows: [
            ['predicted IoU', `${iouMin.toFixed(3)} to ${iouMax.toFixed(3)}`],
            ['predicted IoU where the mask was wrong', iouAt.toFixed(3)],
            ['frames reported absent', String(absent)],
          ],
        },
        command: 'node tools/shots/track-confidence.mjs',
      },
      {
        heading: 'The squashed aspect is not the cause',
        prose: [
          `The model input is square and the clip is 2.40:1, so a standing person arrives stretched. Re-running on the same footage cropped to 1.50:1 gave a mask ${String(cropWidth)} grid columns wide against ${String(wideWidth)}, a ratio of ${measuredRatio.toFixed(2)} where the crop ratio is ${cropRatio.toFixed(2)}.`,
          `The mask covers the same region of the picture at either aspect, on a ${String(grid)} column grid. The distortion changes what the numbers look like and does not change what is selected.`,
        ],
        table: {
          columns: ['input aspect', 'mask width in grid columns'],
          rows: [
            ['2.40:1, as delivered', String(wideWidth)],
            ['1.50:1, centre cropped', String(cropWidth)],
          ],
        },
        caveat:
          'One clip and one subject. The result shows this distortion did not cause this fault, not that aspect never matters.',
        command: 'node tools/shots/track-confidence.mjs',
      },
      {
        heading: 'The fault does not accumulate along the run',
        prose: [
          `Seeding at frame ${String(seededAt)}, where the subject is already close to the camera, and tracking only the frames after it reached the same place as a run seeded at the first frame. The two masks at the last frame cover columns ${String(lateFrom)} to ${String(lateTo)} and ${String(longFrom)} to ${String(longTo)}.`,
          'A run with almost no history to drift through arrives where a run with the whole clip behind it arrives. Explanations that depend on memory filling with bad frames are therefore not supported here.',
        ],
        table: {
          columns: ['run', 'mask area at the last frame', 'columns covered'],
          rows: [
            ['seeded at the first frame', String(longArea), `${String(longFrom)} to ${String(longTo)}`],
            [
              `seeded at frame ${String(seededAt)}`,
              String(lateArea),
              `${String(lateFrom)} to ${String(lateTo)}`,
            ],
          ],
        },
        command: 'ROTYL_START_FRAME=150 node tools/shots/track-confidence.mjs',
      },
      {
        heading: 'The exported file agrees with the tracked mask',
        prose: [
          `At frame ${String(exportFrame)} the mask covers columns ${String(maskFrom)} to ${String(maskTo)} of ${String(renderWidth)}, and the pixels the exported file changes cover ${String(styledFrom)} to ${String(styledTo)}. The treatment lands where the selection is.`,
          'An earlier reading of this comparison claimed the two disagreed. That reading compared a mask recorded in one run against a file exported from another, which is not a comparison, because two runs of the tracker need not produce the same mask. The harness now writes both from a single run.',
        ],
        table: {
          columns: ['measured at the export size', 'columns'],
          rows: [
            ['tracked mask', `${String(maskFrom)} to ${String(maskTo)}`],
            ['pixels the export changed', `${String(styledFrom)} to ${String(styledTo)}`],
          ],
        },
        caveat:
          'Differences were measured per colour channel. A luminance difference under-reports this treatment, which flattens colour while leaving brightness close to the source.',
        command: 'ROTYL_EXPORT=out.mp4 ROTYL_MASK_AT=185 node tools/shots/track-confidence.mjs',
      },
      {
        heading: 'What the fault was',
        prose: [
          text(results, ['cause', 'fault']),
          text(results, ['cause', 'effect']),
          'A preview that disagrees with committed state is worth more attention than the tracking behaviour this investigation started on. The harness now presses nothing between choosing a proposal and starting a run.',
        ],
        command: 'node tools/shots/tracked-clip.mjs',
      },
    ],
  };
}
