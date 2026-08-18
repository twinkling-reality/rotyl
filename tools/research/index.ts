import { readFileSync } from 'node:fs';
import { hardware, measurementGroups } from './measurements.ts';
import { renderPage } from './page.ts';
import { TRIALS } from './trials.ts';

/**
 * The research page, built from the results the harnesses wrote.
 *
 * Called by the Vite plugin in both development and production, so there is no
 * generated file in the repository to go stale and no build step to remember.
 * Reading the JSON here rather than importing it keeps the page current without
 * a dev-server restart when a benchmark is re-run.
 */
export function renderResearchPage(root = '.'): string {
  const read = (path: string): unknown => JSON.parse(readFileSync(`${root}/${path}`, 'utf8'));
  const style = read('tools/style-bench/results.json');
  const video = read('tools/video-bench/results.json');

  return renderPage({
    groups: measurementGroups(style, video),
    trials: TRIALS,
    hardware: hardware(video),
  });
}
