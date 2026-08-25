// Configured hosted illustrated run. publishReady stays false here.
//
//   FAL_KEY=... pnpm exec vite-node tools/style-bench/illustrated-eval.ts

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleIllustrated } from '../../worker/illustrated.ts';
import { readField } from '../../src/core/illustrated/request.ts';
import {
  ILLUSTRATED_LONG_EDGE,
  ILLUSTRATED_TERMS,
  ILLUSTRATED_TERMS_VERSION,
} from '../../src/core/illustrated/terms.ts';

/**
 * Same long-edge shrink the editor applies before a still leaves. The licensed
 * files are several megapixels; the worker cap is a 1280 JPEG.
 */
async function prepareStill(file: string): Promise<Buffer> {
  const scale = `scale='if(gte(iw,ih),${String(ILLUSTRATED_LONG_EDGE)},-1)':'if(gt(ih,iw),${String(ILLUSTRATED_LONG_EDGE)},-1)'`;
  const child = spawn(
    'ffmpeg',
    ['-nostdin', '-v', 'error', '-i', file, '-vf', scale, '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errors.push(chunk);
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => {
      resolve(status ?? 1);
    });
  });
  if (code !== 0) {
    const detail = Buffer.concat(errors).toString().trim();
    throw new Error(detail.length > 0 ? detail : 'ffmpeg could not shrink the still.');
  }
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
    if (typeof id === 'string' && typeof file === 'string') stills.push({ id, file });
  }
}
const outDir = join(here, 'out', 'illustrated');
const resultsPath = join(here, 'results-illustrated-eval.json');
const key = process.env.FAL_KEY;

if (!key) {
  throw new Error('FAL_KEY is not set. node tools/style-bench/illustrated-eval.mjs records the skip.');
}

await mkdir(outDir, { recursive: true });
const results: {
  schema: 1;
  publishReady: false;
  path: string;
  termsVersion: string;
  skipped: false;
  note: string;
  stills: Array<Record<string, unknown>>;
} = {
  schema: 1,
  publishReady: false,
  path: ILLUSTRATED_TERMS.path,
  termsVersion: ILLUSTRATED_TERMS_VERSION,
  skipped: false,
  note: 'Sheets were written. Publish-ready stays false until a person judges the licensed set.',
  stills: [],
};

for (const still of stills) {
  const file = join(here, still.file);
  try {
    await access(file);
  } catch {
    results.stills.push({
      id: still.id,
      skipped: true,
      reason: 'still is not local; run fetch-evaluation.sh',
    });
    continue;
  }
  const bytes = await prepareStill(file);
  const started = Date.now();
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
    results.stills.push({ id: still.id, ok: false, elapsedMs, error: await response.text() });
    continue;
  }
  const output = join(outDir, `${still.id}.jpg`);
  await writeFile(output, Buffer.from(await response.arrayBuffer()));
  results.stills.push({ id: still.id, ok: true, elapsedMs, output: `out/illustrated/${still.id}.jpg` });
}

await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
console.log('illustrated-eval: wrote sheets. publishReady remains false.');
