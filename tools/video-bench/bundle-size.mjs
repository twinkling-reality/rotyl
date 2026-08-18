// What the demuxer costs, through Rotyl's own build rather than a standalone
// bundler, because the answer depends on the bundler's tree shaking.
//
//   node tools/video-bench/bundle-size.mjs
//
// Measures the demux-only path, open a file, read the decoder config, walk
// packets, with one container format, then two, then three. The second is what
// the app ships; the third is what WebM would cost.

import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'vite';

const DIR = 'tools/video-bench/.bundle';
const CASES = [['MP4'], ['MP4', 'QTFF'], ['MP4', 'QTFF', 'WEBM']];

mkdirSync(DIR, { recursive: true });

for (const formats of CASES) {
  const list = formats.join(', ');
  writeFileSync(
    `${DIR}/entry.ts`,
    `import { BlobSource, EncodedPacketSink, Input, ${list} } from 'mediabunny';

export async function chunks(blob: Blob, at: number): Promise<EncodedVideoChunk[]> {
  const input = new Input({ formats: [${list}], source: new BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return [];
  await track.getDecoderConfig();
  const sink = new EncodedPacketSink(track);
  let packet = await sink.getKeyPacket(at);
  const out: EncodedVideoChunk[] = [];
  while (packet) {
    out.push(packet.toEncodedVideoChunk());
    packet = await sink.getNextPacket(packet);
  }
  input.dispose();
  return out;
}
`,
  );

  await build({
    root: DIR,
    logLevel: 'silent',
    build: {
      // es2022 rather than the app's es2023: this measures bytes, and an
      // esbuild old enough to reject the newer target is not worth chasing.
      target: 'es2022',
      lib: { entry: 'entry.ts', formats: ['es'], fileName: 'demux' },
      outDir: 'dist',
      emptyOutDir: true,
      minify: 'esbuild',
    },
  });

  const bytes = readFileSync(`${DIR}/dist/demux.js`);
  const gzip = gzipSync(bytes, { level: 9 }).length;
  console.log(`${list.padEnd(20)} raw ${String(bytes.length).padStart(7)}  gzip ${String(gzip).padStart(6)}`);
}

rmSync(DIR, { recursive: true, force: true });
