/**
 * The research page: every measurement Rotyl has taken, and every approach it
 * has tried and dropped.
 *
 * GENERATED, NEVER WRITTEN. Numbers come out of the results JSON the benchmark
 * harnesses produce, by path, at build time. That is not tidiness — it is the
 * one failure this page exists to prevent. Every table in every README is
 * transcribed by hand, and transcription is how "the print chain has never been
 * timed" survived three chapters after it stopped being true, and how the comic
 * figures drifted a third off the ones the harness actually reports. A path
 * that no longer resolves fails the build here rather than printing a stale
 * number to a reader who has no way of knowing.
 *
 * It is a static file, not a route. The application bundle is 41 KB gzipped and
 * this project has twice chosen a smaller dependency over a nicer one; putting
 * documentation inside the editor would undo that for a page nobody opens while
 * they are working. Vite serves it in development and emits it at build, and it
 * costs the application nothing in either.
 */

export interface Table {
  /** The first column is the row's label; the rest are figures. */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface Measurement {
  readonly title: string;
  /** One sentence saying what the number MEANS. The table says what it is. */
  readonly finding: string;
  readonly table: Table;
  /** How to take it again. Absent when nothing automated takes it. */
  readonly command?: string;
  readonly caveat?: string;
}

export interface Group {
  readonly title: string;
  readonly blurb: string;
  readonly measurements: readonly Measurement[];
}

export type Verdict = 'adopted' | 'rejected' | 'open';

export interface Trial {
  readonly what: string;
  readonly verdict: Verdict;
  /** The number or observation that decided it. */
  readonly evidence: string;
  readonly where: string;
}

export interface Page {
  readonly groups: readonly Group[];
  readonly trials: readonly Trial[];
  /** What the measurements were taken on, read from the results themselves. */
  readonly hardware: string;
}

const escape = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function renderTable(table: Table): string {
  const head = table.columns
    .map((column, index) => `<th${index === 0 ? '' : ' class="n"'}>${escape(column)}</th>`)
    .join('');
  const body = table.rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, index) => `<td${index === 0 ? '' : ' class="n"'}>${escape(cell)}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderMeasurement(measurement: Measurement): string {
  return [
    `<section class="m">`,
    `<h3>${escape(measurement.title)}</h3>`,
    `<p class="finding">${escape(measurement.finding)}</p>`,
    renderTable(measurement.table),
    measurement.caveat ? `<p class="caveat">${escape(measurement.caveat)}</p>` : '',
    measurement.command ? `<p class="cmd"><code>${escape(measurement.command)}</code></p>` : '',
    `</section>`,
  ].join('');
}

const VERDICT_LABEL: Record<Verdict, string> = {
  adopted: 'kept',
  rejected: 'dropped',
  open: 'open',
};

function renderTrials(trials: readonly Trial[]): string {
  const rows = trials
    .map(
      (trial) =>
        `<tr><td>${escape(trial.what)}</td>` +
        `<td class="v"><span class="tag tag--${trial.verdict}">${VERDICT_LABEL[trial.verdict]}</span></td>` +
        `<td>${escape(trial.evidence)}</td>` +
        `<td class="where">${escape(trial.where)}</td></tr>`,
    )
    .join('');
  return `<div class="scroll"><table class="trials"><thead><tr>
    <th>What was tried</th><th class="v">Verdict</th><th>What decided it</th><th class="where">Evidence</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`;
}

/**
 * The stylesheet, inlined and small.
 *
 * The application's tokens are not imported. Linking a stylesheet that Vite
 * hashes and transforms would couple a static file to the bundle's build
 * output, which is exactly the coupling that makes a generated page stop being
 * generated. The few values worth agreeing on are repeated instead: neutrals
 * with no tint, hierarchy from size and spacing rather than weight, and nothing
 * heavier than 500.
 */
const STYLE = `
:root {
  --bg: oklch(99% 0 0);
  --surface: oklch(97.4% 0 0);
  --line-subtle: oklch(92.7% 0 0);
  --line: oklch(89.8% 0 0);
  --text-tertiary: oklch(62.5% 0 0);
  --text-secondary: oklch(50% 0 0);
  --text-primary: oklch(21.5% 0 0);
  --accent: oklch(52% 0.11 252);
  --ok: oklch(48% 0.09 150);
  --no: oklch(52% 0.1 27);
}
@font-face {
  font-family: 'Geist';
  src: url('/fonts/geist-latin-300-500.woff2') format('woff2');
  font-weight: 300 500;
  font-display: swap;
}
@font-face {
  font-family: 'Geist Mono';
  src: url('/fonts/geist-mono-latin-400.woff2') format('woff2');
  font-weight: 400;
  font-display: swap;
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 64px 24px 96px;
  max-width: 760px;
  background: var(--bg);
  color: var(--text-primary);
  font-family: 'Geist', system-ui, sans-serif;
  font-feature-settings: 'ss03';
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  letter-spacing: -0.003em;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { margin: 0; font-size: 15px; font-weight: 500; letter-spacing: -0.009em; }
h2 {
  margin: 64px 0 0;
  padding-top: 20px;
  border-top: 1px solid var(--line);
  font-size: 20px;
  font-weight: 400;
  letter-spacing: -0.012em;
}
h3 { margin: 40px 0 0; font-size: 14px; font-weight: 500; }
p { margin: 8px 0 0; }
.lede, .blurb { color: var(--text-secondary); max-width: 62ch; }
.finding { max-width: 62ch; }
.caveat, .cmd { color: var(--text-tertiary); font-size: 12px; line-height: 18px; }
.mono, code, td.n, th.n { font-family: 'Geist Mono', ui-monospace, monospace; }
code { font-size: 11.5px; }
.scroll { overflow-x: auto; margin-top: 16px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; line-height: 18px; }
th, td { padding: 7px 12px 7px 0; text-align: left; vertical-align: baseline; white-space: nowrap; }
th {
  border-bottom: 1px solid var(--line);
  color: var(--text-secondary);
  font-weight: 400;
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
td { border-bottom: 1px solid var(--line-subtle); }
tr:last-child td { border-bottom: 0; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; }
th.n:first-of-type, td.n:first-of-type { padding-left: 24px; }
.trials td { white-space: normal; }
.trials td:first-child { width: 30%; }
.trials .where { color: var(--text-tertiary); font-size: 11.5px; }
.trials .v { width: 1%; white-space: nowrap; }
.tag {
  display: inline-block;
  padding: 1px 7px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 10.5px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.tag--adopted { color: var(--ok); }
.tag--rejected { color: var(--no); }
.tag--open { color: var(--text-tertiary); }
footer {
  margin-top: 64px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 19px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(16% 0 0);
    --surface: oklch(19% 0 0);
    --line-subtle: oklch(25% 0 0);
    --line: oklch(30% 0 0);
    --text-tertiary: oklch(55% 0 0);
    --text-secondary: oklch(70% 0 0);
    --text-primary: oklch(94% 0 0);
    --accent: oklch(75% 0.1 252);
    --ok: oklch(72% 0.11 150);
    --no: oklch(70% 0.13 27);
  }
}
`;

export function renderPage(page: Page): string {
  const groups = page.groups
    .map(
      (group) =>
        `<h2>${escape(group.title)}</h2><p class="blurb">${escape(group.blurb)}</p>` +
        group.measurements.map(renderMeasurement).join(''),
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rotyl — what was measured</title>
<meta name="robots" content="noindex">
<style>${STYLE}</style>
</head>
<body>
<h1><a href="/">Rotyl</a></h1>
<p class="lede">Every number this project has taken, and every approach it has
tried and dropped. The figures are read out of the benchmark harnesses' own
results at build time rather than typed here, so a table on this page cannot
disagree with the run that produced it.</p>
<p class="lede">Taken on ${escape(page.hardware)}. Every GPU figure is fenced
with <code>queue.onSubmittedWorkDone()</code> on the device that did the work.
The arguments behind them are in the READMEs, next to the code they justify.</p>
${groups}
<h2>Trials</h2>
<p class="blurb">What was tried, what it measured, and what happened to it. A
rejection with a number attached is worth more than an opinion, and it is the
only thing that stops the same idea being re-litigated every few months.</p>
${renderTrials(page.trials)}
<footer>
Generated from <code>tools/video-bench/results.json</code> and
<code>tools/style-bench/results.json</code>. Re-take them with
<code>node tools/video-bench/run.mjs all</code> and
<code>node tools/style-bench/run.mjs all</code>, in real Chrome, on a quiet
machine.
</footer>
</body>
</html>
`;
}
