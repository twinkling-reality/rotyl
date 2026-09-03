// A whole clip restyled at once, which is a different question from a still.
//
//   FAL_KEY=... node --experimental-strip-types --experimental-transform-types \
//     tools/style-bench/illustrated-eval-clip.ts
//
// The stills path draws one picture. Pointing it at a clip costs the stills
// price per frame and holds nothing still between them. This asks a video model
// for the whole clip instead, which is the only shape in which a drawn look can
// survive motion. Eval-only. Nothing in the product sends a clip.
//
// ROTYL_STRENGTH and ROTYL_RES only reach the wan v2.2 video-to-video model.
// The VACE branch of runFalWanVideo does not send either, so a strength read off
// a v2.2 run says nothing about a VACE one. The knobs here are ROTYL_GUIDANCE
// and ROTYL_PREPROCESS, and ROTYL_NEGATIVE has to be set to something before it
// is sent at all: left unset the job takes Fal's default, and that default
// suppresses style, artwork and painting.
//
// Whatever the prompt does not name, the model invents. With preprocess on, the
// input becomes a control signal and surface detail goes with it, so a prompt
// saying only "the dog" returned a different breed. See
// results-illustrated-eval-clip.json.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAL_WAN_VACE, runFalWanVideo } from '../../worker/illustrated.ts';

const here = dirname(fileURLToPath(import.meta.url));
const key = process.env.FAL_KEY;
if (!key) throw new Error('FAL_KEY is not set.');

const clip = process.env.ROTYL_CLIP ?? 'real/evaluation/tos-occlusion.mp4';
const tag = process.env.ROTYL_TAG ?? 'painted';
const prompt =
  process.env.ROTYL_PROMPT ??
  'Redraw this footage as a hand-painted illustration. Flat gouache shapes in a limited palette, loose visible brushwork, simplified forms, no photographic texture and no photographic shading. Keep every person and object where it is and keep the motion exactly as filmed.';

await mkdir(join(here, 'out', 'illustrated', 'clip'), { recursive: true });
const bytes = await readFile(join(here, clip));
const started = Date.now();
console.log(`eval-clip: ${clip} at ${String(bytes.byteLength)} bytes`);
const out = await runFalWanVideo({
  video: new Uint8Array(bytes),
  mime: 'video/mp4',
  host: { FAL_KEY: key },
  prompt,
  resolution: process.env.ROTYL_RES ?? '720p',
  strength: Number(process.env.ROTYL_STRENGTH ?? 0.85),
  numFrames: Number(process.env.ROTYL_FRAMES ?? 81),
  ...(process.env.ROTYL_VACE ? { model: FAL_WAN_VACE } : {}),
  ...(process.env.ROTYL_NEGATIVE === undefined ? {} : { negativePrompt: process.env.ROTYL_NEGATIVE }),
  ...(process.env.ROTYL_GUIDANCE === undefined ? {} : { guidance: Number(process.env.ROTYL_GUIDANCE) }),
  ...(process.env.ROTYL_PREPROCESS === undefined ? {} : { preprocess: process.env.ROTYL_PREPROCESS !== '0' }),
});
const relative = `out/illustrated/clip/${tag}.mp4`;
await writeFile(join(here, relative), out.bytes);
console.log(`eval-clip: wrote ${relative} in ${String(Date.now() - started)}ms`);
