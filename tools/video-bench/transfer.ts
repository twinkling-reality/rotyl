// MEASUREMENT 17: whether the eleven codes are ours.
//
// MEASUREMENT 4 SAID A DECODED FRAME NEEDS NO COLOUR PATH OF ITS OWN, and put
// one thing beside that finding as a cost of doing business: the 4:2:0 probes
// come back eleven codes out in the midtones, attributed to "Chrome's BT.709
// conversion on the NV12 path" and said in two documents to be uncorrectable
// here. Measurement 16, asking something else entirely, found that the same
// VideoFrame drawn into a 2D canvas does NOT have them. So it was never the
// decode. It is what happens between the frame and the texture, and one path in
// the same browser answers differently from the other.
//
// AND THE PROBE WAS NEVER ASKED WHAT IT WAS. Every clip this project has ever
// encoded declares `transfer_characteristics = 2`, "unspecified", which the
// browser defaults to bt709: `make-clips.sh` passes `-color_trc bt709` and it
// does not reach the bitstream, which measurement 16 reads out of the SPS. So
// the probes hold sRGB-transfer values labelled BT.709, and a reader that
// converts BT.709 to sRGB is doing exactly what the file told it while the one
// that leaves them alone is right about the content. Neither of those is an
// answer about real footage, which states transfer 1 and means it.
//
// SO THE EXPERIMENT IS A PROBE THAT SAYS WHAT IT IS. Three clips, all three
// stating their transfer in the SPS rather than defaulting it:
//
//   probe-trc709-709    says bt709 and IS bt709. A correct reader gives back
//                       the sRGB the picture was drawn from.
//   probe-trc709-srgb   says bt709 and is sRGB, which is what every probe here
//                       has always been, with the tag written down. It is the
//                       control on the default rather than a second finding.
//   probe-trcsrgb-srgb  says sRGB and IS sRGB. A reader that acts on the tag
//                       has nothing to do; one that converts anyway cannot
//                       blame the file.
//
// AND FFMPEG SAYS WHAT THE FILES MEAN, because "correct" needs somebody who is
// not the browser. It decodes each clip twice, once as stored and once
// converted to an sRGB transfer, and `make-clips.sh` leaves the answers beside
// the clips: a benchmark in a browser cannot run ffmpeg, and a control quoted
// off somebody's terminal is not a control. On the clip that says bt709 and is
// bt709 it comes back at what was drawn, which is the check that the probe is
// honest before anything is concluded from it.
//
// WHAT IT FOUND, IN THE ORDER IT MATTERS.
//
//   THE TAG DRIVES IT. Told sRGB, the WebGPU import converts nothing and the
//   patches come back at what was drawn. Told bt709, it converts. So the eleven
//   codes are the browser doing what five chapters of probes told it, and the
//   2D canvas has been right by accident: it applies nothing at all, and
//   nothing at all is the right answer only for a file that is mislabelled.
//
//   AND THE CURVE IT APPLIES IS NOT BT.709'S. On the clip that says bt709 and
//   is bt709 the import lands within a code of ffmpeg above mid grey and walks
//   away from it below, because what it applies behaves as a pure power rather
//   than as BT.709's piecewise curve with its linear toe. That is the whole of
//   the error that is left, it is in the shadows, and it is smaller than what a
//   2D canvas costs on the same clip, which is the entire ramp.
//
//   AND IT IS THE HARDWARE DECODER, which is the same split measurement 16
//   found for the range flag and the reason this file asks the question the
//   same way. Told to prefer software, nothing is converted at all, asked of
//   the one clip where converting and not converting look different. So this
//   browser has two decoders that disagree about colour in two independent
//   ways, and frame size picks one.
//
// SO NOTHING IN `src/` CHANGES, and the cost table is why rather than the
// colour table alone. Getting a frame onto the GPU through a 2D canvas is the
// only way to have the other behaviour, and it buys a worse picture on footage
// that means what it says while costing more than a direct copy per frame.
//
// ITS OWN COMMAND AND ITS OWN FILE, for the reason measurement 16 already
// records paying: it shares its patches and its upload path with `colour`,
// which sits inside `run.mjs all`, and `all` writes the results.json the decode
// ladder, the readback ladder and two ONNX timings are read from.

import { firstFrameOf, PATCHES, COLS, ROWS, viaCopyExternalImage, viaExternalTexture } from './colour.ts';
import { decodeWith, spsOf, type Sps } from './range.ts';
import { decodeOne, sample, stats, type Stat } from './util.ts';
import { BlobSource, EncodedPacketSink, Input, MP4 } from 'mediabunny';

