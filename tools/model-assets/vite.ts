import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import manifest from '../../models/edgetam/manifest.json' with { type: 'json' };

interface VerifiedAsset {
  readonly name: string;
  readonly bytes: Buffer;
  readonly servedName: string;
}

function contentType(name: string): string {
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  if (name.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export async function readVerifiedModelAssets(root: string): Promise<readonly VerifiedAsset[]> {
  const directory = path.join(root, '.model-assets', manifest.version);
  return Promise.all(
    Object.entries(manifest.files).map(async ([name, expected]) => {
      let bytes: Buffer;
      try {
        bytes = await readFile(path.join(directory, name));
      } catch (cause) {
        if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
          throw new Error(`Model asset ${name} is absent. Run pnpm models; no deployment was produced.`, {
            cause,
          });
        }
        throw cause;
      }

      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.byteLength !== expected.bytes || digest !== expected.sha256) {
        throw new Error(
          `Model asset ${name} does not match ${manifest.version}. ` +
            `Expected ${String(expected.bytes)} bytes and SHA-256 ${expected.sha256}; ` +
            `received ${String(bytes.byteLength)} bytes and ${digest}. No deployment was produced.`,
        );
      }
      return {
        name,
        bytes: expected.feature === 'legal' ? bytes : gzipSync(bytes, { level: 9 }),
        servedName: expected.feature === 'legal' ? name : `${name}.gz`,
      };
    }),
  );
}

export function modelAssets(): Plugin {
  let config: ResolvedConfig;
  let verified: Promise<readonly VerifiedAsset[]>;

  return {
    name: 'rotyl:model-assets',
    applyToEnvironment(environment) {
      return environment.name === 'client';
    },
    configResolved(resolved) {
      config = resolved;
      verified = readVerifiedModelAssets(resolved.root);
    },
    async buildStart() {
      const assets = await verified;
      if (config.command !== 'build') return;
      for (const asset of assets) {
        this.emitFile({
          type: 'asset',
          fileName: `models/edgetam/${manifest.version}/${asset.servedName}`,
          source: asset.bytes,
        });
      }
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use((request, response, next) => {
        void (async () => {
          const requested = request.url?.split('?')[0];
          const prefix = `${config.base}models/edgetam/${manifest.version}/`.replaceAll('//', '/');
          if (!requested?.startsWith(prefix)) {
            next();
            return;
          }

          const servedName = decodeURIComponent(requested.slice(prefix.length));
          const asset = (await verified).find((candidate) => candidate.servedName === servedName);
          if (!asset) {
            next();
            return;
          }
          response.setHeader('Content-Type', contentType(asset.servedName));
          response.setHeader('Content-Length', String(asset.bytes.byteLength));
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          response.end(asset.bytes);
        })().catch(next);
      });
    },
  };
}
