// MEASUREMENT 11: where the sound goes in the file, and what it costs to know
// how much of it there is before the first frame is rendered.
//
// The last chapter put the index at the FRONT of every file this writes, so a
// player can start before the last byte has arrived. Adding a second track is
// the first thing that can quietly undo that: a file whose video is one
// contiguous run and whose audio is another satisfies "moov first" on paper and
// violates it completely in practice, because a player has to hold the whole
// video to reach the first audio sample.
//
// So this writes the same clip both ways and asks, for each second of video,
// HOW FAR AWAY IN THE FILE the audio that plays with it is. If that distance
// grows with the length of the clip, the file is not progressive whatever the
// box order says.
//
// NO ENCODER ANYWHERE IN IT. Both tracks are passed through as encoded packets,
// which is what a clip export does with audio and is also what isolates this
// from measurement 5: what is being timed and laid out here is the muxer's
// arrangement of bytes, and an encoder in the loop would only add noise to it.
//
// ITS OWN COMMAND, and its own results file, because it shares nothing with the
// run the decode and encode figures come from and re-taking it should not
// re-date them:
//
//   node tools/video-bench/run.mjs interleave
//
// Needs `1080p30-aac.mp4` and `1080p30-ulaw.mov` from make-clips.sh.

import {
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  StreamTarget,
  type AudioCodec,
  type EncodedPacket,
  type VideoCodec,
} from 'mediabunny';
import { mp4Index, type IndexedSample, type IndexedTrack } from './mp4-index.ts';
import { stats, type Stat } from './util.ts';

/**
 * The lengths the ladder is taken at.
 *
 * Three points rather than two, because the question is not what the distance
 * IS but whether it grows: a single length cannot tell a constant apart from
 * something proportional to the clip.
 */
const LENGTHS_SECONDS = [30, 120, 300] as const;

/**
 * How much of the front of the file is kept.
 *
 * The parser reads `moov` and never touches the media, so keeping the whole
 * file would be holding a third of a gigabyte in order to read a megabyte of
 * sample tables, and holding it would land in the heap figures below. What has
 * to be inside this window is ftyp, the reserved moov, the free box the
 * reservation over-estimated by, and the mdat header. On the longest rung here
 * that is about a megabyte.
 */
const FRONT_WINDOW = 16 * 2 ** 20;

const mb = (bytes: number): number => Math.round((bytes / 2 ** 20) * 100) / 100;
const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;
const round = (value: number): number => Math.round(value * 1000) / 1000;

/** One track of the source clip, read once and held. */
interface Passthrough {
  readonly packets: readonly EncodedPacket[];
  /** Where the track's presentation ends, which is the period a loop repeats at. */
  readonly span: number;
}

interface SourceClip {
  readonly video: Passthrough;
  readonly videoCodec: VideoCodec;
  readonly videoConfig: VideoDecoderConfig;
  readonly audio: Passthrough;
  readonly audioCodec: AudioCodec;
  readonly audioConfig: AudioDecoderConfig;
  readonly width: number;
  readonly height: number;
}

async function readAll(sink: EncodedPacketSink): Promise<Passthrough> {
  const packets: EncodedPacket[] = [];
  let span = 0;
  for await (const packet of sink.packets()) {
    packets.push(packet);
    span = Math.max(span, packet.timestamp + packet.duration);
  }
  return { packets, span };
}

async function openClip(url: string): Promise<SourceClip> {
  const input = new Input({ formats: [MP4, QTFF], source: new BlobSource(await (await fetch(url)).blob()) });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  if (!video || !audio) throw new Error(`${url} has no video and audio pair`);
  const videoCodec = await video.getCodec();
  const audioCodec = await audio.getCodec();
  const videoConfig = await video.getDecoderConfig();
  const audioConfig = await audio.getDecoderConfig();
  if (!videoCodec || !audioCodec || !videoConfig || !audioConfig) {
    throw new Error(`${url} has a track this cannot pass through`);
  }
  if (!new Mp4OutputFormat().getSupportedVideoCodecs().includes(videoCodec)) {
    throw new Error(`${url} carries video an MP4 cannot hold`);
  }
  return {
    video: await readAll(new EncodedPacketSink(video)),
    videoCodec,
    videoConfig,
    audio: await readAll(new EncodedPacketSink(audio)),
    audioCodec,
    audioConfig,
    width: video.displayWidth,
    height: video.displayHeight,
  };
}

