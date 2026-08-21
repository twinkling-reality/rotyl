// MEASUREMENT 16: whether a full-range clip needs a path of its own.
//
// MEASUREMENT 4 LEFT THIS OPEN AND SAID WHY, and the reason it gave was wrong
// about which half had failed. It reported that both 4:2:0 probes produced
// identical values and that Chrome called both of them limited range, and
// concluded that "the range path was never exercised" and that what was needed
// was "a clip whose range flag is verifiably in the bitstream and actually
// differs".
//
// The clip was already that clip. Asked of the file rather than of anyone's
// memory, `probe-420-pc.mp4` carries `video_full_range_flag = 1` in its SPS
// where `probe-420-tv.mp4` carries 0, and its luma runs 0 to 255 where the
// other runs 16 to 235. Two files that differ in the flag AND in the payload
// coming back at the same sRGB values is not a measurement that failed to run.
// It is the answer, and nobody read it as one because nothing in the harness
// had ever looked inside either file.
//
// SO THIS ONE LOOKS. Three things are established in order, and the order is
// the whole point, because the first two are what turn the third from a
// coincidence into a finding:
//
//   THE FLAG DIFFERS, read out of the SPS in the decoder configuration this
//   measurement is about to hand to `VideoDecoder`, rather than off the command
//   line that produced the file. `make-clips.sh` asks ffmpeg for `pc`, and what
//   an encoder does with that has changed between versions.
//
//   THE FILES DIFFER, byte for byte, which is what stops every line after it
//   being a statement about one clip measured twice. A fixture that quietly
//   stopped differing measures beautifully, and that is the failure this whole
//   question sat inside for four chapters.
//
//   AND THE ANSWER DOES NOT. Only once the two above hold does it mean anything
//   that the sixteen patches come back at the same values through the product's
//   own upload path.
//
// A FOURTH READING WAS MEANT TO BE THE SECOND ONE AND TURNED INTO THE FINDING.
// The plan was to prove the two clips differ by reading the decoded luma at the
// grey patches, since a full-range encode of black is Y=0 where a limited one is
// Y=16. A page cannot see that: `copyTo` hands back the SAME limited range for
// both files. So the browser has applied the flag and normalised before a frame
// exists to look at, which is stronger evidence than the round trip it was
// supposed to set up, and useless as a check that the two clips are two clips.
// It is reported as what it is, and the file comparison does the checking.
//
// AND THE ANSWER IS NOT UNIFORM, WHICH ONE PAIR OF CLIPS COULD NOT SEE. On the
// 1920x1080 probes the flag is honoured and there is nothing to do. The same
// picture at 320x180 is thirteen codes out, contrast-stretched exactly as a
// full-range payload read as limited would be. The probe that owns the colour
// contract is 1080p, and 1080p is on the working side of the line.
//
// SO THE LADDER, AND THEN THE MECHANISM. Four sizes say the line sits between
// 480x270 and 640x360 on this machine, which is a number about this machine.
// Asked directly, `hardwareAcceleration` says what it is really about: the
// HARDWARE decoder honours the flag at every size and the SOFTWARE decoder
// ignores it at every size, and frame size only decides which one the browser
// picks. That is a statement anybody can check rather than a threshold anybody
// has to reproduce.
//
// EVERY COMPARISON HERE IS AGAINST THE LIMITED-RANGE TWIN and never against the
// source, because the GPU upload puts +11 into the midtones of any 4:2:0 frame
// whichever range it is, which measurement 4 already attributes and which has
// nothing to do with this. Two encodes of one picture cancel it.
//
// AND THE METADATA IS NO HELP EITHER WAY. `VideoFrame.colorSpace` reports
// `fullRange: false` on a full-range file, both where the decode was right and
// where it was wrong, and reports `bt709` primaries and transfer for a
// bitstream whose SPS says "unspecified" for both. So there is no signal a page
// could branch on even if it wanted to, which is why what is left is a limit
// rather than a fix.
//
// ITS OWN COMMAND AND ITS OWN FILE. This shares its clips, its patches and its
// upload path with measurement 4, which is exactly why it must not share that
// measurement's file: `colour` is inside `run.mjs all`, and `all` writes the
// `results.json` that the decode ladder, the readback ladder and two ONNX
// timings are read from. Adding a row here by re-running that would re-date
// every one of them for a question none of them touches, which is the cost
// measurements 14 and 15 already record having paid.

