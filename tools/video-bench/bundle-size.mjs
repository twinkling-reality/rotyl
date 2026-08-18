// What the container code costs, through Rotyl's own build rather than a
// standalone bundler, because the answer depends on the bundler's tree shaking.
//
//   node tools/video-bench/bundle-size.mjs
//
// Two questions, one command. READING a file: open it, read the decoder config,
// walk packets, with one container format, then two, then three. The second is
// what the app ships and the third is what WebM would cost. WRITING one: stand
// up an Output, encode frames into it and finalize, for one container and then
// two, and then for reading and writing together, which is the shape a video
// chunk carrying both would have.

import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'vite';

const DIR = 'tools/video-bench/.bundle';

/** Open a file and walk its packets. What the app does today. */
const demux = (formats) => ({
  imports: ['BlobSource', 'EncodedPacketSink', 'Input', ...formats],
  body: `
export async function chunks(blob: Blob, at: number): Promise<EncodedVideoChunk[]> {
  const input = new Input({ formats: [${formats.join(', ')}], source: new BlobSource(blob) });
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
}`,
});

/**
 * Write a file: pick a codec the browser will encode, add one video track,
 * push frames through it, finalize.
 *
 * Deliberately the whole of what a clip export needs and no more. Measuring
 * `Output` alone would understate it, because the encoder wrapper, the quality
 * model and the codec probe are all separate modules that only get pulled in
 * once something actually encodes.
 */
const mux = (formats) => ({
  imports: [
    'BufferTarget',
    'Output',
    'QUALITY_HIGH',
    'VideoSample',
    'VideoSampleSource',
    'getFirstEncodableVideoCodec',
    ...formats,
  ],
  body: `
const FORMATS = { ${formats.map((name) => `${name}: () => new ${name}()`).join(', ')} };

export async function write(kind: keyof typeof FORMATS, frames: VideoFrame[]): Promise<ArrayBuffer> {
  const format = FORMATS[kind]();
  const codec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), {
    width: frames[0]!.displayWidth,
    height: frames[0]!.displayHeight,
  });
  if (!codec) throw new Error('nothing encodable');
  const output = new Output({ format, target: new BufferTarget() });
  const source = new VideoSampleSource({ codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  for (const frame of frames) {
    const sample = new VideoSample(frame);
    await source.add(sample);
    sample.close();
  }
  source.close();
  await output.finalize();
  return output.target.buffer!;
}`,
});

/**
 * Write a file from packets somebody else encoded.
 *
 * The muxer with the encoder wrapper taken off, so the 40-odd kilobytes above
 * can be attributed. If most of it is the wrapper rather than the container
 * writer, driving `VideoEncoder` by hand and piping packets in would be a real
 * option; if most of it is the container writer, it would buy nothing.
 */
const muxPackets = () => ({
  imports: ['BufferTarget', 'EncodedVideoPacketSource', 'Mp4OutputFormat', 'Output', 'EncodedPacket'],
  body: `
export async function writePackets(packets: EncodedVideoChunk[], meta: EncodedVideoChunkMetadata): Promise<ArrayBuffer> {
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  let first = true;
  for (const chunk of packets) {
    await source.add(EncodedPacket.fromEncodedChunk(chunk), first ? meta : undefined);
    first = false;
  }
  source.close();
  await output.finalize();
  return output.target.buffer!;
}`,
});

/** Both halves in one module, which is what a single video chunk would hold. */
const both = (read, write) => ({
  imports: [...new Set([...read.imports, ...write.imports])],
  body: `${read.body}\n${write.body}`,
});

const READ_MP4 = demux(['MP4']);
const READ_BOTH = demux(['MP4', 'QTFF']);
const WRITE_MP4 = mux(['Mp4OutputFormat']);

const CASES = [
  ['read MP4', READ_MP4],
  ['read MP4 QTFF', READ_BOTH],
  ['read MP4 QTFF WEBM', demux(['MP4', 'QTFF', 'WEBM'])],
  ['write MP4, packets only', muxPackets()],
  ['write MP4', WRITE_MP4],
  ['write MP4 MOV', mux(['Mp4OutputFormat', 'MovOutputFormat'])],
  ['write MP4 WEBM', mux(['Mp4OutputFormat', 'WebMOutputFormat'])],
  ['read MP4 QTFF + write MP4', both(READ_BOTH, WRITE_MP4)],
];

mkdirSync(DIR, { recursive: true });

const measured = [];
for (const [name, entry] of CASES) {
  writeFileSync(
    `${DIR}/entry.ts`,
    `import { ${entry.imports.join(', ')} } from 'mediabunny';\n${entry.body}\n`,
  );

  await build({
    root: DIR,
    logLevel: 'silent',
    build: {
      // es2022 rather than the app's es2023: this measures bytes, and an
      // esbuild old enough to reject the newer target is not worth chasing.
      target: 'es2022',
      lib: { entry: 'entry.ts', formats: ['es'], fileName: 'container' },
      outDir: 'dist',
      emptyOutDir: true,
      minify: 'oxc',
    },
  });

  const bytes = readFileSync(`${DIR}/dist/container.js`);
  const gzip = gzipSync(bytes, { level: 9 }).length;
  measured.push({ name, raw: bytes.length, gzip });
  console.log(`${name.padEnd(26)} raw ${String(bytes.length).padStart(7)}  gzip ${String(gzip).padStart(6)}`);
}

// The numbers the design turns on, computed rather than eyeballed off the table:
// what writing adds to a chunk that already reads, and what a second container
// costs once the first one is paid for.
const at = (name) => measured.find((row) => row.name === name)?.gzip ?? 0;
const deltas = {
  'writing, on top of reading': at('read MP4 QTFF + write MP4') - at('read MP4 QTFF'),
  'a second container to write': at('write MP4 MOV') - at('write MP4'),
  'Matroska to write': at('write MP4 WEBM') - at('write MP4'),
  'the encoder wrapper': at('write MP4') - at('write MP4, packets only'),
};
console.log();
for (const [name, gzip] of Object.entries(deltas)) {
  console.log(`${name.padEnd(28)}${String(gzip).padStart(6)} gzip`);
}

// Written out for the same reason every other measurement here is: the research
// page is generated from results files, and a number transcribed by hand is a
// number that outlives the thing it described.
const out = 'tools/video-bench/results-bundle.json';
writeFileSync(
  out,
  `${JSON.stringify(
    {
      what: 'mediabunny through Rotyl own build, reading and writing containers',
      minifier: 'oxc',
      cases: Object.fromEntries(measured.map(({ name, raw, gzip }) => [name, { raw, gzip }])),
      deltas,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nwritten to ${out}`);

rmSync(DIR, { recursive: true, force: true });