/**
 * The source clip, handed round again for as long as it is asked for.
 *
 * The DATA repeats and the TIMING does not, which is the same thing
 * `long-clip.ts` does and for the same reason: what is being measured is a file
 * of a given length, and a file that stamped the same ten seconds over itself
 * would be a different file.
 *
 * Video repeats at its own span, which is exact here (three hundred frames at a
 * 1/15360 timebase is ten seconds to the unit), so B-frame reordering survives
 * the loop: a packet keeps its offset within the loop and the loop boundary
 * lands on a key packet. Audio ACCUMULATES its own packet durations instead,
 * because an audio span is not a whole number of video frames and looping it at
 * its own period would drift the two apart by a frame every four loops.
 */
function loopVideo(source: Passthrough, seconds: number): readonly EncodedPacket[] {
  const out: EncodedPacket[] = [];
  const period = source.span;
  for (let loop = 0; loop * period < seconds; loop++) {
    for (const packet of source.packets) {
      const timestamp = loop * period + packet.timestamp;
      if (timestamp >= seconds) continue;
      out.push(packet.clone({ timestamp }));
    }
  }
  return out;
}

function loopAudio(source: Passthrough, seconds: number): readonly EncodedPacket[] {
  const out: EncodedPacket[] = [];
  let now = 0;
  for (let i = 0; now < seconds; i++) {
    const packet = source.packets[i % source.packets.length];
    if (!packet) break;
    out.push(packet.clone({ timestamp: now }));
    now += packet.duration;
  }
  return out;
}

/**
 * Where the bytes go: the front of the file, and a count of the rest.
 *
 * A real `WritableStream`, taking the positioned writes a stream target emits,
 * so the muxer is doing exactly what it does behind a file handle. Narrowed
 * rather than asserted, for the reason `long-clip.ts` gives: what a writable
 * file stream accepts is a union and most of it never arrives here.
 */
function frontCollector(front: Uint8Array): {
  stream: WritableStream<FileSystemWriteChunkType>;
  bytes: () => number;
} {
  let end = 0;
  return {
    bytes: () => end,
    stream: new WritableStream<FileSystemWriteChunkType>({
      write(chunk) {
        if (chunk instanceof Blob || typeof chunk === 'string') return;
        if (!('type' in chunk) || chunk.type !== 'write') return;
        const data = chunk.data;
        if (data === undefined || data === null || data instanceof Blob || typeof data === 'string') return;
        const at = chunk.position ?? 0;
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (at < front.length) front.set(view.subarray(0, Math.max(0, front.length - at)), at);
        if (at + view.byteLength > end) end = at + view.byteLength;
      },
    }),
  };
}

/**
 * The three ways of putting two tracks in one file.
 *
 * `appended` adds every video packet and then every audio packet, which is the
 * one call outside the loop and costs nothing to write. `primed` is the same
 * thing with a single audio packet in front of it, which is what somebody
 * writes after finding out why the first one does not work. `interleaved`
 * drains the audio that is behind before each frame goes in, which is a second
 * cursor and one comparison per frame.
 */
type Arrangement = 'appended' | 'primed' | 'interleaved';

interface Written {
  readonly bytes: number;
  readonly seconds_to_write: number;
}

