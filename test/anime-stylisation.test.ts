import { beforeAll, describe, it } from 'vitest';
import { ANIME_STYLE } from '../src/core/style/anime/anime-style-pipeline.ts';
import {
  expectFiniteEverywhere,
  expectSelectedTransformed,
  expectUnselectedUntouched,
  renderSplit,
  type SplitRender,
} from './style-harness.ts';

/** The compositor's contract, for the anime style. See `style-harness.ts`. */
describe('anime', () => {
  let rendered: SplitRender;

  beforeAll(async () => {
    rendered = await renderSplit(ANIME_STYLE, 192);
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