/** The grey ramp, which is the first ten patches and where a transfer lives. */
const GREYS = 10;

type Triple = readonly [number, number, number];

/**
 * The three clips that state their transfer, and the one that never did.
 *
 * The last two are here to be the thing the first three are read against. They
 * are the clips every figure about these eleven codes has been taken on, and
 * what they do not say is the finding. The 4:4:4 one earns its row twice over:
 * measurement 4 reports it coming back clean and attributes that to I444 rather
 * than NV12, and the decoder table below says what is really different about
 * it.
 */
const CLIPS = [
  'probe-trc709-709',
  'probe-trc709-srgb',
  'probe-trcsrgb-srgb',
  'probe-420-tv',
  'probe-444-lossless',
] as const;

/** The clip the whole question turns on: it says bt709 and it is bt709. */
const HONEST = 'probe-trc709-709';

/** The patch centres of a 1920x1080 probe, in the order PATCHES declares them. */
function centres(width: number, height: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < PATCHES.length; i++) {
    out.push([
      Math.floor(((i % COLS) + 0.5) * (width / COLS)),
      Math.floor((Math.floor(i / COLS) + 0.5) * (height / ROWS)),
    ]);
  }
  return out;
}

/**
 * The patches through a 2D canvas and back, which is the path that answers
 * differently.
 *
 * `getImageData` rather than a texture, because this is the reading measurement
 * 16 took and the one the trials ledger records. What it would cost to actually
 * USE is the row below it, which puts the canvas in front of the same upload
 * the product already does.
 */
