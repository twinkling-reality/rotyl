import { readFile } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';

/**
 * Strip WGSL comments, and keep every newline.
 *
 * Shaders reach the bundle as strings, so every line of explanation in them is
 * shipped to every user: 78 KB of WGSL across the style chain, of which two
 * thirds is comment. Removing it saves about 15 KB gzipped, which is a quarter
 * of the application bundle — the same order as the entire UI framework this
 * project chose Preact over React to avoid.
 *
 * NEWLINES SURVIVE, and that is the whole design of this function. A WGSL
 * compile error is reported as a line and a column into the concatenated
 * source, so collapsing blank lines would save a further kilobyte and make
 * every shader error in production point at the wrong place. Comment text
 * becomes nothing; the lines it occupied stay.
 *
 * Safe without a parser because WGSL has no string literals: there is nowhere
 * for `//` to appear that is not a comment.
 */
export function stripWgslComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, (block) => block.replaceAll(/[^\n]/g, ''))
    .replaceAll(/\/\/[^\n]*/g, '')
    .replaceAll(/[ \t]+$/gm, '');
}

/**
 * Applied in dev as well as in build, deliberately.
 *
 * A transform that only runs in production is a transform nothing tests: the
 * unit suite compiles shaders through Dawn from source and the end-to-end suite
 * runs against the dev server, so a stripping bug would first appear in a
 * shipped build. Running it everywhere means both suites exercise exactly the
 * string the user gets.
 */
function wgslComments(): Plugin {
  return {
    name: 'rotyl:wgsl-comments',
    enforce: 'pre',
    async load(id) {
      const [path, query] = id.split('?');
      if (query !== 'raw' || !path?.endsWith('.wgsl')) return null;
      return `export default ${JSON.stringify(stripWgslComments(await readFile(path, 'utf8')))}`;
    },
  };
}

// No Preact plugin: the JSX transform is configured in tsconfig.json
// ("jsx": "react-jsx", "jsxImportSource": "preact") and Vite's transformer
// honours it. The plugin exists to add Babel-based Fast Refresh, which is not
// worth reintroducing Babel to this build for.
export default defineConfig({
  plugins: [wgslComments()],
  build: {
    target: 'es2023',
    assetsInlineLimit: 0,
  },
});
