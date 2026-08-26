// Leftover Fal spend on edit families past Seedream 4.5. publishReady stays false.
//
//   FAL_KEY=... node --experimental-strip-types --experimental-transform-types \
//     tools/style-bench/illustrated-eval-families.ts [family ...]
//
// With no argument every family runs, most promising first. Sheets that already
// exist are reused, so a re-run after a lock only spends on what is missing.

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField } from '../../src/core/illustrated/request.ts';
import { ILLUSTRATED_LONG_EDGE } from '../../src/core/illustrated/terms.ts';
import {
  FAL_FLUX2_FLEX_EDIT,
  FAL_GROK_EDIT,
  FAL_NANO_PRO_EDIT,
  FAL_QWEN_EDIT,
  FAL_SEEDREAM5_LITE_EDIT,
  FAL_SEEDREAM5_PRO_EDIT,
  runFalFlux2FlexEdit,
  runFalGrokEdit,
  runFalNanoProEdit,
  runFalQwenEdit,
  runFalSeedream5LiteEdit,
  runFalSeedream5ProEdit,
  type FalKontextJob,
  type PhotomakerImage,
} from '../../worker/illustrated.ts';
import { keepPrompt } from './illustrated-keep.ts';

interface Family {
  readonly tag: string;
  readonly model: string;
  readonly listPriceUsd?: number;
  readonly run: (job: FalKontextJob) => Promise<PhotomakerImage[]>;
}

// Seedream held costume best on the 4.5 sweep, so its successors go first.
const FAMILIES: readonly Family[] = [
  { tag: 'seedream5-pro', model: FAL_SEEDREAM5_PRO_EDIT, run: runFalSeedream5ProEdit },
  {
    tag: 'seedream5-lite',
    model: FAL_SEEDREAM5_LITE_EDIT,
    listPriceUsd: 0.035,
    run: runFalSeedream5LiteEdit,
  },
  { tag: 'nano-pro', model: FAL_NANO_PRO_EDIT, run: runFalNanoProEdit },
  { tag: 'qwen-edit', model: FAL_QWEN_EDIT, run: runFalQwenEdit },
  { tag: 'grok-edit', model: FAL_GROK_EDIT, listPriceUsd: 0.022, run: runFalGrokEdit },
  { tag: 'flux2-flex', model: FAL_FLUX2_FLEX_EDIT, run: runFalFlux2FlexEdit },
];

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
    if (typeof id === 'string' && typeof file === 'string' && id.startsWith('portrait-')) {
      stills.push({ id, file });
    }
  }
}

const key = process.env.FAL_KEY;
if (!key) throw new Error('FAL_KEY is not set.');

const asked = new Set(process.argv.slice(2));
const chosen = asked.size === 0 ? FAMILIES : FAMILIES.filter((family) => asked.has(family.tag));
if (chosen.length === 0) {
  throw new Error(`No such family. Known: ${FAMILIES.map((family) => family.tag).join(', ')}`);
}

const resultsPath = join(here, 'results-illustrated-eval-families.json');
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
  path: 'Seedream 5 Pro and Lite, Nano Banana Pro, Qwen, Grok Imagine, FLUX.2 Flex, keep-list',
  skipped: false,
  note: 'Sheets were written. Publish-ready stays false until a person judges the licensed set and it clears.',
  stills: [],
};

// One family per invocation is normal, so carry forward rows this run does not
// touch. Without this a later family would drop the earlier ones from the file.
try {
  const prior: unknown = JSON.parse(await readFile(resultsPath, 'utf8'));
  const priorStills = readField(prior, 'stills');
  if (Array.isArray(priorStills)) {
    const rerunning = new Set(chosen.map((family) => family.model));
    const rows: readonly unknown[] = priorStills;
    for (const row of rows) {
      const model = readField(row, 'model');
      if (typeof model !== 'string' || rerunning.has(model)) continue;
      if (typeof row !== 'object' || row === null) continue;
      const carried: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(row)) carried[field] = value;
      results.stills.push(carried);
    }
  }
} catch {
  /* first run */
}

for (const family of chosen) {
  await mkdir(join(here, 'out', 'illustrated', family.tag), { recursive: true });
  for (const still of stills) {
    const file = join(here, still.file);
    const relative = `out/illustrated/${family.tag}/${still.id}-0.jpg`;
    try {
      await access(file);
    } catch {
      results.stills.push({
        id: still.id,
        model: family.model,
        skipped: true,
        reason: 'still is not local; run fetch-evaluation.sh',
      });
      continue;
    }
    try {
      await access(join(here, relative), fsConstants.R_OK);
      results.stills.push({
        id: still.id,
        model: family.model,
        ok: true,
        reused: true,
        outputs: [relative],
      });
      console.log(`illustrated-eval-families: ${family.tag} ${still.id} reused`);
      continue;
    } catch {
      /* missing */
    }
    const started = Date.now();
    try {
      console.log(`illustrated-eval-families: ${family.tag} ${still.id}`);
      const bytes = await prepareStill(file);
      const prompt = keepPrompt(still.id);
      const images = await family.run({
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
        model: family.model,
        ok: true,
        elapsedMs,
        ...(family.listPriceUsd === undefined ? {} : { listPriceUsd: family.listPriceUsd }),
        prompt,
        outputs: [relative],
      });
      await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
      console.log(`illustrated-eval-families: ${family.tag} ${still.id} ${String(elapsedMs)}ms`);
    } catch (cause) {
      const elapsedMs = Date.now() - started;
      const error = cause instanceof Error ? cause.message : 'The illustrated job failed.';
      results.stills.push({ id: still.id, model: family.model, ok: false, elapsedMs, error });
      await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
      console.error(`illustrated-eval-families: ${family.tag} ${still.id} failed: ${error}`);
      if (error.includes('403') || error.includes('Exhausted balance')) {
        throw cause;
      }
    }
  }
}

await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
console.log('illustrated-eval-families: wrote sheets. publishReady remains false.');
