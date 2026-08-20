// MEASUREMENT 2: temporal stability, which is the thing this whole chapter
// turns on.
//
// Every stage of every style runs per frame with no knowledge of the last one.
// An anisotropic Kuwahara picks a winning sector and a flow-based difference of
// Gaussians thresholds a response, and both are winner-take-all decisions on a
// noisy field: a pixel one code different between two frames can flip a cel
// band or move a line. On a still that is invisible. On video it is boiling,
// and boiling is what makes stylised footage look cheap however good any single
// frame is.
//
// Two experiments, because they answer different questions:
//
//   PERTURBATION  the same picture twice, the second with grain added at a
//                 known size. Deterministic, needs no clip, and isolates the
//                 style's own amplification from everything a codec does.
//   CLIP          consecutive decoded frames of a fixed camera on a fixed
//                 scene. Everything that differs between two of those frames
//                 is sensor grain and the encoder's own noise. Real, and it
//                 includes the parts the perturbation test cannot model.
//
// The number that matters in both is the ratio: how much larger the styled
// difference is than the source difference that produced it. One means the
// style is as steady as its input. Ten means it is inventing nine tenths of
// what moves.

import { BlobSource, EncodedPacketSink, Input, MP4, type EncodedPacket } from 'mediabunny';
import {
  amplification,
  CLIPS,
  difference,
  pictureBytes,
  REAL,
  REAL_PICTURES,
  SCENE_PICTURE,
  StyleStage,
  type Difference,
  type Picture,
} from './harness.ts';
import { CASES, CONTENT_CASES, type Case } from './chain.ts';

/** Deterministic, so the perturbation is the same on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Add grain of a given size, in codes.
 *
 * Sigma 0.5 is about the smallest perturbation an 8-bit pipeline can express -
 * most pixels move by one code and none by more, which is the "one code
 * different between two frames" case exactly. Sigma 2 is roughly what a decent
 * sensor leaves at base ISO.
 */
function perturb(source: Uint8Array, sigma: number, seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const out = new Uint8Array(source);
  for (let i = 0; i < out.length; i += 4) {
    // One draw for luma plus a smaller independent one per channel, which is
    // what sensor noise looks like and what a codec preserves worst.
    const luma = Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng()) * sigma;
    for (let c = 0; c < 3; c++) {
      const jitter = (rng() - 0.5) * sigma;
      out[i + c] = Math.max(0, Math.min(255, Math.round((source[i + c] ?? 0) + luma + jitter)));
    }
  }
  return out;
}

const SIZE = { width: 1280, height: 720 };

async function perturbOne(
  device: GPUDevice,
  picture: Picture,
  cases: readonly Case[],
): Promise<Record<string, unknown>> {
  const base = await pictureBytes(picture, SIZE.width, SIZE.height);
  const stage = new StyleStage(device, SIZE);
  stage.uploadBytes(base);
  const out: Record<string, unknown> = {};

  for (const sigma of [0.5, 2]) {
    const shaken = perturb(base, sigma, 0x51de + Math.round(sigma * 10));
    const input = difference(base, shaken);
    const rows: Record<string, unknown> = { input };

    for (const item of cases) {
      await stage.render(item.style, item.controls, 'full', true);
      const first = await stage.readOutput();
      stage.uploadBytes(shaken);
      await stage.render(item.style, item.controls, 'full', true);
      const second = await stage.readOutput();
      stage.uploadBytes(base);

      const styled = difference(first, second);
      rows[item.name] = { ...styled, amplification: amplification(styled, input) };
    }

    out[`sigma ${String(sigma)}`] = rows;
    stage.uploadBytes(base);
  }

  stage.dispose();
  return out;
}

export async function perturbation(device: GPUDevice): Promise<unknown> {
  return perturbOne(device, SCENE_PICTURE, CASES);
}

/**
 * The same perturbation against four photographs.
 *
 * This is the cleanest of the three real measurements and the least like real
 * life, which is exactly what it is for. No codec, no camera, no subject: one
 * picture rendered twice with grain of a known size added the second time, so
 * the ratio out to in is the style's own amplification and nothing else's. If
 * the finding survives here and not on the film, the difference is the film.
 */
export async function realPerturbation(device: GPUDevice): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const picture of [SCENE_PICTURE, ...REAL_PICTURES]) {
    out[picture.name] = await perturbOne(device, picture, CONTENT_CASES);
  }
  return out;
}

/**
 * Decoded frames in presentation order, one at a time.
 *
 * Held one at a time on purpose: a second of 1080p is 90 MB of decoded planes,
 * and the measurement only ever needs this frame and the last one's bytes.
 *
 * A yielded frame is CLOSED when the consumer asks for the next one, which is
 * what lets this hold one at a time. Anything that needs the pixels has to take
 * them before then, which uploading to a texture does.
 */
