// Licensed illustrated stills on FLUX.2 Pro edit. publishReady stays false.
//
//   FAL_KEY=... node --experimental-strip-types --experimental-transform-types tools/style-bench/illustrated-eval-flux2.ts

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField } from '../../src/core/illustrated/request.ts';
import { ILLUSTRATED_LONG_EDGE } from '../../src/core/illustrated/terms.ts';
import { FAL_FLUX2_EDIT, runFalFlux2Edit } from '../../worker/illustrated.ts';

const PROMPT =
  'Transform this photograph into a cel-animation illustration with clean ink outlines and flat colour fills. Keep this exact person: the same face, age, skin, hair, eyes, expression, glasses, jewelry, headwear, clothes, hands, pose, and framing. Do not invent a different person. Do not drop or replace accessories.';

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
const stills: Array<{ readonly id: string; readonly file: string }> = [];
if (Array.isArray(listed)) {
  for (const still of listed) {
    const id = readField(still, 'id');
    const file = readField(still, 'file');
    if (typeof id === 'string' && typeof file === 'string') stills.push({ id, file });
  }
}
const tag = 'flux2-edit';
const outDir = join(here, 'out', 'illustrated', tag);
const resultsPath = join(here, 'results-illustrated-eval-flux2.json');
const key = process.env.FAL_KEY;

if (!key) {
  throw new Error('FAL_KEY is not set.');
}

await mkdir(outDir, { recursive: true });
const results: {
  schema: 1;
  publishReady: false;
  path: string;
  skipped: false;
  note: string;
  prompt: string;
  model: string;
  stills: Array<Record<string, unknown>>;
} = {
  schema: 1,
  publishReady: false,
  path: 'FLUX.2 Pro edit on Fal, this still',
  skipped: false,
  note: 'Sheets were written. Publish-ready stays false until a person judges the licensed set and it clears.',
  prompt: PROMPT,
  model: FAL_FLUX2_EDIT,
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
  const relative = `out/illustrated/${tag}/${still.id}-0.jpg`;
  try {
    await access(join(here, relative), fsConstants.R_OK);
    results.stills.push({ id: still.id, ok: true, reused: true, outputs: [relative] });
    console.log(`illustrated-eval-flux2: ${still.id} reused`);
    continue;
  } catch {
    /* missing */
  }
  const started = Date.now();
  try {
    console.log(`illustrated-eval-flux2: ${still.id}`);
    const bytes = await prepareStill(file);
    const images = await runFalFlux2Edit({
      still: new Uint8Array(bytes),
      mime: 'image/jpeg',
      host: { FAL_KEY: key },
      prompt: PROMPT,
      giveUpMs: 360_000,
    });
    const elapsedMs = Date.now() - started;
    const image = images[0];
    if (!image) throw new Error('Fal finished without a still.');
    await writeFile(join(here, relative), image.bytes);
    results.stills.push({ id: still.id, ok: true, elapsedMs, outputs: [relative] });
    await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`illustrated-eval-flux2: ${still.id} ${String(elapsedMs)}ms`);
  } catch (cause) {
    const elapsedMs = Date.now() - started;
    const error = cause instanceof Error ? cause.message : 'The illustrated job failed.';
    results.stills.push({ id: still.id, ok: false, elapsedMs, error });
    await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
    console.error(`illustrated-eval-flux2: ${still.id} failed: ${error}`);
    if (error.includes('403') || error.includes('Exhausted balance')) {
      throw cause;
    }
  }
}

await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
console.log('illustrated-eval-flux2: wrote sheets. publishReady remains false.');
