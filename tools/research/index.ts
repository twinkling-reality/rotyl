import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { entries, hardware } from './measurements.ts';
import { renderEntry, renderIndex, type Entry } from './page.ts';
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
 * The results files carry no timestamp of their own — a gap worth closing in
 * the harnesses eventually — so the commit that last touched one is the honest
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

export function renderResearchSite(root = '.'): readonly Emitted[] {
  const read = (path: string): unknown => JSON.parse(readFileSync(`${root}/${path}`, 'utf8'));
  const style = read('tools/style-bench/results.json');
  const video = read('tools/video-bench/results.json');

  const dated: readonly Entry[] = [
    ...entries(style, video).map((entry) => ({
      ...entry,
      date: lastChanged(
        entry.harness.startsWith('tools/style-bench')
          ? 'tools/style-bench/results.json'
          : 'tools/video-bench/results.json',
      ),
    })),
    {
      slug: 'trials',
      title: 'What was tried, and what happened to it',
      standfirst:
        'The ledger of rejected approaches, each with the number that decided it. The only page here not generated from a results file, because a rejection leaves none behind.',
      harness: 'tools/research/trials.ts',
      date: lastChanged('tools/research/trials.ts'),
      lede: [
        `Every measurement on the other pages was taken on ${hardware(video)}. This one is the residue of all of them: what was tried, what it measured, and what happened to it.`,
        'It exists because a rejected approach leaves no results.json behind, and the reasoning survives only in a README paragraph or in nobody’s head — which is how the same idea gets proposed twice a year and re-measured each time. The rule for an entry is that it has to name a number, or an observation specific enough to argue with.',
      ],
      sections: [],
      trials: TRIALS,
    },
  ];

  return [
    { path: 'research.html', html: renderIndex(dated) },
    ...dated.map((entry) => ({ path: `research/${entry.slug}.html`, html: renderEntry(entry) })),
  ];
}