import { BlobSource, EncodedPacketSink, Input, MP4 } from 'mediabunny';
import {
  error,
  firstFrameOf,
  PATCHES,
  COLS,
  HEIGHT,
  ROWS,
  viaCopyExternalImage,
  viaExternalTexture,
  WIDTH,
  type Decoded,
} from './colour.ts';

/** The grey ramp, which is where limited and full range differ by construction. */
const GREYS = 10;

/** The ladder's own patches: eight flat greys, four across and two down. */
const LADDER_GREYS = [0, 32, 64, 96, 128, 160, 192, 255] as const;
const LADDER_SIZES = ['320x180', '480x270', '640x360', '1280x720'] as const;

/**
 * The eight patch centres of a ladder frame, through the path the PRODUCT uses.
 *
 * Size-agnostic, which is why it is here rather than borrowed from measurement
 * 4: those helpers are locked to the probe's 1920x1080 and the whole point of
 * this ladder is that the answer depends on the size.
 *
 * `copyExternalImageToTexture` is `uploadFrameToTexture`'s own call, so what
 * this reads is what a frame opened in the editor becomes.
 */
async function ladderPatches(dev: GPUDevice, frame: VideoFrame): Promise<number[]> {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const texture = dev.createTexture({
    size: { width, height },
    format: 'rgba8unorm',
    viewFormats: ['rgba8unorm-srgb'],
    // RENDER_ATTACHMENT is not optional: `copyExternalImageToTexture` requires
    // it on the destination, and without it the copy is a validation error and
    // every patch reads zero. Which is what it did, and what "255 codes from
    // the source" in a first run turned out to mean.
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.TEXTURE_BINDING,
  });
  dev.queue.copyExternalImageToTexture(
    { source: frame, flipY: false },
    { texture, premultipliedAlpha: false },
    { width, height },
  );
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = dev.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = dev.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height });
  dev.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  texture.destroy();

  const out: number[] = [];
  for (let i = 0; i < LADDER_GREYS.length; i++) {
    const x = Math.floor(((i % 4) + 0.5) * (width / 4));
    const y = Math.floor((Math.floor(i / 4) + 0.5) * (height / 2));
    out.push(bytes[y * bytesPerRow + x * 4] ?? -1);
  }
  return out;
}

/** The flag out of a parsed SPS, or nothing where the parse failed. */
const flagOf = (value: Sps | { error: string }): number | null =>
  'error' in value ? null : value.video_full_range_flag;

const worstOf = (a: readonly number[], b: readonly number[]): number =>
  Math.max(...a.map((value, i) => Math.abs(value - (b[i] ?? 0))));

/**
 * A bit reader over an SPS, with the emulation prevention bytes taken out.
 *
 * H.264 forbids the sequence 00 00 00..03 inside a NAL, so an encoder inserts a
 * 03 after any 00 00 that would otherwise produce one. A parser that does not
 * remove them reads a field or two correctly and then silently walks off into
 * the wrong bits, which is the failure this whole measurement is about.
 */
class Bits {
  #data: Uint8Array;
  #at = 0;

  constructor(nal: Uint8Array) {
    const out: number[] = [];
    for (let i = 0; i < nal.length; i++) {
      if (i >= 2 && nal[i] === 0x03 && nal[i - 1] === 0x00 && nal[i - 2] === 0x00) continue;
      out.push(nal[i] ?? 0);
    }
    this.#data = new Uint8Array(out);
  }

  /** `count` bits, most significant first. */
  u(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.#data[this.#at >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (this.#at & 7))) & 1);
      this.#at++;
    }
    return value;
  }

  /** Unsigned Exp-Golomb. */
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0 && zeros < 32) zeros++;
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.u(zeros);
  }

  /** Signed Exp-Golomb. */
  se(): number {
    const value = this.ue();
    return value % 2 === 0 ? -(value / 2) : (value + 1) / 2;
  }
}

interface Sps {
  readonly profile_idc: number;
  readonly video_signal_type_present_flag: number;
  readonly video_full_range_flag: number | null;
  readonly colour_description_present_flag: number | null;
  readonly colour_primaries: number | null;
  readonly transfer_characteristics: number | null;
  readonly matrix_coefficients: number | null;
}

