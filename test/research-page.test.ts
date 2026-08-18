import { describe, expect, it } from 'vitest';
import { renderResearchPage } from '../tools/research/index.ts';
import { renderPage } from '../tools/research/page.ts';
import { TRIALS } from '../tools/research/trials.ts';

/**
 * The page is generated from the harnesses' results at build time, so this is
 * the test that the generation still works — and, more usefully, that every
 * figure on it still has a measurement behind it.
 *
 * The extractors throw on a missing path rather than returning undefined, which
 * makes "a benchmark stopped reporting this" a build failure instead of a blank
 * cell. Rendering the whole page here is what turns that into a test failure
 * one commit earlier.
 */
describe('the research page', () => {
  const html = renderResearchPage();

  it('renders every measurement from the results files', () => {
    expect(html).toContain('<!doctype html>');
    // Thirteen measurements across four sections; a table that failed to build
    // would have thrown above rather than rendered empty.
    expect((html.match(/<table/g) ?? []).length).toBeGreaterThanOrEqual(14);
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
  });

  it('reads the hardware out of the results rather than asserting it', () => {
    expect(html).toContain('metal-3');
    expect(html).toMatch(/Chrome \d+/);
  });

  it('escapes the text it is given', () => {
    // Everything on the page is interpolated, including prose and the labels a
    // benchmark chose for its own rows. One angle bracket arriving from a
    // results file would silently swallow a table.
    const hostile = renderPage({
      hardware: 'a machine <script>alert(1)</script>',
      trials: [{ what: '<b>x</b>', verdict: 'open', evidence: '&', where: '<i>y</i>' }],
      groups: [
        {
          title: 'x',
          blurb: 'y',
          measurements: [
            {
              title: 'z',
              finding: 'w',
              table: { columns: ['<th>'], rows: [['</td><script>']] },
            },
          ],
        },
      ],
    });
    expect(hostile).not.toContain('<script>');
    expect(hostile).toContain('&lt;script&gt;');
    expect(hostile).toContain('&amp;');
  });

  it('gives every trial something specific enough to argue with', () => {
    // The rule the ledger is worth keeping under: an entry that cannot say what
    // decided it is an opinion, and opinions do not stop an idea being
    // re-litigated every few months.
    for (const trial of TRIALS) {
      expect(trial.evidence.length, trial.what).toBeGreaterThan(40);
      expect(trial.where.length, trial.what).toBeGreaterThan(8);
    }
    expect(TRIALS.some((trial) => trial.verdict === 'adopted')).toBe(true);
    expect(TRIALS.some((trial) => trial.verdict === 'open')).toBe(true);
  });
});
