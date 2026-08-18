/**
 * The research pages: an index, and one page per thing that was measured.
 *
 * GENERATED, NEVER WRITTEN. Figures come out of the results JSON the benchmark
 * harnesses produce, by path, at build time. That is not tidiness. It is the
 * one failure these pages exist to prevent. Every table in every README is
 * transcribed by hand, and transcription is how "the print chain has never been
 * timed" survived three chapters after it stopped being true. A path that no
 * longer resolves fails the build rather than printing a stale number to a
 * reader who has no way of knowing.
 *
 * Static files, not routes. The application bundle is 41 KB gzipped and this
 * project has twice chosen a smaller dependency over a nicer one; documentation
 * inside the editor would undo that for pages nobody opens while they are
 * working. Vite serves them in development and emits them at build, and they
 * cost the application nothing in either.
 *
 * LIGHT ONLY, like the editor. Rotyl has no dark mode on purpose, a neutral
 * light surround is what lets someone judge a photograph, and a set of pages
 * about that editor that flipped to dark at night would be a different product
 * wearing the same name.
 */

export interface Table {
  /** The first column is the row's label; the rest are figures. */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * A picture the harness produced, named rather than described.
 *
 * The tile labels and the layout come from the figure's own metadata, written
 * beside it when it was rendered, so a caption cannot describe a picture that
 * changed underneath it. All an entry supplies is why the picture is there.
 */
export interface Figure {
  /** A file in tools/style-bench/figures, without extension. */
  readonly name: string;
  /** What it is for. The tile listing is composed from the figure itself. */
  readonly caption: string;
}

export interface FigureMeta {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly tiles: readonly string[];
}

export interface Section {
  readonly heading: string;
  /** One or more paragraphs. What the number MEANS; the table says what it is. */
  readonly prose: readonly string[];
  readonly table?: Table;
  readonly figure?: Figure;
  readonly caveat?: string;
  /** How to take it again. Absent when nothing automated takes it. */
  readonly command?: string;
}

export type Verdict = 'adopted' | 'rejected' | 'open';

export interface Trial {
  readonly what: string;
  readonly verdict: Verdict;
  /** The number or observation that decided it. */
  readonly evidence: string;
  readonly where: string;
}

export interface Entry {
  /** Its file name, without extension. */
  readonly slug: string;
  readonly title: string;
  /** The line under the title on the index: what this one is about. */
  readonly standfirst: string;
  /** Where the numbers came from, and how to take them again. */
  readonly harness: string;
  /** When the figures last changed, from the repository rather than from memory. */
  readonly date?: string | undefined;
  /** The machine they were taken on, read out of the results themselves. */
  readonly taken?: string | undefined;
  readonly lede: readonly string[];
  /** Shown under the lede: what this entry is about, rather than decoration. */
  readonly hero?: Figure;
  readonly sections: readonly Section[];
  /** Rendered after the sections, on the one entry that is a ledger. */
  readonly trials?: readonly Trial[];
}

const escape = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A heading, as an id a table of contents can point at. */
const anchor = (heading: string): string =>
  heading
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');

const STYLE = `
:root {
  --bg: oklch(99% 0 0);
  /* A hover tint has to be seen to be an affordance. The editor's own surface
     token is 1.6 points off the page and reads as nothing at this size. */
  --hover: oklch(96.6% 0 0);
  --line-subtle: oklch(93.5% 0 0);
  --line: oklch(89.8% 0 0);
  --line-strong: oklch(82% 0 0);
  --text-tertiary: oklch(62.5% 0 0);
  --text-secondary: oklch(48% 0 0);
  --text-primary: oklch(21.5% 0 0);
  --accent: oklch(52% 0.11 252);
  --ok: oklch(46% 0.09 150);
  --no: oklch(50% 0.1 27);
  --sans: 'Geist', system-ui, -apple-system, sans-serif;
  /* No serif is shipped. This project subsets the two families it uses down to
     the weights it uses, and a third face for documentation would cost more
     than the whole application bundle. Every platform has a good one. */
  --serif: ui-serif, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
  --mono: 'Geist Mono', ui-monospace, monospace;
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
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text-primary);
  font-family: var(--sans);
  font-feature-settings: 'ss03';
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  letter-spacing: -0.003em;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
p a, li a { color: var(--accent); }
p a:hover, li a:hover { text-decoration: underline; }

/* The one piece of chrome: where you are, and the way back. No rule under it.
   the editor draws its own only once there is a file to separate from, and a
   line above a page that opens on whitespace is separating nothing. */
.top {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 22px 32px;
  font-size: 13px;
}
.top a:hover { color: var(--accent); }
.top .sep { color: var(--line-strong); }
.top .here {
  color: var(--text-tertiary);
  /* An entry's title is a sentence; on a narrow screen it must not wrap the
     trail onto a second line. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wrap { max-width: 880px; margin: 0 auto; padding: 72px 32px 120px; }

h1 { margin: 0; font-family: var(--serif); font-size: 34px; font-weight: 400; line-height: 42px; letter-spacing: -0.01em; }
.standfirst { margin: 12px 0 0; color: var(--text-secondary); font-size: 15px; line-height: 24px; max-width: 60ch; }

/* The index: a date and a title. Nothing else earns a column, which file
   produced a measurement is the entry's business, not the list's. */
.list { margin-top: 56px; }
.row {
  display: grid;
  grid-template-columns: 130px 1fr;
  gap: 24px;
  /* Padded and pulled back out, so the hover tint has room to breathe without
     the text moving. */
  padding: 26px 20px;
  margin: 0 -20px;
  border-top: 1px solid var(--line-subtle);
  border-radius: 6px;
  color: inherit;
  transition: background var(--dur, 140ms) ease;
}
.list .row:last-child { border-bottom: 1px solid var(--line-subtle); }
/* THE WHOLE ROW IS THE TARGET. A title-only hit area on a row this tall means
   most of what looks like a link is not one, which reads as a broken page
   rather than as restraint. */
.row:hover { background: var(--hover); }
.row:hover .what { color: var(--accent); }
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.row .when { color: var(--text-tertiary); font-size: 13px; font-variant-numeric: tabular-nums; }
.row .what { font-family: var(--serif); font-size: 21px; line-height: 30px; }
.row .about { margin: 4px 0 0; color: var(--text-secondary); max-width: 62ch; }

/* An entry: a column of prose, and a table of contents beside it.
   The hidden default comes FIRST: declared after the media query it wins on
   source order, the aside leaves the grid, and the prose lands in the 220px
   column meant for the contents. */
.entry { display: grid; grid-template-columns: minmax(0, 720px); gap: 0; }
.toc { display: none; }
@media (min-width: 1100px) {
  .wrap.entry-wrap { max-width: 1180px; }
  .entry { grid-template-columns: 220px minmax(0, 720px); gap: 64px; }
  .toc { display: block; }
}
.toc nav { position: sticky; top: 40px; }
.toc ol { margin: 0; padding: 0; list-style: none; }
.toc li { margin-bottom: 10px; }
.toc a { color: var(--text-secondary); font-size: 12.5px; line-height: 18px; display: block; }
.toc a:hover { color: var(--accent); }
.toc .label { margin-bottom: 16px; color: var(--text-tertiary); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }

.body { min-width: 0; }
.meta { margin: 20px 0 0; color: var(--text-tertiary); font-size: 13px; }
.meta code { font-family: var(--mono); font-size: 11.5px; }
.lede p { font-family: var(--serif); font-size: 19px; line-height: 31px; color: var(--text-primary); margin: 24px 0 0; }

h2 { margin: 56px 0 0; font-family: var(--serif); font-size: 24px; font-weight: 400; line-height: 32px; letter-spacing: -0.008em; }
.body p { margin: 16px 0 0; font-family: var(--serif); font-size: 17px; line-height: 28px; }
.body .caveat { font-family: var(--sans); font-size: 13px; line-height: 21px; color: var(--text-secondary); }
.body .cmd {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
  font-family: var(--sans);
  font-size: 12px;
  color: var(--text-tertiary);
}
/* Labelled, because an unexplained shell command in the middle of prose reads
   as debris rather than as an invitation. */
.cmd__label { font-size: 10.5px; letter-spacing: 0.04em; text-transform: uppercase; }
code { font-family: var(--mono); font-size: 0.86em; }

figure { margin: 32px 0 0; }
figure img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--line-subtle);
  border-radius: 3px;
}
figcaption {
  margin-top: 10px;
  color: var(--text-secondary);
  font-family: var(--sans);
  font-size: 12.5px;
  line-height: 19px;
}

.scroll { overflow-x: auto; margin-top: 24px; }
table { width: 100%; border-collapse: collapse; font-family: var(--sans); font-size: 12.5px; line-height: 18px; }
th, td { padding: 8px 14px 8px 0; text-align: left; vertical-align: baseline; white-space: nowrap; }
th {
  border-bottom: 1px solid var(--line);
  color: var(--text-tertiary);
  font-weight: 400;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
td { border-bottom: 1px solid var(--line-subtle); }
tr:last-child td { border-bottom: 0; }
td.n, th.n { text-align: right; padding-right: 0; font-family: var(--mono); font-variant-numeric: tabular-nums; }
th.n + th.n, td.n + td.n { padding-left: 28px; }

.trials td { white-space: normal; }
.trials td:first-child { width: 28%; font-family: var(--sans); }
.trials .where { color: var(--text-tertiary); font-size: 11.5px; }
.trials .v { width: 1%; white-space: nowrap; }
.tag {
  display: inline-block;
  padding: 1px 7px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.tag--adopted { color: var(--ok); }
.tag--rejected { color: var(--no); }
.tag--open { color: var(--text-tertiary); }

footer {
  margin-top: 72px;
  padding-top: 22px;
  border-top: 1px solid var(--line-subtle);
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 20px;
}
footer p { margin: 0 0 10px; max-width: 68ch; }
footer p:last-child { margin-bottom: 0; }
`;

function shell(title: string, top: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex">
<style>${STYLE}</style>
</head>
<body>
${top}
${main}
</body>
</html>
`;
}

/**
 * A path, not a menu.
 *
 * The application puts "Research" in the top RIGHT, where the actions live,
 * because there it is somewhere to go. Here it is where you already are, so it
 * belongs on the left as a trail back, the same word doing two different jobs,
 * and the side is what says which. The last segment is not a link, because a
 * link to the page you are on is a dead end dressed as a way out.
 */
const breadcrumb = (here?: string): string =>
  `<nav class="top" aria-label="Breadcrumb"><a href="/">Rotyl</a>` +
  (here
    ? `<span class="sep" aria-hidden="true">/</span><a href="/research.html">Research</a>` +
      `<span class="sep" aria-hidden="true">/</span><span class="here" aria-current="page">${escape(here)}</span>`
    : `<span class="sep" aria-hidden="true">/</span><span class="here" aria-current="page">Research</span>`) +
  `</nav>`;

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

function renderSection(section: Section, meta: readonly FigureMeta[]): string {
  return [
    `<h2 id="${anchor(section.heading)}">${escape(section.heading)}</h2>`,
    ...section.prose.map((paragraph) => `<p>${escape(paragraph)}</p>`),
    section.figure ? renderFigure(section.figure, meta) : '',
    section.table ? renderTable(section.table) : '',
    section.caveat ? `<p class="caveat">${escape(section.caveat)}</p>` : '',
    section.command
      ? `<p class="cmd"><span class="cmd__label">Re-take this</span><code>${escape(section.command)}</code></p>`
      : '',
  ].join('');
}

/**
 * A figure, with the tiles named in the order they were laid out.
 *
 * Named in the caption rather than drawn into the pixels: a label baked into an
 * image is unreadable at half width, unselectable, invisible to a screen reader
 * and impossible to correct without re-rendering.
 */
function renderFigure(figure: Figure, meta: readonly FigureMeta[]): string {
  const found = meta.find((candidate) => candidate.name === figure.name);
  if (!found) throw new Error(`research: no figure called ${figure.name} was generated`);

  const order = found.columns >= found.tiles.length ? 'Left to right' : 'Clockwise from top left';
  const listed =
    found.tiles.length > 1
      ? ` ${order}: ${found.tiles.slice(0, -1).join(', ')} and ${found.tiles.at(-1) ?? ''}.`
      : '';

  return `<figure>
<img src="/research/figures/${escape(found.name)}.webp" width="${String(found.width)}" height="${String(found.height)}" alt="${escape(figure.caption)}" loading="lazy">
<figcaption>${escape(figure.caption)}${escape(listed)}</figcaption>
</figure>`;
}

export function renderEntry(entry: Entry, meta: readonly FigureMeta[] = []): string {
  const toc = entry.sections
    .map((section) => `<li><a href="#${anchor(section.heading)}">${escape(section.heading)}</a></li>`)
    .join('');

  const main = `<div class="wrap entry-wrap"><div class="entry">
<aside class="toc"><nav><div class="label">On this page</div><ol>${toc}</ol></nav></aside>
<main class="body">
<h1>${escape(entry.title)}</h1>
<p class="meta">${escape(entry.date ?? '')}</p>
<div class="lede">${entry.lede.map((paragraph) => `<p>${escape(paragraph)}</p>`).join('')}</div>
${entry.hero ? renderFigure(entry.hero, meta) : ''}
${entry.sections.map((section) => renderSection(section, meta)).join('')}
${entry.trials ? renderTrials(entry.trials) : ''}
<footer>
<p>Measured by <code>${escape(entry.harness)}</code>${entry.taken ? `, on ${escape(entry.taken)}` : ''}.
Every GPU figure is fenced on the device that did the work, and the tables here
are read out of that harness's own results when this page is built rather than
typed into it, so a number on this page cannot disagree with the run that
produced it.</p>
<p>The commands beside each table re-take that measurement. Run them in real
Chrome, on a machine doing nothing else; the arguments behind the numbers are in
the README next to the code they justify.</p>
</footer>
</main></div></div>`;

  return shell(`${entry.title}. Rotyl`, breadcrumb(entry.title), main);
}

export function renderIndex(entries: readonly Entry[]): string {
  const rows = entries
    .map(
      (entry) =>
        `<a class="row" href="/research/${entry.slug}.html">` +
        `<div class="when">${escape(entry.date ?? '')}</div>` +
        `<div><div class="what">${escape(entry.title)}</div>` +
        `<p class="about">${escape(entry.standfirst)}</p></div></a>`,
    )
    .join('');

  // One line, about what a reader will find rather than about how the page is
  // built. How it is built is a property of the entries, and each of them says
  // so where it matters.
  const main = `<div class="wrap">
<h1>Research</h1>
<p class="standfirst">What was measured, and what it cost to find out.</p>
<div class="list">${rows}</div>
</div>`;

  return shell('Research. Rotyl', breadcrumb(), main);
}