/** The profiles whose SPS carries a chroma format and scaling lists before the rest. */
const EXTENDED = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(bits: Bits, size: number): void {
  let last = 8;
  let next = 8;
  for (let i = 0; i < size; i++) {
    if (next !== 0) next = (last + bits.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/**
 * The colour fields of an SPS, which is the only place H.264 states the range.
 *
 * Walked in full rather than searched for, because every field before the VUI
 * is variable width and there is no way to seek to one. What is NOT parsed is
 * anything after the colour description: this stops where it has its answer.
 */
function parseSps(nal: Uint8Array): Sps {
  const bits = new Bits(nal.subarray(1));
  const profile_idc = bits.u(8);
  bits.u(8); // constraint flags and reserved
  bits.u(8); // level_idc
  bits.ue(); // seq_parameter_set_id

  let chroma_format_idc = 1;
  if (EXTENDED.has(profile_idc)) {
    chroma_format_idc = bits.ue();
    if (chroma_format_idc === 3) bits.u(1); // separate_colour_plane_flag
    bits.ue(); // bit_depth_luma_minus8
    bits.ue(); // bit_depth_chroma_minus8
    bits.u(1); // qpprime_y_zero_transform_bypass_flag
    if (bits.u(1) === 1) {
      const lists = chroma_format_idc === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) if (bits.u(1) === 1) skipScalingList(bits, i < 6 ? 16 : 64);
    }
  }

  bits.ue(); // log2_max_frame_num_minus4
  const pic_order_cnt_type = bits.ue();
  if (pic_order_cnt_type === 0) {
    bits.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (pic_order_cnt_type === 1) {
    bits.u(1); // delta_pic_order_always_zero_flag
    bits.se(); // offset_for_non_ref_pic
    bits.se(); // offset_for_top_to_bottom_field
    const cycle = bits.ue();
    for (let i = 0; i < cycle; i++) bits.se();
  }

  bits.ue(); // max_num_ref_frames
  bits.u(1); // gaps_in_frame_num_value_allowed_flag
  bits.ue(); // pic_width_in_mbs_minus1
  bits.ue(); // pic_height_in_map_units_minus1
  if (bits.u(1) === 0) bits.u(1); // frame_mbs_only_flag, then mb_adaptive_frame_field_flag
  bits.u(1); // direct_8x8_inference_flag
  if (bits.u(1) === 1) {
    bits.ue();
    bits.ue();
    bits.ue();
    bits.ue(); // frame cropping
  }

  const blank: Sps = {
    profile_idc,
    video_signal_type_present_flag: 0,
    video_full_range_flag: null,
    colour_description_present_flag: null,
    colour_primaries: null,
    transfer_characteristics: null,
    matrix_coefficients: null,
  };
  if (bits.u(1) === 0) return blank; // vui_parameters_present_flag

  if (bits.u(1) === 1) {
    // aspect_ratio_info_present_flag
    if (bits.u(8) === 255) {
      bits.u(16);
      bits.u(16);
    }
  }
  if (bits.u(1) === 1) bits.u(1); // overscan_info_present_flag
  if (bits.u(1) === 0) return blank; // video_signal_type_present_flag

  bits.u(3); // video_format
  const video_full_range_flag = bits.u(1);
  const colour_description_present_flag = bits.u(1);
  return {
    profile_idc,
    video_signal_type_present_flag: 1,
    video_full_range_flag,
    colour_description_present_flag,
    colour_primaries: colour_description_present_flag === 1 ? bits.u(8) : null,
    transfer_characteristics: colour_description_present_flag === 1 ? bits.u(8) : null,
    matrix_coefficients: colour_description_present_flag === 1 ? bits.u(8) : null,
  };
}

/**
 * The first SPS out of an avcC, which is what a decoder config's `description`
 * is for H.264 in MP4.
 *
 * Read from the config this measurement hands to `VideoDecoder`, rather than
 * from the file separately, so the bits parsed are the bits the browser was
 * given and not a second reading of the same clip.
 */
function spsOf(config: VideoDecoderConfig): Sps | { error: string } {
  const description = config.description;
  if (!description) return { error: 'the decoder config carries no avcC' };
  // A VIEW'S OWN WINDOW, not the buffer behind it. `description` is an
  // ArrayBuffer or a view onto one, and taking the whole buffer of a view that
  // starts part way into it reads the wrong bytes and then parses them
  // successfully, which is exactly the shape of failure this file exists to
  // catch. It caught this one.
  const avcc = new Uint8Array(
    ArrayBuffer.isView(description)
      ? description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength)
      : description.slice(0),
  );
  // configurationVersion, profile, compatibility, level, lengthSizeMinusOne,
  // then numOfSequenceParameterSets in the low five bits of byte 5.
  if (avcc.length < 8) return { error: `the avcC is ${String(avcc.length)} bytes` };
  const count = (avcc[5] ?? 0) & 0x1f;
  if (count === 0) return { error: 'the avcC carries no SPS' };
  const length = ((avcc[6] ?? 0) << 8) | (avcc[7] ?? 0);
  if (8 + length > avcc.length) return { error: 'the avcC SPS runs past the end' };
  return parseSps(avcc.subarray(8, 8 + length));
}

/**
 * The luma at the ten grey patches, as a page can read it back.
 *
 * WRITTEN TO PROVE THE TWO FILES DIFFER AND IT PROVES SOMETHING BETTER. The
 * stored luma of the full-range clip runs 0 to 255 where the limited one runs
 * 16 to 235, which is what ffmpeg wrote and what `ffprobe` reads back out of
 * either file. This does not see that. `copyTo` hands a page the SAME limited
 * range for both, so by the time a frame exists the browser has already applied
 * the flag and normalised, which is direct evidence for the finding rather than
 * the setup for it.
 *
 * What it therefore cannot do is establish that the two clips are two clips.
 * That is `the_bitstream_differs` below, which compares the files themselves.
 */
async function lumaAtTheGreys(frame: VideoFrame): Promise<number[] | { error: string }> {
  try {
    const buffer = new Uint8Array(frame.allocationSize());
    const layout = await frame.copyTo(buffer);
    const plane = layout[0];
    if (!plane) return { error: 'the frame has no planes' };
    const out: number[] = [];
    for (let i = 0; i < GREYS; i++) {
      const x = Math.floor(((i % COLS) + 0.5) * (WIDTH / COLS));
      const y = Math.floor((Math.floor(i / COLS) + 0.5) * (HEIGHT / ROWS));
      out.push(buffer[plane.offset + y * plane.stride + x] ?? -1);
    }
    return out;
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * The patch centres through a 2D canvas, which is the third way to read a frame
 * and the one that turned out to answer differently.
 *
 * Not a path this product uses, and measured because the question is about the
 * browser rather than about us: a page that draws a frame into a 2D context for
 * a thumbnail, or a test that reads pixels the easy way, gets this one.
 */
function via2dCanvas(frame: VideoFrame): [number, number, number][] {
  const surface = new OffscreenCanvas(WIDTH, HEIGHT);
  const context = surface.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(frame, 0, 0);
  const data = context.getImageData(0, 0, WIDTH, HEIGHT).data;
  const out: [number, number, number][] = [];
  for (let i = 0; i < PATCHES.length; i++) {
    const x = Math.floor(((i % COLS) + 0.5) * (WIDTH / COLS));
    const y = Math.floor((Math.floor(i / COLS) + 0.5) * (HEIGHT / ROWS));
    const o = (y * WIDTH + x) * 4;
    out.push([data[o] ?? -1, data[o + 1] ?? -1, data[o + 2] ?? -1]);
  }
  return out;
}

const spaceOf = (value: VideoColorSpace): VideoColorSpaceInit => ({
  primaries: value.primaries,
  transfer: value.transfer,
  matrix: value.matrix,
  fullRange: value.fullRange,
});

interface Read {
  readonly sps: Sps | { error: string };
  readonly luma: number[] | { error: string };
  readonly srgb: [number, number, number][];
  /** What the PRODUCT uses, which is `uploadFrameToTexture`'s own call. */
  readonly uploaded: [number, number, number][];
  /** And the easy way, which is not a path this product takes. */
  readonly drawn: [number, number, number][];
  readonly frame_says: VideoColorSpaceInit;
  readonly format: string;
  /** The file itself, kept so that "these are two clips" is checked rather than assumed. */
  readonly bytes: Uint8Array;
}

async function read(dev: GPUDevice, url: string): Promise<Read> {
  const blob = await (await fetch(url)).blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const decoded: Decoded = await firstFrameOf(blob);
  try {
    return {
      sps: spsOf(decoded.config),
      luma: await lumaAtTheGreys(decoded.frame),
      // The product's own upload path: an external texture through one pass,
      // written through a plain view, which is what `FrameProvider` does.
      srgb: await viaExternalTexture(dev, decoded.frame, 'rgba8unorm'),
      uploaded: await viaCopyExternalImage(dev, decoded.frame),
      drawn: via2dCanvas(decoded.frame),
      frame_says: spaceOf(decoded.frame.colorSpace),
      format: String(decoded.frame.format),
      bytes,
    };
  } finally {
    decoded.frame.close();
  }
}

const sameNumbers = (a: number[] | { error: string }, b: number[] | { error: string }): boolean =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i]);

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

const worstBetween = (
  a: readonly (readonly [number, number, number])[],
  b: readonly (readonly [number, number, number])[],
): number => {
  let worst = 0;
  for (const [i, got] of a.entries()) {
    const other = b[i];
    if (!other) continue;
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((got[c] ?? 0) - (other[c] ?? 0)));
  }
  return worst;
};

/**
 * One frame of a clip, decoded with a stated preference about which decoder.
 *
 * `firstFrameOf` cannot do this: it is the ordinary path and takes whatever the
 * browser picks. What the ladder below finds is that the choice matters, and
 * this is what turns "it depends on the frame size" into "it depends on which
 * decoder, and the size is what picks one".
 */
async function decodeWith(
  url: string,
  acceleration: HardwareAcceleration,
): Promise<VideoFrame | { error: string }> {
  const input = new Input({ formats: [MP4], source: new BlobSource(await (await fetch(url)).blob()) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return { error: 'no video track' };
    const config = await track.getDecoderConfig();
    if (!config) return { error: 'no decoder config' };
    const packet = await new EncodedPacketSink(track).getFirstKeyPacket();
    if (!packet) return { error: 'no key packet' };
    let decoder: VideoDecoder | undefined;
    try {
      return await new Promise<VideoFrame>((resolve, reject) => {
        decoder = new VideoDecoder({ output: resolve, error: reject });
        decoder.configure({ ...config, hardwareAcceleration: acceleration, optimizeForLatency: true });
        decoder.decode(packet.toEncodedVideoChunk());
        void decoder.flush().catch(reject);
      });
    } catch (e) {
      return { error: String(e) };
    } finally {
      if (decoder && decoder.state !== 'closed') decoder.close();
    }
  } finally {
    input.dispose();
  }
}

/**
 * The same picture at four sizes, full range against its limited-range twin.
 *
 * ONE PAIR AT ONE SIZE CANNOT SEE THIS, which is why the probe that owns the
 * colour contract could not: it is 1920x1080, and 1920x1080 is on the right
 * side of the line.
 */
async function ladder(dev: GPUDevice, base: string): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const size of LADDER_SIZES) {
    const rung = async (which: 'pc' | 'tv'): Promise<number[] | { error: string }> => {
      const frame = await decodeWith(`${base}/range-${which}-${size}.mp4`, 'no-preference');
      if (!(frame instanceof VideoFrame)) return frame;
      try {
        return await ladderPatches(dev, frame);
      } finally {
        frame.close();
      }
    };
    const full = await rung('pc');
    const limited = await rung('tv');
    out[size] =
      Array.isArray(full) && Array.isArray(limited)
        ? {
            full_range: full,
            limited_range: limited,
            // The finding, per rung: how far the full-range clip lands from the
            // limited-range one of the same picture.
            worst_against_its_twin: worstOf(full, limited),
            // And against what was drawn, so a rung that is wrong in both is
            // not read as a rung that is right.
            worst_against_the_source: worstOf(full, LADDER_GREYS),
          }
        : { full_range: full, limited_range: limited };
  }
  return out;
}

