import { beforeAll, describe, it } from 'vitest';
import { COMIC_STYLE } from '../src/core/style/comic/comic-style-pipeline.ts';
import {
  expectFiniteEverywhere,
  expectSelectedTransformed,
  expectUnselectedUntouched,
  renderSplit,
  type SplitRender,
} from './style-harness.ts';

/** The compositor's contract, for the comic style. See `style-harness.ts`. */
describe('comic', () => {
  let rendered: SplitRender;

  beforeAll(async () => {
    rendered = await renderSplit(COMIC_STYLE, 192);
  });

  it('leaves unselected pixels byte-identical to the source', () => {
    expectUnselectedUntouched(rendered);
  });

  it('visibly transforms the selected region', () => {
    expectSelectedTransformed(rendered);
  });

  it('produces a finite result everywhere', () => {
    expectFiniteEverywhere(rendered);
  });
});
