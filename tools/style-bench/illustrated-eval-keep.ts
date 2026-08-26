// Still-specific Fal edit spend. publishReady stays false.
//
//   FAL_KEY=... node --experimental-strip-types --experimental-transform-types tools/style-bench/illustrated-eval-keep.ts

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField } from '../../src/core/illustrated/request.ts';
import { ILLUSTRATED_LONG_EDGE } from '../../src/core/illustrated/terms.ts';
import { FAL_KONTEXT_MAX, FAL_NANO_EDIT, runFalKontext, runFalNanoEdit } from '../../worker/illustrated.ts';
import { keepPrompt } from './illustrated-keep.ts';

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

async function probeSize(file: string): Promise<{ width: number; height: number }> {
  const child = spawn(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0:s=x',
      file,
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
  const text = Buffer.concat(chunks).toString().trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (code !== 0 || !match) {
    const detail = Buffer.concat(errors).toString().trim();
    throw new Error(detail.length > 0 ? detail : `ffprobe could not read ${file}`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function nearestAspect(width: number, height: number): string {
  const ratio = width / height;
  const options: Array<readonly [string, number]> = [
    ['21:9', 21 / 9],
    ['16:9', 16 / 9],
    ['4:3', 4 / 3],
    ['3:2', 3 / 2],
    ['1:1', 1],
    ['2:3', 2 / 3],
    ['3:4', 3 / 4],
    ['9:16', 9 / 16],
    ['9:21', 9 / 21],
  ];
  let best = options[0]!;
  for (const option of options) {
    if (Math.abs(option[1] - ratio) < Math.abs(best[1] - ratio)) best = option;
  }
  return best[0];
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
const key = process.env.FAL_KEY;
if (!key) throw new Error('FAL_KEY is not set.');

const resultsPath = join(here, 'results-illustrated-eval-keep.json');
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
  path: 'Kontext max keep-list, then Nano Banana 2 edit',
  skipped: false,
  note: 'Sheets were written. Publish-ready stays false until a person judges the licensed set and it clears.',
  stills: [],
};

const jobs = [
  { tag: 'kontext-keep', model: FAL_KONTEXT_MAX, listPriceUsd: 0.08 as const },
  { tag: 'nano-edit', model: FAL_NANO_EDIT, listPriceUsd: 0.08 as const },
];

for (const job of jobs) {
  await mkdir(join(here, 'out', 'illustrated', job.tag), { recursive: true });
  for (const still of stills) {
    const file = join(here, still.file);
    const relative = `out/illustrated/${job.tag}/${still.id}-0.jpg`;
    try {
      await access(file);
    } catch {
      results.stills.push({
        id: still.id,
        model: job.model,
        skipped: true,
        reason: 'still is not local; run fetch-evaluation.sh',
      });
      continue;
    }
    try {
      await access(join(here, relative), fsConstants.R_OK);
      results.stills.push({
        id: still.id,
        model: job.model,
        ok: true,
        reused: true,
        outputs: [relative],
      });
      console.log(`illustrated-eval-keep: ${job.tag} ${still.id} reused`);
      continue;
    } catch {
      /* missing */
    }
    const started = Date.now();
    try {
      console.log(`illustrated-eval-keep: ${job.tag} ${still.id}`);
      const bytes = await prepareStill(file);
      const prompt = keepPrompt(still.id);
      const size = await probeSize(file);
      const images =
        job.model === FAL_KONTEXT_MAX
          ? await runFalKontext({
              still: new Uint8Array(bytes),
              mime: 'image/jpeg',
              host: { FAL_KEY: key },
              prompt,
              model: FAL_KONTEXT_MAX,
              aspectRatio: nearestAspect(size.width, size.height),
              numImages: 1,
              giveUpMs: 360_000,
            })
          : await runFalNanoEdit({
              still: new Uint8Array(bytes),
              mime: 'image/jpeg',
              host: { FAL_KEY: key },
              prompt,
              giveUpMs: 360_000,
            });
      const elapsedMs = Date.now() - started;
      const image = images[0];
      if (!image) throw new Error('Fal finished without a still.');
      await writeFile(join(here, relative), image.bytes);
      results.stills.push({
        id: still.id,
        model: job.model,
        ok: true,
        elapsedMs,
        prompt,
        outputs: [relative],
      });
      await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
      console.log(`illustrated-eval-keep: ${job.tag} ${still.id} ${String(elapsedMs)}ms`);
    } catch (cause) {
      const elapsedMs = Date.now() - started;
      const error = cause instanceof Error ? cause.message : 'The illustrated job failed.';
      results.stills.push({ id: still.id, model: job.model, ok: false, elapsedMs, error });
      await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
      console.error(`illustrated-eval-keep: ${job.tag} ${still.id} failed: ${error}`);
      if (error.includes('403') || error.includes('Exhausted balance')) {
        throw cause;
      }
    }
  }
}

await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
console.log('illustrated-eval-keep: wrote sheets. publishReady remains false.');