/**
 * Which decoder, asked directly, which is the mechanism the ladder is a
 * consequence of.
 *
 * A size big enough that the browser picks hardware on its own and a size small
 * enough that it does not, each asked for both ways. If the two sizes disagree
 * under no preference and AGREE when told which decoder to use, then the size
 * is not the cause and the decoder is.
 */
async function whichDecoder(dev: GPUDevice, base: string): Promise<unknown> {
  const out: Record<string, unknown> = {};
  const cases: readonly (readonly [string, HardwareAcceleration])[] = [
    ['1280x720', 'no-preference'],
    ['1280x720', 'prefer-hardware'],
    ['1280x720', 'prefer-software'],
    ['320x180', 'no-preference'],
    ['320x180', 'prefer-hardware'],
    ['320x180', 'prefer-software'],
  ];
  for (const [size, acceleration] of cases) {
    const asked = async (which: 'pc' | 'tv'): Promise<number[] | { error: string }> => {
      const frame = await decodeWith(`${base}/range-${which}-${size}.mp4`, acceleration);
      if (!(frame instanceof VideoFrame)) return frame;
      try {
        return await ladderPatches(dev, frame);
      } finally {
        frame.close();
      }
    };
    const full = await asked('pc');
    const limited = await asked('tv');
    if (!Array.isArray(full) || !Array.isArray(limited)) {
      out[`${size}, ${acceleration}`] = { full_range: full, limited_range: limited };
      continue;
    }
    out[`${size}, ${acceleration}`] = {
      full_range: full,
      // AGAINST THE TWIN AND NOT AGAINST THE SOURCE, which is the whole of what
      // makes this readable. Every rung here also carries the +11 the GPU upload
      // puts into the midtones of any 4:2:0 frame, limited or full, and that has
      // nothing to do with the range flag. Comparing the two encodes of one
      // picture cancels it and leaves only what the flag decided.
      worst_against_its_twin: worstOf(full, limited),
      honoured: worstOf(full, limited) <= 3,
    };
  }
  return out;
}