async function writeClip(
  source: SourceClip,
  seconds: number,
  arrangement: Arrangement,
  front: Uint8Array,
): Promise<Written> {
  const videoPackets = loopVideo(source.video, seconds);
  const audioPackets = loopAudio(source.audio, seconds);

  front.fill(0);
  const collector = frontCollector(front);
  const format = new Mp4OutputFormat({ fastStart: 'reserve' });
  const output = new Output({ format, target: new StreamTarget(collector.stream) });
  const videoTrack = new EncodedVideoPacketSource(source.videoCodec);
  const audioTrack = new EncodedAudioPacketSource(source.audioCodec);
  // Both tracks, because `reserve` needs a packet count on EVERY track: it
  // reserves the sample tables before the first sample lands, and a table it
  // cannot size is a table it cannot leave room for.
  output.addVideoTrack(videoTrack, { maximumPacketCount: videoPackets.length });
  output.addAudioTrack(audioTrack, { maximumPacketCount: audioPackets.length });
  await output.start();

  // NOT MEASURED HERE: what the tab holds. Both arrangements stream, because
  // the muxer writes each chunk as it closes either way, and what does grow is
  // the sample table `reserve` keeps per track, which both need in equal
  // measure. A heap figure taken across these rungs reads the packet list this
  // harness built rather than anything the arrangement decided, so the honest
  // thing is to leave it out and say why. What the second track DOES cost at
  // the front of the file is the moov and free columns below.
  const t0 = performance.now();
  try {
    let videoMeta: EncodedVideoChunkMetadata | undefined = { decoderConfig: source.videoConfig };
    let audioMeta: EncodedAudioChunkMetadata | undefined = { decoderConfig: source.audioConfig };
    let audioCursor = 0;

    const drainAudio = async (upTo: number): Promise<void> => {
      while (audioCursor < audioPackets.length) {
        const audio = audioPackets[audioCursor];
        if (!audio || audio.timestamp > upTo) break;
        await audioTrack.add(audio, audioMeta);
        audioMeta = undefined;
        audioCursor++;
      }
    };

    if (arrangement !== 'interleaved') {
      // One audio packet in front of the video, or none at all. With the index
      // reserved the muxer cannot size the movie box until it has seen a packet
      // from every track, so this single packet is the difference between a
      // file and no file.
      if (arrangement === 'primed') await drainAudio(audioPackets[0]?.timestamp ?? 0);
      for (const packet of videoPackets) {
        await videoTrack.add(packet, videoMeta);
        videoMeta = undefined;
      }
      await drainAudio(Infinity);
    } else {
      for (const packet of videoPackets) {
        // The audio that is already due, before the frame it plays under. One
        // cursor over two streams rather than two passes over the file.
        await drainAudio(packet.timestamp);
        await videoTrack.add(packet, videoMeta);
        videoMeta = undefined;
      }
      // Whatever is left plays after the last frame starts, which is up to one
      // frame of sound plus whatever the audio's own packet grid leaves over.
      await drainAudio(Infinity);
    }

    videoTrack.close();
    audioTrack.close();
    await output.finalize();
  } finally {
    /* nothing to release: the collector holds a window the caller owns */
  }

  return { bytes: collector.bytes(), seconds_to_write: round((performance.now() - t0) / 1000) };
}

/** The last sample of a track that has started by `at`. */
function playingAt(track: IndexedTrack, at: number): IndexedSample | undefined {
  let found: IndexedSample | undefined;
  for (const sample of track.samples) {
    if (sample.seconds > at) break;
    found = sample;
  }
  return found;
}

interface Reach {
  readonly seconds_measured: number;
  readonly gap: Stat;
  readonly worst_gap_mb: number;
  readonly worst_gap_over_file: number;
  readonly boxes: readonly string[];
  /** What the index at the front costs, and what the reservation over-shot by. */
  readonly moov_kb: number;
  readonly free_kb: number;
  readonly video_samples: number;
  readonly audio_samples: number;
}

/**
 * How far apart in the file the picture and the sound of the same second are.
 *
 * Taken at every whole second rather than at every frame, because the question
 * is what a player has to reach for to keep the two together and a player reads
 * in chunks far larger than a frame. The stat carries the median as well as the
 * worst, since a file that is fine for most of its length and impossible at one
 * point is a different problem from one that is uniformly bad.
 */
function reach(file: Uint8Array, bytes: number, seconds: number): Reach {
  const index = mp4Index(file);
  const video = index.tracks.find((track) => track.kind === 'video');
  const audio = index.tracks.find((track) => track.kind === 'audio');
  if (!video || !audio) throw new Error('the written file has no video and audio pair');

  const gaps: number[] = [];
  for (let at = 0; at < seconds; at++) {
    const here = playingAt(video, at);
    const there = playingAt(audio, at);
    if (!here || !there) continue;
    gaps.push(Math.abs(here.offset - there.offset));
  }
  const worst = gaps.reduce((a, b) => Math.max(a, b), 0);
  return {
    seconds_measured: gaps.length,
    gap: stats(gaps),
    worst_gap_mb: mb(worst),
    worst_gap_over_file: round(worst / Math.max(bytes, 1)),
    boxes: index.boxes.map((box) => box.type),
    moov_kb: kb(index.boxes.find((box) => box.type === 'moov')?.bytes ?? 0),
    free_kb: kb(index.boxes.find((box) => box.type === 'free')?.bytes ?? 0),
    video_samples: video.samples.length,
    audio_samples: audio.samples.length,
  };
}

/**
 * What it costs to know how many audio packets there are before starting.
 *
 * `fastStart: 'reserve'` needs a maximum packet count on every track, so the
 * whole audio track has to be walked before the first frame is rendered. It is
 * metadata only, which reads the sample tables and none of the payload, and the
 * question is whether that stays cheap on a clip long enough to matter rather
 * than on the ten-second one every other figure here is taken on.
 */
