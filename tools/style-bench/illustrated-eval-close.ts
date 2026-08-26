// Extra Fal spend on the close cap failure. publishReady stays false.
//
//   FAL_KEY=... node --experimental-strip-types --experimental-transform-types tools/style-bench/illustrated-eval-close.ts

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField } from '../../src/core/illustrated/request.ts';
import { ILLUSTRATED_LONG_EDGE } from '../../src/core/illustrated/terms.ts';
import { FAL_KONTEXT_MAX, runFalKontext } from '../../worker/illustrated.ts';

const PROMPT =
  'Transform this photograph into a cel-animation illustration with clean ink outlines and flat colour fills. Keep this exact person, these hands, this camera, and this landscape. The baseball cap is solid black and faces the same way as in the photograph. Do not add a red strap. Do not wear the cap backward.';

const SEEDS = [11, 23, 41, 67];

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
const close = Array.isArray(listed)
  ? listed.find((still) => readField(still, 'id') === 'portrait-close')
  : undefined;
const fileName = close ? readField(close, 'file') : undefined;
if (typeof fileName !== 'string') throw new Error('portrait-close is missing from the evaluation set.');
const file = join(here, fileName);
const key = process.env.FAL_KEY;
if (!key) throw new Error('FAL_KEY is not set.');

const tag = 'close-seeds';
const outDir = join(here, 'out', 'illustrated', tag);
const resultsPath = join(here, 'results-illustrated-eval-close.json');
await mkdir(outDir, { recursive: true });
const bytes = await prepareStill(file);
const results: {
  schema: 1;
  publishReady: false;
  path: string;
  skipped: false;
  note: string;
  stills: Array<Record<string, unknown>>;
} = {
  schema: 1,
  publishReady: false,
  path: 'Kontext max, portrait-close, four seeds, no red strap',
  skipped: false,
  note: 'Sheets were written. Publish-ready stays false until a person judges the licensed set and it clears.',
  stills: [],
};

for (const seed of SEEDS) {
  const relative = `out/illustrated/${tag}/portrait-close-${String(seed)}.jpg`;
  try {
    await access(join(here, relative), fsConstants.R_OK);
    results.stills.push({ id: 'portrait-close', seed, ok: true, reused: true, outputs: [relative] });
    console.log(`illustrated-eval-close: seed ${String(seed)} reused`);
    continue;
  } catch {
    /* missing */
  }
  const started = Date.now();
  try {
    console.log(`illustrated-eval-close: seed ${String(seed)}`);
    const images = await runFalKontext({
      still: new Uint8Array(bytes),
      mime: 'image/jpeg',
      host: { FAL_KEY: key },
      prompt: PROMPT,
      model: FAL_KONTEXT_MAX,
      aspectRatio: '3:2',
      seed,
      numImages: 1,
      giveUpMs: 360_000,
    });
    const elapsedMs = Date.now() - started;
    const image = images[0];
    if (!image) throw new Error('Fal finished without a still.');
    await writeFile(join(here, relative), image.bytes);
    results.stills.push({ id: 'portrait-close', seed, ok: true, elapsedMs, outputs: [relative] });
    await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`illustrated-eval-close: seed ${String(seed)} ${String(elapsedMs)}ms`);
  } catch (cause) {
    const elapsedMs = Date.now() - started;
    const error = cause instanceof Error ? cause.message : 'The illustrated job failed.';
    results.stills.push({ id: 'portrait-close', seed, ok: false, elapsedMs, error });
    await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
    console.error(`illustrated-eval-close: seed ${String(seed)} failed: ${error}`);
    if (error.includes('403') || error.includes('Exhausted balance')) throw cause;
  }
}

await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
console.log('illustrated-eval-close: wrote sheets. publishReady remains false.');
