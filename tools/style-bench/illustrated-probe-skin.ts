// Is the skin drift on dark-skinned sitters promptable, or baked into the family?
// Re-runs the two worst stills with the complexion pinned, so the sheets differ
// from the six-family sweep only by that clause.
//
//   FAL_KEY=... node --experimental-strip-types --experimental-transform-types \
//     tools/style-bench/illustrated-probe-skin.ts

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField } from '../../src/core/illustrated/request.ts';
import { ILLUSTRATED_LONG_EDGE } from '../../src/core/illustrated/terms.ts';
import {
  FAL_NANO_PRO_EDIT,
  FAL_SEEDREAM5_PRO_EDIT,
  runFalNanoProEdit,
  runFalSeedream5ProEdit,
  type FalKontextJob,
  type PhotomakerImage,
} from '../../worker/illustrated.ts';
import { SKIN_CLAUSE, keepPrompt } from './illustrated-keep.ts';

const FAMILIES = [
  { tag: 'seedream5-pro', model: FAL_SEEDREAM5_PRO_EDIT, run: runFalSeedream5ProEdit },
  { tag: 'nano-pro', model: FAL_NANO_PRO_EDIT, run: runFalNanoProEdit },
] as const satisfies ReadonlyArray<{
  tag: string;
  model: string;
  run: (job: FalKontextJob) => Promise<PhotomakerImage[]>;
}>;

const asked = process.argv.slice(2).filter((arg) => arg.startsWith('portrait-'));
const onlyFamily = process.argv.slice(2).find((arg) => !arg.startsWith('portrait-'));
const STILLS = asked.length > 0 ? asked : ['portrait-somali', 'portrait-hands'];

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
  return Buffer.concat(chunks);
}

const here = dirname(fileURLToPath(import.meta.url));
const listed = readField(JSON.parse(await readFile(join(here, 'evaluation-set.json'), 'utf8')), 'stills');
const byId = new Map<string, string>();
if (Array.isArray(listed)) {
  for (const still of listed) {
    const id = readField(still, 'id');
    const file = readField(still, 'file');
    if (typeof id === 'string' && typeof file === 'string') byId.set(id, file);
  }
}

const key = process.env.FAL_KEY;
if (!key) throw new Error('FAL_KEY is not set.');

const resultsPath = join(here, 'results-illustrated-probe-skin.json');
const results = {
  schema: 1 as const,
  publishReady: false as const,
  path: 'Complexion pinned, Seedream 5 Pro and Nano Banana Pro, somali and hands',
  note: 'Asks whether the measured skin drift is promptable. Publish-ready stays false.',
  stills: [] as Array<Record<string, unknown>>,
};

for (const family of FAMILIES.filter((entry) => onlyFamily === undefined || entry.tag === onlyFamily)) {
  await mkdir(join(here, 'out', 'illustrated', 'skin-pinned', family.tag), { recursive: true });
  for (const id of STILLS) {
    const rel = byId.get(id);
    if (rel === undefined) continue;
    const relative = `out/illustrated/skin-pinned/${family.tag}/${id}-0.jpg`;
    try {
      await access(join(here, relative), fsConstants.R_OK);
      console.log(`probe-skin: ${family.tag} ${id} reused`);
      results.stills.push({ id, model: family.model, ok: true, outputs: [relative] });
      continue;
    } catch {
      /* missing */
    }
    const started = Date.now();
    try {
      console.log(`probe-skin: ${family.tag} ${id}`);
      const bytes = await prepareStill(join(here, rel));
      const prompt = `${keepPrompt(id)} ${SKIN_CLAUSE}`;
      const images = await family.run({
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
        id,
        model: family.model,
        ok: true,
        elapsedMs: Date.now() - started,
        prompt,
        outputs: [relative],
      });
      console.log(`probe-skin: ${family.tag} ${id} ${String(Date.now() - started)}ms`);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'failed';
      results.stills.push({ id, model: family.model, ok: false, error });
      console.error(`probe-skin: ${family.tag} ${id} failed: ${error}`);
    }
    await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  }
}
await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
console.log('probe-skin: wrote sheets. publishReady remains false.');
