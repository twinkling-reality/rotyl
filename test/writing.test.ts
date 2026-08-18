import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The house voice, as a test rather than as a note somebody has to remember.
 *
 * NO EM DASHES. Not a typographic preference: an em dash is where two thoughts
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
        if (line.includes('—')) offences.push(`${path}:${String(index + 1)}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('checks a meaningful number of files', () => {
    // A guard on the guard: a broken `git ls-files` would pass the assertion
    // above by finding nothing to read.
    expect(tracked().length).toBeGreaterThan(50);
  });
});
