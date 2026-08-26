// The six licensed stills through the real product entry point.
//
// Not a helper and not a bench prompt: this posts a consented request to
// handleIllustrated exactly as the browser does, so consent gating, the terms
// version, the vision read, the keep list and the draw all run as shipped.
//
//   FAL_KEY=... node --experimental-strip-types --experimental-transform-types \
//     tools/style-bench/illustrated-eval-product.ts

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField } from '../../src/core/illustrated/request.ts';
import {
  ILLUSTRATED_LONG_EDGE,
  ILLUSTRATED_MAX_BYTES,
  ILLUSTRATED_TERMS_VERSION,
} from '../../src/core/illustrated/terms.ts';
import { handleIllustrated } from '../../worker/illustrated.ts';

async function prepareStill(file: string): Promise<Buffer> {
  const scale = `scale='if(gte(iw,ih),${String(ILLUSTRATED_LONG_EDGE)},-1)':'if(gt(ih,iw),${String(ILLUSTRATED_LONG_EDGE)},-1)'`;
  const child = spawn(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      scale,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => {
      resolve(status ?? 1);
    });
  });
  if (code !== 0) throw new Error('ffmpeg could not shrink the still.');
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength === 0) throw new Error('ffmpeg wrote an empty still.');
  return bytes;
}

const here = dirname(fileURLToPath(import.meta.url));
const listed = readField(JSON.parse(await readFile(join(here, 'evaluation-set.json'), 'utf8')), 'stills');
const stills: Array<{ readonly id: string; readonly file: string }> = [];
if (Array.isArray(listed)) {
  for (const still of listed) {
    const id = readField(still, 'id');
    const file = readField(still, 'file');
    if (typeof id === 'string' && typeof file === 'string' && id.startsWith('portrait-')) {
      stills.push({ id, file });
    }
  }
}

// Extra pictures can be named on the command line, as paths under this folder.
// The six are single frontal sitters, so a group shot or a profile is the kind
// of thing that has to be run here rather than assumed from them.
for (const arg of process.argv.slice(2)) {
  const id = arg.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  stills.push({ id, file: arg });
}

const key = process.env.FAL_KEY;
if (!key) throw new Error('FAL_KEY is not set.');

const resultsPath = join(here, 'results-illustrated-eval-product.json');
const results = {
  schema: 1 as const,
  publishReady: false as const,
  path: `Product entry point, terms ${ILLUSTRATED_TERMS_VERSION}`,
  note: 'Posted to handleIllustrated as the browser does. Publish-ready stays false until a person judges the licensed set and it clears.',
  stills: [] as Array<Record<string, unknown>>,
};

await mkdir(join(here, 'out', 'illustrated', 'product'), { recursive: true });
for (const still of stills) {
  const relative = `out/illustrated/product/${still.id}-0.jpg`;
  try {
    await access(join(here, relative), fsConstants.R_OK);
    results.stills.push({ id: still.id, ok: true, outputs: [relative] });
    console.log(`eval-product: ${still.id} reused`);
    continue;
  } catch {
    /* missing */
  }
  const started = Date.now();
  const bytes = await prepareStill(join(here, still.file));
  if (bytes.byteLength > ILLUSTRATED_MAX_BYTES) {
    results.stills.push({ id: still.id, ok: false, error: 'still is over the worker byte limit' });
    console.error(`eval-product: ${still.id} is over ILLUSTRATED_MAX_BYTES`);
    continue;
  }
  const response = await handleIllustrated(
    new Request('http://rotyl.local/api/illustrated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        consent: { version: ILLUSTRATED_TERMS_VERSION, accepted: true },
        image: { mime: 'image/jpeg', data: bytes.toString('base64') },
      }),
    }),
    { FAL_KEY: key },
  );
  const elapsedMs = Date.now() - started;
  if (!response.ok) {
    const detail = await response.text();
    results.stills.push({ id: still.id, ok: false, status: response.status, error: detail, elapsedMs });
    console.error(`eval-product: ${still.id} failed ${String(response.status)} ${detail}`);
  } else {
    await writeFile(join(here, relative), Buffer.from(await response.arrayBuffer()));
    results.stills.push({
      id: still.id,
      ok: true,
      status: response.status,
      contentType: response.headers.get('Content-Type'),
      bytes: bytes.byteLength,
      elapsedMs,
      outputs: [relative],
    });
    console.log(`eval-product: ${still.id} ${String(elapsedMs)}ms`);
  }
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
}
await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
console.log('eval-product: done. publishReady remains false.');