function viaCanvas(frame: VideoFrame): Triple[] {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const surface = new OffscreenCanvas(width, height);
  const context = surface.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(frame, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  return centres(width, height).map(([x, y]) => {
    const o = (y * width + x) * 4;
    return [data[o] ?? -1, data[o + 1] ?? -1, data[o + 2] ?? -1] as Triple;
  });
}

/**
 * The patches through a 2D canvas and then onto the GPU, which is the path the
 * product would have to take to get the canvas's answer.
 *
 * `getImageData` above is a reading, not a design: it brings twelve megabytes
 * back through system memory per frame, which is the cost measurement 1 already
 * rejected for the model's own input. This is the version somebody would
 * actually ship, and it exists so that the colour and the cost are answered
 * about the same code rather than about two different ideas.
 */
async function viaCanvasThenCopy(dev: GPUDevice, frame: VideoFrame): Promise<Triple[]> {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const surface = new OffscreenCanvas(width, height);
  const context = surface.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(frame, 0, 0);

  const texture = dev.createTexture({
    size: { width, height },
    format: 'rgba8unorm',
    viewFormats: ['rgba8unorm-srgb'],
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.TEXTURE_BINDING,
  });
  dev.queue.copyExternalImageToTexture(
    { source: surface, flipY: false },
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

  return centres(width, height).map(([x, y]) => {
    const o = y * bytesPerRow + x * 4;
    return [bytes[o] ?? -1, bytes[o + 1] ?? -1, bytes[o + 2] ?? -1] as Triple;
  });
}

/** The grey ramp out of a set of patches, which is what a table can show. */
const rampOf = (patches: readonly Triple[]): number[] =>
  patches.slice(0, GREYS).map((patch) => patch[0] ?? -1);

/** Per patch, the worst of its three channels, between two readings of one set. */
function deltas(a: readonly Triple[], b: readonly Triple[] | undefined): number[] | null {
  if (!b) return null;
  const out: number[] = [];
  for (const [i, got] of a.entries()) {
    const other = b[i];
    if (!other) return null;
    let worst = 0;
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((got[c] ?? 0) - (other[c] ?? 0)));
    out.push(worst);
  }
  return out;
}

/** The worst single channel between two readings of the same sixteen patches. */
function worstBetween(a: readonly Triple[], b: readonly Triple[] | undefined): number | null {
  const per = deltas(a, b);
  return per ? Math.max(...per) : null;
}

/**
 * And the median of the GREY RAMP, which is the statistic that separates the
 * two answers.
 *
 * The worst error alone says these paths are within a code of each other on the
 * clip that decides this, and that is true and useless: one of them is exact
 * over most of the ramp and wrong in the shadows, the other is wrong everywhere
 * by about the same amount. A worst reports the first as if it were the second.
 *
 * The ramp rather than all sixteen, because six of the patches are saturated
 * primaries and secondaries whose channels are 0 and 255, which is exactly where
 * every transfer curve here agrees with every other. A median over all sixteen
 * is mostly a median over patches that cannot move.
 */
function medianOfTheRamp(a: readonly Triple[], b: readonly Triple[] | undefined): number | null {
  const per = deltas(a.slice(0, GREYS), b?.slice(0, GREYS));
  return per ? stats(per).median : null;
}

/** What ffmpeg left beside the clips; see the end of make-clips.sh. */
interface Control {
  readonly how: string;
  readonly version: string;
  readonly clips: Record<string, { readonly as_stored: unknown; readonly to_srgb: unknown }>;
}

/**
 * The control, checked rather than asserted.
 *
 * It comes off a disk and is written by a different tool in a different
 * language, which is the same argument the document format makes for checking
 * its own header: what an unchecked one produces here is not an error, it is a
 * comparison against `undefined` reported as a number.
 */
function isControl(value: unknown): value is Control {
  return (
    typeof value === 'object' && value !== null && 'clips' in value && 'how' in value && 'version' in value
  );
}

/** A reading out of the control, or nothing where ffmpeg refused the file. */
function controlPatches(value: unknown): Triple[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((patch: unknown) => {
    const triple = Array.isArray(patch) ? patch : [];
    return [Number(triple[0]), Number(triple[1]), Number(triple[2])] as Triple;
  });
}

interface Declared {
  readonly video_full_range_flag: number | null;
  readonly colour_primaries: number | null;
  readonly transfer_characteristics: number | null;
  readonly matrix_coefficients: number | null;
}

/** What the file says about itself, out of the SPS rather than off a filename. */
function declared(sps: Sps | { error: string }): Declared | { error: string } {
  if ('error' in sps) return { error: sps.error };
  return {
    video_full_range_flag: sps.video_full_range_flag,
    colour_primaries: sps.colour_primaries,
    transfer_characteristics: sps.transfer_characteristics,
    matrix_coefficients: sps.matrix_coefficients,
  };
}

const spaceOf = (value: VideoColorSpace): VideoColorSpaceInit => ({
  primaries: value.primaries,
  transfer: value.transfer,
  matrix: value.matrix,
  fullRange: value.fullRange,
});

interface PathReading {
  readonly ramp: number[];
  readonly worst_against_ffmpeg: number | null;
  readonly median_of_the_ramp_against_ffmpeg: number | null;
  readonly worst_against_what_was_drawn: number | null;
}

interface ClipReading {
  readonly file_bytes: number;
  readonly format: string;
  readonly declares: Declared | { error: string };
  readonly frame_says: VideoColorSpaceInit;
  readonly ffmpeg: { readonly as_stored: unknown; readonly converted_to_srgb: unknown };
  readonly paths: Record<string, PathReading>;
}

/**
 * One clip, through every way a page has of looking at a decoded frame.
 *
 * The two references are both here on purpose. WHAT WAS DRAWN is the sRGB the
 * picture was made from, which is the right answer only for a file that says
 * what it is; WHAT FFMPEG SAYS is what an independent reader makes of this
 * particular file, which is the right answer always. On the honest clip they
 * are the same reading, and that is the check rather than a coincidence.
 */
async function readClip(
  dev: GPUDevice,
  base: string,
  name: string,
  control: Control | undefined,
): Promise<ClipReading> {
  const blob = await (await fetch(`${base}/${name}.mp4`)).blob();
  const { frame, config } = await firstFrameOf(blob);
  try {
    const paths: Record<string, Triple[]> = {
      // What the product does, in `uploadFrameToTexture`'s own call.
      copyExternalImageToTexture: await viaCopyExternalImage(dev, frame),
      // And what a playing frame could do instead, which answers the same.
      'importExternalTexture, and a pass': await viaExternalTexture(dev, frame, 'rgba8unorm'),
      // The reading that started this, and the shippable version of it.
      'drawImage, then getImageData': viaCanvas(frame),
      'drawImage, then copyExternalImageToTexture': await viaCanvasThenCopy(dev, frame),
    };
    const fromControl = control?.clips[name];
    const ffmpeg = controlPatches(fromControl?.to_srgb);
    const stored = controlPatches(fromControl?.as_stored);

    const readings: Record<string, PathReading> = {};
    for (const [label, patches] of Object.entries(paths)) {
      readings[label] = {
        ramp: rampOf(patches),
        worst_against_ffmpeg: worstBetween(patches, ffmpeg),
        median_of_the_ramp_against_ffmpeg: medianOfTheRamp(patches, ffmpeg),
        worst_against_what_was_drawn: worstBetween(patches, PATCHES),
      };
    }

    return {
      file_bytes: blob.size,
      format: String(frame.format),
      declares: declared(spsOf(config)),
      frame_says: spaceOf(frame.colorSpace),
      ffmpeg: {
        // The stored codes, which is the check that the clip is the clip before
        // anything is concluded about what a reader does to it. Where ffmpeg
        // refused the file its reason is passed through instead of a number,
        // because the refusal is the reading.
        as_stored: stored ? rampOf(stored) : (fromControl?.as_stored ?? null),
        converted_to_srgb: ffmpeg ? rampOf(ffmpeg) : (fromControl?.to_srgb ?? null),
      },
      paths: readings,
    };
  } finally {
    frame.close();
  }
}

/**
 * The clips that matter through each decoder in turn.
 *
 * Measurement 16 established that this browser has two H.264 decoders, that
 * frame size picks one, and that only one of them applies the range flag. This
 * asks the second question of the same pair and gets the same shape of answer:
 * the conversion belongs to the hardware decoder, and the software decoder does
 * nothing to any clip.
 *
 * The 4:4:4 probe is the row that closes measurement 4's other attribution. It
 * reports that clip coming back clean and says Chrome applies the conversion on
 * the NV12 path and not on the I444 one. There is no I444 hardware decoder to
 * take it, which is a different sentence: asked for hardware it is still not
 * converted, because asking does not produce a decoder that does not exist.
 */
async function whichDecoder(dev: GPUDevice, base: string, control: Control | undefined) {
  const out: Record<string, unknown> = {};
  const cases: readonly (readonly [string, HardwareAcceleration])[] = [
    [HONEST, 'no-preference'],
    [HONEST, 'prefer-hardware'],
    [HONEST, 'prefer-software'],
    ['probe-444-lossless', 'no-preference'],
    ['probe-444-lossless', 'prefer-hardware'],
  ];
  for (const [clip, acceleration] of cases) {
    const frame = await decodeWith(`${base}/${clip}.mp4`, acceleration);
    if (!(frame instanceof VideoFrame)) {
      out[`${clip}, ${acceleration}`] = frame;
      continue;
    }
    try {
      const patches = await viaCopyExternalImage(dev, frame);
      const stored = controlPatches(control?.clips[clip]?.as_stored);
      out[`${clip}, ${acceleration}`] = {
        format: String(frame.format),
        ramp: rampOf(patches),
        // A conversion happened, or it did not. Written as the question rather
        // than left for a reader to infer from a ramp, and asked against the
        // codes ffmpeg reads out of the file rather than against the picture,
        // because "did anything happen to these bytes" is what it means.
        converted: (worstBetween(patches, stored) ?? 0) > 1,
        worst_against_ffmpeg: worstBetween(patches, controlPatches(control?.clips[clip]?.to_srgb)),
      };
    } finally {
      frame.close();
    }
  }
  return out;
}

/**
 * What each way of getting a frame onto the GPU costs, at 1080p, fenced.
 *
 * On the decode clip rather than on a probe, so the direct copy is the same
 * number measurement 3 already reports for the same call and this table can be
 * read against it. A flat probe is not a fair thing to time an upload with, and
 * the row that matters is a difference between two rows here anyway.
 */
async function cost(dev: GPUDevice, base: string): Promise<Record<string, Stat | number>> {
  const blob = await (await fetch(`${base}/1080p30-gop30.mp4`)).blob();
  const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track');
  const config = await track.getDecoderConfig();
  if (!config) throw new Error('no decoder config');
  const packet = await new EncodedPacketSink(track).getFirstKeyPacket();
  if (!packet) throw new Error('no key packet');
  const frame = await decodeOne(config, packet.toEncodedVideoChunk());
  input.dispose();

  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const texture = dev.createTexture({
    size: { width, height },
    format: 'rgba8unorm',
    viewFormats: ['rgba8unorm-srgb'],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const surface = new OffscreenCanvas(width, height);
  const context = surface.getContext('2d');
  if (!context) throw new Error('no 2d context');

  try {
    const direct = await sample(50, 10, async () => {
      dev.queue.copyExternalImageToTexture(
        { source: frame, flipY: false },
        { texture, premultipliedAlpha: false },
        { width, height },
      );
      await dev.queue.onSubmittedWorkDone();
    });
    const draw = await sample(50, 10, async () => {
      context.drawImage(frame, 0, 0);
      await dev.queue.onSubmittedWorkDone();
    });
    const drawThenCopy = await sample(50, 10, async () => {
      context.drawImage(frame, 0, 0);
      dev.queue.copyExternalImageToTexture(
        { source: surface, flipY: false },
        { texture, premultipliedAlpha: false },
        { width, height },
      );
      await dev.queue.onSubmittedWorkDone();
    });
    return {
      copyExternalImageToTexture: direct,
      drawImage: draw,
      'drawImage, then copyExternalImageToTexture': drawThenCopy,
      // The figure worth quoting, and it is a difference between two rows of
      // ONE run rather than between two runs. The direct copy is the noisiest
      // thing in this table on this machine, at 0.6 to 1.2 ms across runs of a
      // call measurement 3 reports at 0.9, so what a canvas ADDS is stable
      // where either row alone is not.
      added_by_the_canvas: Math.round((drawThenCopy.median - direct.median) * 100) / 100,
    };
  } finally {
    texture.destroy();
    frame.close();
  }
}

export async function transfer(dev: GPUDevice, base: string): Promise<unknown> {
  let control: Control | undefined;
  let controlError: string | undefined;
  try {
    const parsed: unknown = await (await fetch(`${base}/ffmpeg-transfer.json`)).json();
    if (isControl(parsed)) control = parsed;
    else controlError = 'ffmpeg-transfer.json is not the shape make-clips.sh writes';
  } catch (e) {
    // Reported rather than thrown. Without ffmpeg's reading every number below
    // is still taken; what is lost is the one thing that can call any of them
    // right, and a run that says so is more use than one that stops.
    controlError = String(e);
  }

  const clips: Record<string, ClipReading | { readonly error: string }> = {};
  for (const name of CLIPS) {
    try {
      clips[name] = await readClip(dev, base, name, control);
    } catch (e) {
      clips[name] = { error: String(e) };
    }
  }

  const read = (clip: string): ClipReading | undefined => {
    const value = clips[clip];
    return value && !('error' in value) ? value : undefined;
  };
  const path = (clip: string, label: string): PathReading | undefined => read(clip)?.paths[label];
  const stated = (clip: string): number | null => {
    const declares = read(clip)?.declares;
    return declares && !('error' in declares) ? declares.transfer_characteristics : null;
  };
  const UPLOAD = 'copyExternalImageToTexture';
  const CANVAS = 'drawImage, then copyExternalImageToTexture';

  return {
    what: 'three probes that state their transfer, through every way a page can read a frame',
    patches: PATCHES.length,
    what_was_drawn: PATCHES.slice(0, GREYS).map((patch) => patch[0]),
    control: control
      ? { how: control.how, version: control.version }
      : { error: controlError ?? 'no control' },
    // The questions, in the order that makes the last one mean something. The
    // first is the one five chapters of probes could not answer, because none
    // of them said anything for a reader to act on.
    the_transfer_reaches_the_bitstream: Object.fromEntries(CLIPS.map((name) => [name, stated(name)])),
    // Told sRGB, the import converts nothing; told bt709, it converts. Both are
    // the SAME PICTURE encoded the same way, so the tag is the only thing that
    // differs and the eleven codes are the tag being obeyed rather than a
    // defect in the path. Read against what was drawn, because for these two
    // that is what the sRGB content is.
    the_tag_decides_it: {
      'says sRGB, and is sRGB': path('probe-trcsrgb-srgb', UPLOAD)?.worst_against_what_was_drawn ?? null,
      'says bt709, and is sRGB': path('probe-trc709-srgb', UPLOAD)?.worst_against_what_was_drawn ?? null,
      'says nothing, and is sRGB': path('probe-420-tv', UPLOAD)?.worst_against_what_was_drawn ?? null,
    },
    // On the clip that says bt709 and IS bt709, which is the whole experiment.
    // Against ffmpeg, which on this clip is also what was drawn.
    //
    // BOTH STATISTICS, because the worst on its own says these two are the same
    // answer and they are not: one is within a code of ffmpeg over most of the
    // ramp and walks away from it in the shadows, the other is that far out
    // everywhere. The medians are what say which is which.
    on_a_clip_that_means_what_it_says: {
      [UPLOAD]: {
        worst: path(HONEST, UPLOAD)?.worst_against_ffmpeg ?? null,
        median_of_the_ramp: path(HONEST, UPLOAD)?.median_of_the_ramp_against_ffmpeg ?? null,
      },
      [CANVAS]: {
        worst: path(HONEST, CANVAS)?.worst_against_ffmpeg ?? null,
        median_of_the_ramp: path(HONEST, CANVAS)?.median_of_the_ramp_against_ffmpeg ?? null,
      },
    },
    clips,
    which_decoder: await whichDecoder(dev, base, control),
    // And what the other behaviour would cost per frame, which is the half of
    // the answer that does not depend on which reading anybody prefers.
    cost_ms: await cost(dev, base),
  };
}
