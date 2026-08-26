// The same path at the size the picture can actually carry.
//
//   FAL_KEY=... node --experimental-strip-types --experimental-transform-types \
//     tools/style-bench/illustrated-eval-hires.ts [long-edge] [1K|2K|4K] [id ...]
//
// The product sends 1280 and asks for 1K, because the layer it composites is
// 1280 and the terms say so. Judging the drawing at that size and then looking
// at it larger is what made every sheet on this page read as soft. This asks
// what the same request looks like when the still and the answer are both given
// room. It is a bench question, not a change to what ships.

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField } from '../../src/core/illustrated/request.ts';
import { buildIllustratedPrompt } from '../../src/core/illustrated/prompt.ts';
import { describeIllustratedKeep, runFalNanoProEdit } from '../../worker/illustrated.ts';

const longEdge = Number(process.argv[2] ?? 2048);
const resolution = process.argv[3] ?? '4K';
const only = process.argv.slice(4);

async function prepareStill(file: string, edge: number): Promise<Buffer> {
  const scale = `scale='if(gte(iw,ih),${String(edge)},-1)':'if(gt(ih,iw),${String(edge)},-1)'`;
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
    if (typeof id !== 'string' || typeof file !== 'string') continue;
    if (!id.startsWith('portrait-')) continue;
    if (only.length > 0 && !only.includes(id)) continue;
    stills.push({ id, file });
  }
}

const key = process.env.FAL_KEY;
if (!key) throw new Error('FAL_KEY is not set.');

const tag = `hires-${String(longEdge)}-${resolution}`;
await mkdir(join(here, 'out', 'illustrated', tag), { recursive: true });
const resultsPath = join(here, 'results-illustrated-eval-hires.json');
const results = {
  schema: 1 as const,
  publishReady: false as const,
  path: `Nano Banana Pro, derived keep list, ${String(longEdge)} in and ${resolution} out`,
  note: 'A bench question about size. The product still sends 1280 and asks for 1K.',
  stills: [] as Array<Record<string, unknown>>,
};

for (const still of stills) {
  const relative = `out/illustrated/${tag}/${still.id}-0.jpg`;
  try {
    await access(join(here, relative), fsConstants.R_OK);
    console.log(`hires: ${still.id} reused`);
    results.stills.push({ id: still.id, ok: true, outputs: [relative] });
    continue;
  } catch {
    /* missing */
  }
  const started = Date.now();
  try {
    const bytes = await prepareStill(join(here, still.file), longEdge);
    const keep = await describeIllustratedKeep({
      still: new Uint8Array(bytes),
      mime: 'image/jpeg',
      host: { FAL_KEY: key },
      prompt: '',
      giveUpMs: 180_000,
    });
    const images = await runFalNanoProEdit({
      still: new Uint8Array(bytes),
      mime: 'image/jpeg',
      host: { FAL_KEY: key },
      prompt: buildIllustratedPrompt(keep),
      resolution,
      giveUpMs: 420_000,
    });
    const image = images[0];
    if (!image) throw new Error('Fal finished without a still.');
    await writeFile(join(here, relative), image.bytes);
    results.stills.push({
      id: still.id,
      ok: true,
      elapsedMs: Date.now() - started,
      sentLongEdge: longEdge,
      askedResolution: resolution,
      outputs: [relative],
    });
    console.log(`hires: ${still.id} ${String(Date.now() - started)}ms`);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'failed';
    results.stills.push({ id: still.id, ok: false, error });
    console.error(`hires: ${still.id} failed: ${error}`);
    if (error.includes('403') || error.includes('Exhausted balance')) throw cause;
  }
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
}
await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
console.log('hires: done. publishReady remains false.');
