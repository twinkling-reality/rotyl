import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { entries, hardware } from './measurements.ts';
import { renderEntry, renderIndex, type Entry, type FigureMeta } from './page.ts';
import { TRIALS } from './trials.ts';

/**
 * The research pages, built from the results the harnesses wrote.
 *
 * Called by the Vite plugin in both development and production, so there is no
 * generated file in the repository to go stale and no build step to remember.
 * Reading the JSON here rather than importing it keeps the pages current
 * without a dev-server restart when a benchmark is re-run.
 */

/**
 * When a measurement last changed, asked of the repository rather than of
 * anyone's memory.
 *
 * The results files carry no timestamp of their own, a gap worth closing in
 * the harnesses eventually, so the commit that last touched one is the honest
 * stand-in, and it answers the question a reader actually has: is this current.
 * Absent outside a checkout, which is a missing date rather than a wrong one.
 */
function lastChanged(path: string): string | undefined {
  try {
    const stamp = execFileSync('git', ['log', '-1', '--format=%cs', '--', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!stamp) return undefined;
    return new Date(`${stamp}T00:00:00Z`).toLocaleDateString('en-GB', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return undefined;
  }
}

export interface Emitted {
  /** Relative to the site root. */
  readonly path: string;
  readonly html: string;
}

export interface EmittedAsset {
  readonly path: string;
  readonly bytes: Buffer;
}

/** Where the harness leaves the pictures it rendered, and what it says they are. */
const FIGURES = 'tools/style-bench/figures';

/**
 * The figures, which are committed rather than generated at build.
 *
 * They need a GPU and a browser to produce, so the build cannot make them the
 * way it makes the tables. What it can do is refuse to reference one that is
 * not there: renderFigure throws on an unknown name, so a page can never link a
 * picture that was never rendered.
 */
export function researchFigures(root = '.'): readonly EmittedAsset[] {
  const meta = figureMeta(root);
  return meta.map((figure) => ({
    path: `research/figures/${figure.name}.webp`,
    bytes: readFileSync(`${root}/${FIGURES}/${figure.name}.webp`),
  }));
}

function figureMeta(root: string): readonly FigureMeta[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(`${root}/${FIGURES}/index.json`, 'utf8'));
  } catch {
    return [];
  }
  // Checked rather than asserted: this file is written by a separate tool, and
  // the failure it can produce is a caption describing a picture that is not
  // there, which reads as a fact.
  if (!Array.isArray(parsed)) throw new Error('research: the figure index is not a list');
  return parsed.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('research: a figure is not an object');
    const figure = entry as Partial<FigureMeta>;
    if (typeof figure.name !== 'string' || !Array.isArray(figure.tiles)) {
      throw new Error('research: a figure has no name or no tiles');
    }
    return {
      name: figure.name,
      width: Number(figure.width),
      height: Number(figure.height),
      columns: Number(figure.columns),
      tiles: figure.tiles.map(String),
    };
  });
}

export function renderResearchSite(root = '.'): readonly Emitted[] {
  const read = (path: string): unknown => JSON.parse(readFileSync(`${root}/${path}`, 'utf8'));
  const style = read('tools/style-bench/results.json');
  // Its own file because its own command writes it, and because its inputs have
  // to be fetched before it can run at all. See tools/style-bench/fetch-real.sh.
  const real = read('tools/style-bench/results-real.json');
  const video = read('tools/video-bench/results.json');
  // Written by a Python harness against PyTorch rather than by a browser, which
  // is why it is neither of the two above.
  const tracking = read('tools/edgetam-export/results.json');
  // Its own file and its own page, because it is its own finding and its own
  // command: what the two graphs are worth is one question, and whether the
  // host around them says the same thing as the reference is another.
  const host = read('tools/edgetam-export/host.json');
  // Its own file because its own command writes it, and because that command
  // needs a tracking host: without one there is nothing to fetch the two graphs
  // from, so it cannot be part of a run everyone can take.
  const tracked = read('tools/video-bench/results-tracked-frame.json');
  const shrink = read('tools/edgetam-export/shrink.json');
  // Its own file because its own command writes it: bundle sizes need a build
  // and no browser, so they are not part of the run the other numbers come from.
  const bundle = read('tools/video-bench/results-bundle.json');
  // And the same for the command log, which is arithmetic over a data
  // structure: no GPU, no clips, nothing to fetch. Re-taking it inside the run
  // the decode and encode figures come from would re-date every one of them for
  // a measurement that shares nothing with any of them.
  const log = read('tools/video-bench/results-log.json');
  // And the same again for how long a clip can be, which takes twenty minutes
  // and ends by running the tab out of memory. Not a thing to do in the middle
  // of the run every other figure here comes from.
  const long = read('tools/video-bench/results-long-clip.json');
  // And the same again for where the sound goes, which needs no GPU and answers
  // a question about byte layout: taking it inside the run above would re-date
  // every decode and encode figure whenever somebody asked about audio.
  const sound = read('tools/video-bench/results-interleave.json');
  // Its own file and its own command, because it needs a clip with motion in it
  // that the other style measurements do not, and because it answers a question
  // about a method rather than about a chain.
  const still = read('tools/style-bench/results-motion.json');

  const taken = hardware(video);
  const pages: readonly Entry[] = [
    ...entries({ style, real, video, tracking, tracked, host, shrink, bundle, log, long, sound, still }),
    {
      slug: 'trials',
      title: 'What was tried, and what happened to it',
      standfirst:
        'The ledger of rejected approaches, each with the number that decided it. The only page here not generated from a results file, because a rejection leaves none behind.',
      harness: 'hand, from the other five',
      results: 'tools/research/trials.ts',
      lede: [
        `Every measurement on the other pages was taken on ${taken}. This one is the residue of all of them: what was tried, what it measured, and what happened to it.`,
        'It exists because a rejected approach leaves no results file behind, and the reasoning survives only in a README paragraph or in nobody’s head, which is how the same idea gets proposed twice a year and re-measured each time. The rule for an entry is that it has to name a number, or an observation specific enough to argue with.',
      ],
      sections: [],
      trials: TRIALS,
    },
  ];

  const stamped = pages.map((entry) => ({ ...entry, taken, date: lastChanged(entry.results) }));

  const meta = figureMeta(root);
  return [
    { path: 'research.html', html: renderIndex(stamped) },
    ...stamped.map((entry) => ({
      path: `research/${entry.slug}.html`,
      html: renderEntry(entry, meta),
    })),
  ];
}
