// Does a keep list the model writes itself work as well as one written by hand?
//
// The bench keep lists were written by a person looking at six known
// photographs. A real upload never gets that. This runs three prompts on the
// same still and the same family, so the only variable is where the keep list
// came from:
//
//   generic  what the product sends today, no costume detail at all
//   derived  a vision pass reads this still and writes its own keep list
//   hand     the bench keep list, as the ceiling to beat
//
//   FAL_KEY=... node --experimental-strip-types --experimental-transform-types \
//     tools/style-bench/illustrated-eval-derived.ts [generic|derived|hand ...]

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField } from '../../src/core/illustrated/request.ts';
import { ILLUSTRATED_LONG_EDGE } from '../../src/core/illustrated/terms.ts';
import { buildIllustratedPrompt } from '../../src/core/illustrated/prompt.ts';
import { FAL_NANO_PRO_EDIT, describeIllustratedKeep, runFalNanoProEdit } from '../../worker/illustrated.ts';
import { keepPrompt } from './illustrated-keep.ts';

const GENERIC = buildIllustratedPrompt('');
const MODES = ['generic', 'derived', 'hand'] as const;
type Mode = (typeof MODES)[number];

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

const key = process.env.FAL_KEY;
if (!key) throw new Error('FAL_KEY is not set.');

const asked = process.argv.slice(2).filter((arg): arg is Mode => (MODES as readonly string[]).includes(arg));
const modes: readonly Mode[] = asked.length > 0 ? asked : MODES;

const resultsPath = join(here, 'results-illustrated-eval-derived.json');
const results = {
  schema: 1 as const,
  publishReady: false as const,
  path: 'Nano Banana Pro, keep list generic vs derived vs hand written',
  note: 'Asks whether a model-written keep list matches a hand-written one. Publish-ready stays false.',
  stills: [] as Array<Record<string, unknown>>,
};
try {
  const prior: unknown = JSON.parse(await readFile(resultsPath, 'utf8'));
  const priorStills = readField(prior, 'stills');
  if (Array.isArray(priorStills)) {
    const rows: readonly unknown[] = priorStills;
    for (const row of rows) {
      const mode = readField(row, 'mode');
      const rerunning: readonly string[] = modes;
      if (typeof mode !== 'string' || rerunning.includes(mode)) continue;
      if (typeof row !== 'object' || row === null) continue;
      const carried: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(row)) carried[field] = value;
      results.stills.push(carried);
    }
  }
} catch {
  /* first run */
}

for (const mode of modes) {
  await mkdir(join(here, 'out', 'illustrated', 'derived', mode), { recursive: true });
  for (const still of stills) {
    const file = join(here, still.file);
    const relative = `out/illustrated/derived/${mode}/${still.id}-0.jpg`;
    const keepPath = join(here, 'out', 'illustrated', 'derived', mode, `${still.id}.txt`);
    try {
      await access(join(here, relative), fsConstants.R_OK);
      let keep: string | undefined;
      try {
        keep = await readFile(keepPath, 'utf8');
      } catch {
        /* none recorded */
      }
      results.stills.push({
        id: still.id,
        mode,
        model: FAL_NANO_PRO_EDIT,
        ok: true,
        ...(keep === undefined ? {} : { keep }),
        outputs: [relative],
      });
      console.log(`eval-derived: ${mode} ${still.id} reused`);
      continue;
    } catch {
      /* missing */
    }
    const started = Date.now();
    try {
      const bytes = await prepareStill(file);
      let prompt: string;
      let keep = '';
      if (mode === 'generic') {
        prompt = GENERIC;
      } else if (mode === 'hand') {
        prompt = keepPrompt(still.id);
      } else {
        console.log(`eval-derived: ${mode} ${still.id} reading the still`);
        keep = await describeIllustratedKeep({
          still: new Uint8Array(bytes),
          mime: 'image/jpeg',
          host: { FAL_KEY: key },
          prompt: '',
          giveUpMs: 180_000,
        });
        prompt = buildIllustratedPrompt(keep);
        await writeFile(keepPath, `${keep}\n`);
      }
      console.log(`eval-derived: ${mode} ${still.id}`);
      const images = await runFalNanoProEdit({
        still: new Uint8Array(bytes),
        mime: 'image/jpeg',
        host: { FAL_KEY: key },
        prompt,
        giveUpMs: 360_000,
      });
      const image = images[0];
      if (!image) throw new Error('Fal finished without a still.');
      await writeFile(join(here, relative), image.bytes);
      results.stills.push({
        id: still.id,
        mode,
        model: FAL_NANO_PRO_EDIT,
        ok: true,
        elapsedMs: Date.now() - started,
        ...(keep === '' ? {} : { keep }),
        prompt,
        outputs: [relative],
      });
      console.log(`eval-derived: ${mode} ${still.id} ${String(Date.now() - started)}ms`);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'The illustrated job failed.';
      results.stills.push({ id: still.id, mode, model: FAL_NANO_PRO_EDIT, ok: false, error });
      console.error(`eval-derived: ${mode} ${still.id} failed: ${error}`);
      if (error.includes('403') || error.includes('Exhausted balance')) throw cause;
    }
    await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  }
}
await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
console.log('eval-derived: wrote sheets. publishReady remains false.');
