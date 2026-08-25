import { readFile } from 'node:fs/promises';
import { sites } from '@openai/sites-vite-plugin';
import { defineConfig, type Plugin } from 'vite';
import { renderResearchSite, researchFigures } from './tools/research/index.ts';
import { modelAssets } from './tools/model-assets/vite.ts';

/**
 * Strip WGSL comments, and keep every newline.
 *
 * Shaders reach the bundle as strings, so every line of explanation in them is
 * shipped to every user: 78 KB of WGSL across the style chain, of which two
 * thirds is comment. Removing it saves about 15 KB gzipped, which is a quarter
 * of the application bundle, the same order as the entire UI framework this
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

/**
 * The research page, generated rather than stored.
 *
 * It is a static file and not a route: the application bundle is 41 KB gzipped
 * and this project has twice chosen a smaller dependency over a nicer one, so
 * documentation does not go in it. Emitting it here rather than checking it in
 * means the numbers on it cannot disagree with the results files they came
 * from, and rendering it per request in development means re-running a
 * benchmark shows up on a refresh.
 */
/**
 * The hosted illustrated stills job, in development.
 *
 * Production goes through the Cloudflare worker. `pnpm dev` does not load that
 * worker, so the same handler is mounted here and reads FAL_KEY from the
 * environment. Without a key the panel still opens and Send stays disabled.
 */
function illustratedApi(): Plugin {
  return {
    name: 'rotyl:illustrated-api',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        if (path !== '/api/illustrated') return next();
        void (async () => {
          const { handleIllustrated } = await import('./worker/illustrated.ts');
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const headers = new Headers();
          for (const [key, value] of Object.entries(request.headers)) {
            if (typeof value === 'string') headers.set(key, value);
          }
          const init: RequestInit = { method: request.method ?? 'GET', headers };
          if (request.method === 'POST') init.body = Buffer.concat(chunks);
          const incoming = new Request(new URL(path, 'http://rotyl.local'), init);
          const falKey = process.env.FAL_KEY;
          const outgoing = await handleIllustrated(incoming, falKey ? { FAL_KEY: falKey } : {});
          response.statusCode = outgoing.status;
          outgoing.headers.forEach((value, key) => {
            response.setHeader(key, value);
          });
          const body = Buffer.from(await outgoing.arrayBuffer());
          response.end(body);
        })().catch(next);
      });
    },
  };
}

function researchPage(): Plugin {
  return {
    name: 'rotyl:research',
    applyToEnvironment(environment) {
      return environment.name === 'client';
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requested = request.url?.split('?')[0]?.replace(/^\//, '');
        if (!requested?.startsWith('research')) return next();
        // Rendered per request rather than once at startup, so re-running a
        // benchmark shows up on a refresh.
        const page = renderResearchSite().find(
          (candidate) => candidate.path === requested || candidate.path === `${requested}.html`,
        );
        if (page) {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(page.html);
          return;
        }
        const figure = researchFigures().find((candidate) => candidate.path === requested);
        if (!figure) return next();
        response.setHeader('Content-Type', 'image/webp');
        response.end(figure.bytes);
      });
    },
    generateBundle() {
      for (const page of renderResearchSite()) {
        this.emitFile({ type: 'asset', fileName: page.path, source: page.html });
      }
      for (const figure of researchFigures()) {
        this.emitFile({ type: 'asset', fileName: figure.path, source: figure.bytes });
      }
    },
  };
}

// No Preact plugin: the JSX transform is configured in tsconfig.json
// ("jsx": "react-jsx", "jsxImportSource": "preact") and Vite's transformer
// honours it. The plugin exists to add Babel-based Fast Refresh, which is not
// worth reintroducing Babel to this build for.
export default defineConfig(async ({ mode }) => {
  const plugins: Plugin[] = [wgslComments(), modelAssets(), researchPage(), illustratedApi()];
  if (mode === 'sites') {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    plugins.push(
      sites(),
      ...cloudflare({
        viteEnvironment: { name: 'server' },
        config: {
          main: './worker/index.ts',
          compatibility_date: '2026-05-22',
          assets: {
            binding: 'ASSETS',
            not_found_handling: 'single-page-application',
          },
        },
      }),
    );
  }

  return {
    plugins,
    build: {
      target: 'es2023',
      assetsInlineLimit: 0,
    },
  };
});
