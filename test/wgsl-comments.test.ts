import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripWgslComments } from '../vite.config.ts';

/**
 * The build step that lets this codebase comment its shaders as heavily as its
 * TypeScript without shipping a word of it.
 *
 * Tested here rather than trusted because the failure mode is silent in both
 * directions: strip too little and the saving quietly disappears, strip too
 * much and a shader stops compiling in a build that no test renders.
 */
describe('stripping WGSL comments', () => {
  it('preserves the line count exactly', () => {
    // Load-bearing. A WGSL compile error is a line and a column into the
    // concatenated source, and shaders are concatenated in a fixed order, so a
    // transform that removed blank lines would point every production shader
    // error at the wrong place.
    const source = readFileSync('src/core/style/poster/wgsl/poster.wgsl', 'utf8');
    const lines = (text: string): number => text.split('\n').length;
    expect(lines(stripWgslComments(source))).toBe(lines(source));
  });

  it('removes both comment forms and keeps the code between them', () => {
    const stripped = stripWgslComments(`// a line comment
fn keep() -> f32 { /* inline */ return 1.0; } // trailing
/**
 * A doc comment.
 */
fn also() {}`);

    expect(stripped).not.toContain('comment');
    expect(stripped).not.toContain('inline');
    expect(stripped).toContain('fn keep() -> f32 {  return 1.0; }');
    expect(stripped).toContain('fn also() {}');
  });

  it('leaves every shader in the project non-empty and free of comment markers', () => {
    // A sweep rather than a sample: the guarantee is about the shaders that
    // exist, and a new one arrives with every style.
    const shaders = [
      'src/core/color/color.wgsl',
      'src/core/gpu/fullscreen-vertex.wgsl',
      'src/core/style/wgsl/palette.wgsl',
      'src/core/style/wgsl/bilateral.wgsl',
      'src/core/style/wgsl/levels.wgsl',
      'src/core/style/wgsl/downsample.wgsl',
      'src/core/render/wgsl/composite.wgsl',
    ];
    for (const path of shaders) {
      const stripped = stripWgslComments(readFileSync(path, 'utf8'));
      expect(stripped, path).not.toContain('//');
      expect(stripped, path).not.toContain('/*');
      expect(stripped.trim().length, path).toBeGreaterThan(50);
    }
  });
});