export async function* clipFrames(url: string, count: number): AsyncGenerator<VideoFrame> {
  const blob = await (await fetch(url)).blob();
  const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error(`${url}: no video track`);
  const config = await track.getDecoderConfig();
  if (!config) throw new Error(`${url}: no decoder config`);

  const sink = new EncodedPacketSink(track);
  const queue: VideoFrame[] = [];
  let failure: unknown;
  const decoder = new VideoDecoder({
    output: (frame) => queue.push(frame),
    error: (error) => {
      failure = error;
    },
  });
  decoder.configure({ ...config, optimizeForLatency: true });

  try {
    let packet: EncodedPacket | null = await sink.getFirstKeyPacket();
    let yielded = 0;
    while (yielded < count) {
      if (failure) throw failure;
      if (queue.length === 0) {
        if (packet) {
          decoder.decode(packet.toEncodedVideoChunk());
          packet = await sink.getNextPacket(packet);
          continue;
        }
        await decoder.flush();
        if (queue.length === 0) break;
      }
      const frame = queue.shift();
      if (!frame) break;
      yield frame;
      frame.close();
      yielded++;
    }
  } finally {
    for (const frame of queue) frame.close();
    if (decoder.state !== 'closed') decoder.close();
    input.dispose();
  }
}

interface Running {
  mean: number;
  p99: number;
  flicker: number;
  n: number;
}

const accumulate = (into: Running, one: Difference): void => {
  into.mean += one.mean;
  into.p99 += one.p99;
  into.flicker += one.flicker;
  into.n++;
};

const settle = (running: Running): Difference => ({
  mean: Math.round((running.mean / running.n) * 1000) / 1000,
  p99: Math.round((running.p99 / running.n) * 10) / 10,
  flicker: Math.round((running.flicker / running.n) * 1000) / 1000,
});

/**
 * One style over consecutive frames of one clip.
 *
 * The source difference is read back from the source texture rather than taken
 * from the file, so the denominator is exactly the bytes the chain saw -
 * including everything the decoder and the colour conversion did to them.
 */
async function overClip(
  device: GPUDevice,
  url: string,
  size: { width: number; height: number },
  count: number,
  cases: readonly Case[] = CASES,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const stage = new StyleStage(device, size);

  for (const item of cases) {
    let previousSource: Uint8Array | undefined;
    let previousStyled: Uint8Array | undefined;
    const source: Running = { mean: 0, p99: 0, flicker: 0, n: 0 };
    const styled: Running = { mean: 0, p99: 0, flicker: 0, n: 0 };

    for await (const frame of clipFrames(url, count)) {
      stage.uploadImage(frame);
      await stage.render(item.style, item.controls, 'full', true);
      const nowSource = await stage.readSource();
      const nowStyled = await stage.readOutput();

      if (previousSource && previousStyled) {
        accumulate(source, difference(previousSource, nowSource));
        accumulate(styled, difference(previousStyled, nowStyled));
      }
      previousSource = nowSource;
      previousStyled = nowStyled;
    }

    const sourceDiff = settle(source);
    const styledDiff = settle(styled);
    out[item.name] = {
      source: sourceDiff,
      styled: styledDiff,
      amplification: amplification(styledDiff, sourceDiff),
      pairs: styled.n,
    };
  }

  stage.dispose();
  return out;
}

export async function clips(device: GPUDevice): Promise<unknown> {
  return {
    'static-720p, fixed camera': await overClip(device, `${CLIPS}/static-720p.mp4`, SIZE, 12),
    'pan-720p, camera moving': await overClip(device, `${CLIPS}/pan-720p.mp4`, SIZE, 12),
  };
}

/**
 * The temporal measurement again, on inputs a camera produced.
 *
 * THREE KINDS OF ROW, and they are here together because no one of them
 * settles it:
 *
 *   the control     the synthetic scene, re-taken in this same run rather than
 *                   quoted from the table next door.
 *   one variable    the four photographs put through exactly the recipe
 *                   make-clips.sh uses, so the picture is the only thing that
 *                   differs from the control. Real texture, synthetic grain.
 *   everything      two shots of a film, stream copied. Real texture, real
 *                   sensor noise, real codec noise, and real subject motion,
 *                   which is the one thing the fixed camera was isolating and
 *                   which no real shot can be without.
 *
 * The film rows cannot be read as absolutes for that last reason: an actor
 * moving is a large honest change and it lands in the source column. What they
 * can be read as is the ratio, which is what the amplification field is, and
 * which is the number the original finding was actually about.
 */
export async function realClips(device: GPUDevice): Promise<unknown> {
  const out: Record<string, unknown> = {};
  // 24 frames rather than the control table's 12: real content varies more
  // between pairs, and the extra frames cost seconds.
  const FRAMES = 24;

  out['the synthetic scene, fixed camera'] = await overClip(
    device,
    `${CLIPS}/static-720p.mp4`,
    SIZE,
    FRAMES,
    CONTENT_CASES,
  );
  for (const picture of REAL_PICTURES) {
    out[`${picture.name}, fixed camera`] = await overClip(
      device,
      `${REAL}/static-${picture.name}-720p.mp4`,
      SIZE,
      FRAMES,
      CONTENT_CASES,
    );
  }

  // Letterboxed 2.39:1, which is what the film is. Not padded to 16:9: the
  // black bars would be a fifth of every pixel this measurement averages over,
  // and a bar cannot boil.
  const FILM = { width: 1280, height: 534 };
  out['Tears of Steel, exterior'] = await overClip(
    device,
    `${REAL}/tos-bridge.mp4`,
    FILM,
    FRAMES,
    CONTENT_CASES,
  );
  out['Tears of Steel, interior'] = await overClip(
    device,
    `${REAL}/tos-interior.mp4`,
    FILM,
    FRAMES,
    CONTENT_CASES,
  );

  return out;
}
