import { describe, expect, it } from 'vitest';
import { renderResearchSite } from '../tools/research/index.ts';
import { renderEntry } from '../tools/research/page.ts';
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
describe('the research pages', () => {
  const pages = renderResearchSite();
  const html = pages.map((page) => page.html).join('\n');

  it('emits an index and a page per entry', () => {
    expect(pages[0]?.path).toBe('research.html');
    expect(pages.map((page) => page.path)).toContain('research/the-look.html');
    expect(pages.map((page) => page.path)).toContain('research/trials.html');
    // Every entry on the index has a page, and every page is linked from it.
    const index = pages[0]?.html ?? '';
    for (const page of pages.slice(1)) {
      expect(index, page.path).toContain(`href="/${page.path}"`);
    }
  });

  it('renders every measurement from the results files', () => {
    for (const page of pages) expect(page.html, page.path).toContain('<!doctype html>');
    // A table that failed to build would have thrown while generating rather
    // than rendered empty, so counting them is counting successful reads.
    expect((html.match(/<table/g) ?? []).length).toBeGreaterThanOrEqual(14);
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
  });

  it('is light, like the editor', () => {
    // Rotyl has no dark mode on purpose: a neutral light surround is what lets
    // someone judge a photograph.
    expect(html).toContain('name="color-scheme" content="light"');
    expect(html).not.toContain('prefers-color-scheme');
  });

  it('gives every entry a table of contents that points at its own headings', () => {
    for (const page of pages.slice(1)) {
      for (const [, id] of page.html.matchAll(/<h2 id="([^"]+)"/g)) {
        expect(page.html, page.path).toContain(`href="#${id ?? ''}"`);
      }
    }
  });

  it('reads the hardware out of the results rather than asserting it', () => {
    expect(html).toContain('metal-3');
    expect(html).toMatch(/Chrome \d+/);
  });

  it('escapes the text it is given', () => {
    // Everything on the page is interpolated, including prose and the labels a
    // benchmark chose for its own rows. One angle bracket arriving from a
    // results file would silently swallow a table.
    const hostile = renderEntry({
      slug: 'x',
      title: '<script>alert(1)</script>',
      standfirst: '&',
      harness: '<i>y</i>',
      lede: ['<b>x</b>'],
      sections: [
        {
          heading: 'z',
          prose: ['w'],
          table: { columns: ['<th>'], rows: [['</td><script>']] },
        },
      ],
      trials: [{ what: '<b>x</b>', verdict: 'open', evidence: '&', where: '<i>y</i>' }],
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