async function countingCost(source: SourceClip, front: Uint8Array): Promise<unknown> {
  const rows: Record<string, unknown>[] = [];
  for (const minutes of [0.5, 2, 10, 20]) {
    const seconds = minutes * 60;
    const written = await writeClip(source, seconds, 'interleaved', front);
    // Re-read from the front window alone: the sample tables are all that a
    // metadata-only walk touches, so the media never has to be held to time it.
    const blob = new Blob([front.slice(0, Math.min(front.length, written.bytes))]);
    const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      rows.push({ minutes, error: 'no audio track in the written file' });
      continue;
    }
    const sink = new EncodedPacketSink(track);
    const t0 = performance.now();
    let packets = 0;
    for await (const _ of sink.packets(undefined, undefined, { metadataOnly: true })) packets++;
    rows.push({
      minutes,
      packets,
      ms: round(performance.now() - t0),
      us_per_packet: round(((performance.now() - t0) * 1000) / Math.max(packets, 1)),
    });
    input.dispose();
  }
  return {
    what: 'walking the audio track metadata-only, which is what a packet count costs',
    rows,
  };
}

/**
 * A soundtrack the container will not carry, asked about before any work.
 *
 * QuickTime holds mu-law and MP4 does not, so a `.mov` recorded off an older
 * camera is a perfectly ordinary file whose audio has nowhere to go. Losing it
 * silently is the thing this chapter exists to stop, so what matters is that
 * the answer is available from the track and the format alone, with nothing
 * decoded and nothing encoded.
 */
async function refusal(base: string): Promise<unknown> {
  const format = new Mp4OutputFormat();
  const supported = format.getSupportedAudioCodecs();
  const rows: Record<string, unknown>[] = [];
  for (const name of ['1080p30-aac.mp4', '1080p30-ulaw.mov']) {
    const input = new Input({
      formats: [MP4, QTFF],
      source: new BlobSource(await (await fetch(`${base}/${name}`)).blob()),
    });
    const track = await input.getPrimaryAudioTrack();
    const codec = (await track?.getCodec()) ?? null;
    const config = track ? await track.getDecoderConfig() : null;
    const t0 = performance.now();
    const carried = codec !== null && supported.includes(codec);
    rows.push({
      file: name,
      codec: codec ?? 'unknown to the demuxer',
      has_decoder_config: config !== null,
      mp4_can_carry_it: carried,
      ms_to_decide: round(performance.now() - t0),
    });
    input.dispose();
  }
  return {
    what: 'whether an MP4 can carry the soundtrack it was handed, decided before any work',
    mp4_audio_codecs: supported,
    rows,
  };
}

export async function interleave(base: string): Promise<unknown> {
  const source = await openClip(`${base}/1080p30-aac.mp4`);

  const front = new Uint8Array(FRONT_WINDOW);

  const out: Record<string, unknown> = {
    what: 'where the sound goes in the file, and what knowing how much of it there is costs',
    clip: '1080p30-aac.mp4',
    size: `${String(source.width)}x${String(source.height)}`,
    video_codec: source.videoCodec,
    audio_codec: source.audioCodec,
    audio_sample_rate: source.audioConfig.sampleRate,
    audio_packet_seconds: round(source.audio.span / source.audio.packets.length),
    front_window_mb: mb(FRONT_WINDOW),
  };

  const ladder: Record<string, unknown>[] = [];
  for (const seconds of LENGTHS_SECONDS) {
    for (const arrangement of ['appended', 'primed', 'interleaved'] as const) {
      // An arrangement that cannot be written IS a result, and the one that
      // cannot be written is the cheapest one. Losing the other five rungs to
      // its exception would be losing the comparison it is part of.
      try {
        const written = await writeClip(source, seconds, arrangement, front);
        ladder.push({
          arrangement,
          seconds,
          ok: true,
          file_mb: mb(written.bytes),
          seconds_to_write: written.seconds_to_write,
          ...reach(front, written.bytes, seconds),
        });
      } catch (error) {
        ladder.push({ arrangement, seconds, ok: false, error: String(error) });
      }
      console.log(`bench: ${JSON.stringify({ measurement: 'interleave', arrangement, seconds })}`);
    }
  }
  out['the arrangements'] = ladder;
  out['counting it first'] = await countingCost(source, front);
  out['what the container will not carry'] = await refusal(base);
  return out;
}