export async function range(dev: GPUDevice, base: string): Promise<unknown> {
  const tv = await read(dev, `${base}/probe-420-tv.mp4`);
  const pc = await read(dev, `${base}/probe-420-pc.mp4`);

  return {
    what: 'the same sRGB patches encoded limited range and full range, and brought back',
    patches: PATCHES.length,
    // The questions, in the order that makes the last one mean something. A
    // false in either of the first two makes every one after it vacuous, which
    // is the state this question was left in for four chapters.
    the_bitstream_differs: !sameBytes(tv.bytes, pc.bytes),
    the_flag_differs: flagOf(tv.sps) !== flagOf(pc.sps),
    // Two files that differ, whose flag differs, and whose luma a page reads
    // back at the same limited range: the browser applied the flag before a
    // page could see the frame.
    the_readback_is_normalised: sameNumbers(tv.luma, pc.luma),
    // AND WHICH PATH, which the first run of this measurement did not ask and
    // an end-to-end test caught within the hour. A page has three ways to get
    // at a decoded frame and they do not all answer the same. Only the second
    // of these is the one the product takes.
    worst_between_the_two_codes: {
      'importExternalTexture, and a pass': worstBetween(tv.srgb, pc.srgb),
      copyExternalImageToTexture: worstBetween(tv.uploaded, pc.uploaded),
      'drawImage, onto a 2D canvas': worstBetween(tv.drawn, pc.drawn),
    },
    the_answer_differs: worstBetween(tv.uploaded, pc.uploaded) > 1,
    // And the metadata, which is the half that is wrong. Reported next to the
    // flag it disagrees with rather than in a sentence somewhere else.
    reported_full_range: {
      'probe-420-tv': tv.frame_says.fullRange ?? null,
      'probe-420-pc': pc.frame_says.fullRange ?? null,
    },
    // The same picture at four sizes, which is what one pair at one size could
    // not see, and the decoder that turns out to decide it.
    the_ladder: await ladder(dev, base),
    which_decoder: await whichDecoder(dev, base),
    clips: {
      'probe-420-tv': {
        sps: tv.sps,
        file_bytes: tv.bytes.length,
        format: tv.format,
        frame_says: tv.frame_says,
        luma_at_the_greys: tv.luma,
        srgb_back: error(tv.srgb),
        srgb_back_uploaded: error(tv.uploaded),
        srgb_back_drawn: error(tv.drawn),
      },
      'probe-420-pc': {
        sps: pc.sps,
        file_bytes: pc.bytes.length,
        format: pc.format,
        frame_says: pc.frame_says,
        luma_at_the_greys: pc.luma,
        srgb_back: error(pc.srgb),
        srgb_back_uploaded: error(pc.uploaded),
        srgb_back_drawn: error(pc.drawn),
      },
    },
  };
}
