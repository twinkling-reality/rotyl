import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The house voice, as a test rather than as a note somebody has to remember.
 *
 * NO EM DASHES. Not a typographic preference: the character is where two thoughts
 * get welded into one sentence, and the sentence that comes out is one nobody
 * can take in at a glance. Removing it forces the choice the writing was
 * avoiding, which is a comma when the second half is subordinate and a full
 * stop when it is not.
 *
 * Checked across everything the project writes, prose and code comments alike,
 * because a codebase that comments as heavily as this one comments in the same
 * voice it documents in.
 */

const BINARY = /\.(woff2|png|jpe?g|mp4|webm|webp|lock)$/;

/**
 * Built from its code point rather than written.
 *
 * A literal here would make this file the one place in the repository that
 * fails its own rule, and the fix for that is either an exception or a lie
 * about what the rule is. This way there is no exception: the character does
 * not appear in the project at all.
 */
const EM_DASH = String.fromCodePoint(0x2014);

/**
 * A heading as GitHub will link to it: lowercased, punctuation dropped, spaces
 * to hyphens.
 */
const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replaceAll(/[^\w\- ]/g, '')
    .replaceAll(' ', '-');

function tracked(): readonly string[] {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((path) => path.length > 0 && !BINARY.test(path));
}

describe('the house voice', () => {
  it('uses no em dashes anywhere', () => {
    const offences: string[] = [];
    for (const path of tracked()) {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      for (const [index, line] of text.split('\n').entries()) {
        if (line.includes(EM_DASH)) offences.push(`${path}:${String(index + 1)}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('has no internal link pointing at a heading that is not there', () => {
    // A contents block is worth having only while it is true, and a README long
    // enough to need one is long enough that nobody notices when a section gets
    // renamed underneath it.
    const broken: string[] = [];
    for (const path of tracked().filter((candidate) => candidate.endsWith('.md'))) {
      const text = readFileSync(path, 'utf8');
      const headings = new Set(
        [...text.matchAll(/^#{1,6} +(.+?)\s*$/gm)].map((match) => slug(match[1] ?? '')),
      );
      for (const [, anchor] of text.matchAll(/\]\(#([^)]+)\)/g)) {
        if (anchor !== undefined && !headings.has(anchor)) broken.push(`${path} -> #${anchor}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('has no link pointing at a file that is not there', () => {
    // Documentation split across files is only better than one long file while
    // the links between them hold, and nothing else in the build reads them.
    const broken: string[] = [];
    for (const path of tracked().filter((candidate) => candidate.endsWith('.md'))) {
      const text = readFileSync(path, 'utf8');
      for (const [, target] of text.matchAll(/]\(([^)#][^)]*)\)/g)) {
        // Only relative paths: an http link is somebody else's to keep alive.
        if (target === undefined || /^[a-z]+:/i.test(target)) continue;
        const file = target.split('#')[0];
        if (file && !existsSync(join(dirname(path), file))) broken.push(`${path} -> ${file}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('checks a meaningful number of files', () => {
    // A guard on the guard: a broken `git ls-files` would pass the assertion
    // above by finding nothing to read.
    expect(tracked().length).toBeGreaterThan(50);
  });
});
