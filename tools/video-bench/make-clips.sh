#!/bin/sh
# Regenerate the clips the benchmarks run against. Needs ffmpeg and node.
#
# Gitignored, like the model graphs next door: they are 22 MB and this is one
# command. What matters is that the numbers can be reproduced against the same
# input rather than against whatever clip happened to be on the machine.
set -eu
cd "$(dirname "$0")"
mkdir -p clips
cd clips

# Two 1080p30 clips, identical content, differing only in keyframe interval.
# That is the whole point: seek cost is set by GOP length and by nothing else,
# so one clip cannot show it. A zooming fractal under film grain is deliberately
# harder to decode than ordinary footage, which makes the decode figures a floor
# rather than a best case.
common="-c:v libx264 -profile:v high -preset medium -b:v 8M -sc_threshold 0 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -movflags +faststart"

echo "1080p30-gop30.mp4 (1 s keyframes)"
# shellcheck disable=SC2086
ffmpeg -v error -y -f lavfi -i "mandelbrot=size=1920x1080:rate=30:maxiter=800" -t 10 \
  -vf "noise=alls=8:allf=t+u,format=yuv420p" $common -g 30 -keyint_min 30 1080p30-gop30.mp4

echo "720p30-gop30.mp4 (the same content, one step down)"
# The same picture at 720p, so the encode table can sit next to the style table,
# which is anchored at 720p. Scaled from the 1080p clip rather than rendered
# again: identical content is what makes the two rows comparable.
# shellcheck disable=SC2086
ffmpeg -v error -y -i 1080p30-gop30.mp4 -vf "scale=1280:720" -pix_fmt yuv420p $common \
  -g 30 -keyint_min 30 720p30-gop30.mp4

echo "1080p30-gop300.mp4 (one keyframe, the whole clip)"
# shellcheck disable=SC2086
ffmpeg -v error -y -i 1080p30-gop30.mp4 -pix_fmt yuv420p $common -g 300 -keyint_min 300 \
  1080p30-gop300.mp4

# Two clips with sound in them, because until this chapter nothing here had any
# and a clip export that drops a soundtrack cannot be measured against one that
# keeps it. Both stream-copy the video from the clip above, so the picture is
# the same picture and the audio track is the only thing that differs.
echo "1080p30-aac.mp4 (the same video, with a soundtrack)"
# Pink noise rather than a tone. A tone compresses to nearly nothing and gives
# every packet the same length, which is the one shape an interleaving
# measurement must not be taken against: packets that are all the same size make
# any arrangement of them look regular.
ffmpeg -v error -y -i 1080p30-gop30.mp4 \
  -f lavfi -i "anoisesrc=color=pink:seed=7:sample_rate=48000:duration=10:amplitude=0.4,aformat=channel_layouts=stereo" \
  -map 0:v -map 1:a -c:v copy -c:a aac -b:a 128k -movflags +faststart 1080p30-aac.mp4

echo "1080p30-ulaw.mov (a soundtrack an MP4 cannot carry)"
# QuickTime carries mu-law and MP4 does not, which is the case the export has to
# say something about BEFORE it encodes anything rather than after. Made rather
# than hoped for: without a file that provokes it, the branch that refuses is
# code nobody has ever run.
ffmpeg -v error -y -i 1080p30-gop30.mp4 \
  -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=10" \
  -map 0:v -map 1:a -c:v copy -c:a pcm_mulaw 1080p30-ulaw.mov

# The colour probe: sixteen flat patches whose sRGB bytes are known exactly, so
# what a decoded frame does to them is a number rather than an impression. The
# patch values are duplicated in colour.ts and must stay in step.
echo "colour probes"
node -e '
const W = 1920, H = 1080, COLS = 4, ROWS = 4;
const patches = [
  [0,0,0],[16,16,16],[32,32,32],[64,64,64],
  [96,96,96],[128,128,128],[160,160,160],[192,192,192],
  [235,235,235],[255,255,255],[255,0,0],[0,255,0],
  [0,0,255],[255,255,0],[0,255,255],[255,0,255],
];
const buf = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = patches[Math.floor(y / (H / ROWS)) * COLS + Math.floor(x / (W / COLS))];
    const o = (y * W + x) * 3;
    buf[o] = p[0]; buf[o + 1] = p[1]; buf[o + 2] = p[2];
  }
}
for (let i = 0; i < 30; i++) process.stdout.write(buf);
' > /tmp/rotyl-probe.rgb

probe="-f rawvideo -pix_fmt rgb24 -s 1920x1080 -framerate 30 -i /tmp/rotyl-probe.rgb -frames:v 30 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -movflags +faststart"

# Lossless 4:4:4 isolates colour handling from everything else: any difference
# is the browser's conversion, not the encoder's.
# shellcheck disable=SC2086
ffmpeg -v error -y $probe -c:v libx264 -qp 0 -pix_fmt yuv444p -color_range tv \
  probe-444-lossless.mp4
# 4:2:0 is what every real clip is.
# shellcheck disable=SC2086
ffmpeg -v error -y $probe -c:v libx264 -crf 14 -pix_fmt yuv420p -color_range tv probe-420-tv.mp4
# The same picture encoded FULL range, which is the pair the range question is
# asked of: this one's luma runs 0 to 255 where the one above runs 16 to 235,
# and its SPS carries video_full_range_flag = 1 where that one carries 0.
#
# yuvj420p is stated rather than left to -color_range to imply. This ffmpeg
# turns `pc` into yuvj420p on its own and produces a byte-identical file either
# way, and an older one does not, which is how these two clips came to be
# believed identical for four chapters when they never were. Measurement 16
# checks both halves at run time rather than trusting this line.
# shellcheck disable=SC2086
ffmpeg -v error -y $probe -c:v libx264 -crf 14 -pix_fmt yuvj420p -color_range pc probe-420-pc.mp4
rm -f /tmp/rotyl-probe.rgb

# The same eight flat greys at a ladder of sizes, full range, plus one limited
# control at the smallest. Which decoder Chrome picks depends on frame size, and
# only one of the two honours the range flag, so a pair at one size cannot see
# the thing this ladder exists to locate. Eight patches rather than sixteen
# because the answer is in the grey ramp and a 160-pixel-wide frame has no room
# for a four by four grid.
echo "range ladder"
for size in 320x180 480x270 640x360 1280x720; do
  width=${size%x*}
  height=${size#*x}
  node -e '
const [W, H] = [Number(process.argv[1]), Number(process.argv[2])];
const COLS = 4, ROWS = 2;
const patches = [
  [0,0,0],[32,32,32],[64,64,64],[96,96,96],
  [128,128,128],[160,160,160],[192,192,192],[255,255,255],
];
const buf = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = patches[Math.floor(y / (H / ROWS)) * COLS + Math.floor(x / (W / COLS))];
    const o = (y * W + x) * 3;
    buf[o] = p[0]; buf[o + 1] = p[1]; buf[o + 2] = p[2];
  }
}
for (let i = 0; i < 6; i++) process.stdout.write(buf);
' "$width" "$height" > /tmp/rotyl-range.rgb
  ladder="-f rawvideo -pix_fmt rgb24 -s $size -framerate 30 -i /tmp/rotyl-range.rgb -frames:v 6     -colorspace bt709 -movflags +faststart -c:v libx264 -crf 14"
  # shellcheck disable=SC2086
  ffmpeg -v error -y $ladder -pix_fmt yuvj420p -color_range pc "range-pc-$size.mp4"
  # shellcheck disable=SC2086
  ffmpeg -v error -y $ladder -pix_fmt yuv420p -color_range tv "range-tv-$size.mp4"
done
rm -f /tmp/rotyl-range.rgb

# The same sixteen patches again, three more ways, for the one thing every
# probe above has in common and none of them meant to: NONE OF THEM SAYS WHAT
# ITS TRANSFER IS. The lines above ask ffmpeg for `-color_trc bt709` and it does
# not reach the bitstream, so every clip here declares transfer_characteristics
# = 2, "unspecified", which the browser defaults to bt709. So the probes hold
# sRGB-transfer values labelled BT.709, and what a conversion does to them says
# nothing about what it does to footage that means what it says.
#
# Three clips settle it, and the pairing is the measurement:
#
#   probe-trc709-709    says bt709 and IS bt709: the patches taken into linear
#                       light and back out through the BT.709 OETF. What a
#                       correct reader gives back is the sRGB the patches were
#                       drawn from.
#   probe-trc709-srgb   says bt709 and is sRGB, which is what every probe above
#                       has always been, with the tag written down rather than
#                       defaulted. It is the control on the default.
#   probe-trcsrgb-srgb  says sRGB and IS sRGB. A reader that acts on the tag has
#                       nothing to do here, and one that converts regardless
#                       cannot hide behind the tag.
#
# The transfer goes in through -x264-params rather than -color_trc, because that
# is the one that arrives. Measurement 17 reads it back out of the SPS.
echo "transfer probes"
node -e '
const W = 1920, H = 1080, COLS = 4, ROWS = 4;
// The same sixteen as above and as colour.ts, and they must stay in step.
const patches = [
  [0,0,0],[16,16,16],[32,32,32],[64,64,64],
  [96,96,96],[128,128,128],[160,160,160],[192,192,192],
  [235,235,235],[255,255,255],[255,0,0],[0,255,0],
  [0,0,255],[255,255,0],[0,255,255],[255,0,255],
];
// sRGB code -> light -> BT.709 code. Both curves written out rather than
// approximated by a power, because the toe is exactly where the answer turned
// out to live.
const toLight = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
const to709 = (L) => L < 0.018 ? 4.5 * L : 1.099 * Math.pow(L, 0.45) - 0.099;
const bt709 = patches.map((p) => p.map((v) => Math.round(255 * to709(toLight(v)))));
const frame = (rows) => {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = rows[Math.floor(y / (H / ROWS)) * COLS + Math.floor(x / (W / COLS))];
      const o = (y * W + x) * 3;
      buf[o] = p[0]; buf[o + 1] = p[1]; buf[o + 2] = p[2];
    }
  }
  return buf;
};
const fs = require("fs");
for (const [name, rows] of [["srgb", patches], ["709", bt709]]) {
  const buf = frame(rows);
  const fd = fs.openSync(`/tmp/rotyl-transfer-${name}.rgb`, "w");
  for (let i = 0; i < 30; i++) fs.writeSync(fd, buf);
  fs.closeSync(fd);
}
'

transfer="-frames:v 30 -colorspace bt709 -movflags +faststart -c:v libx264 -crf 14 \
  -pix_fmt yuv420p -color_range tv"
# shellcheck disable=SC2086
ffmpeg -v error -y -f rawvideo -pix_fmt rgb24 -s 1920x1080 -framerate 30 -i /tmp/rotyl-transfer-709.rgb \
  $transfer -x264-params colorprim=bt709:transfer=bt709 probe-trc709-709.mp4
# shellcheck disable=SC2086
ffmpeg -v error -y -f rawvideo -pix_fmt rgb24 -s 1920x1080 -framerate 30 -i /tmp/rotyl-transfer-srgb.rgb \
  $transfer -x264-params colorprim=bt709:transfer=bt709 probe-trc709-srgb.mp4
# shellcheck disable=SC2086
ffmpeg -v error -y -f rawvideo -pix_fmt rgb24 -s 1920x1080 -framerate 30 -i /tmp/rotyl-transfer-srgb.rgb \
  $transfer -x264-params colorprim=bt709:transfer=iec61966-2-1 probe-trcsrgb-srgb.mp4
rm -f /tmp/rotyl-transfer-709.rgb /tmp/rotyl-transfer-srgb.rgb

# AND THE CONTROL, WHICH HAS TO BE TAKEN HERE BECAUSE IT IS FFMPEG'S. The
# question measurement 17 asks is which of the browser's two answers is right,
# and "right" needs somebody who is not the browser to say what these files
# mean. ffmpeg decodes each one twice: once with no conversion, which is the
# stored codes and is the check that the clip is the clip, and once converted to
# an sRGB transfer, which is what the picture is in the space the product works
# in. The answers are left beside the clips as JSON and fetched by the harness,
# because a benchmark in a browser cannot run ffmpeg and a control quoted from
# somebody's terminal is not a control.
echo "the ffmpeg control"
node -e '
const { execFileSync } = require("child_process");
const fs = require("fs");
const W = 1920, H = 1080, COLS = 4, ROWS = 4, PATCHES = 16;
// All sixteen, in all three channels, because the six colour patches move under
// a transfer conversion as well and a control that only reads the grey ramp
// would leave the harness comparing part of the picture.
const patchesOf = (buf) => {
  const out = [];
  for (let i = 0; i < PATCHES; i++) {
    const x = Math.floor(((i % COLS) + 0.5) * (W / COLS));
    const y = Math.floor((Math.floor(i / COLS) + 0.5) * (H / ROWS));
    const o = (y * W + x) * 3;
    out.push([buf[o], buf[o + 1], buf[o + 2]]);
  }
  return out;
};
const decode = (clip, filter) => {
  const args = ["-v", "error", "-i", clip, "-frames:v", "1"];
  if (filter) args.push("-vf", filter);
  args.push("-pix_fmt", "rgb24", "-f", "rawvideo", "-");
  try {
    return patchesOf(execFileSync("ffmpeg", args, { maxBuffer: 1 << 30 }));
  } catch (e) {
    // A REFUSAL IS A READING. The clips this project started with declare
    // neither primaries nor transfer, so the filter has nothing to convert FROM
    // and says so rather than guessing, which is the whole finding said by the
    // control. The first line is the reason; everything after it is the
    // pipeline falling over behind it.
    // The filter tag and the pointer in front of it come out: they are noise
    // that differs between runs, and a results file that changes when nothing
    // did is a results file nobody can date.
    const line = String(e.stderr ?? e).trim().split("\n")[0];
    return { refused: line.replace(/^\[[^\]]*\]\s*/, "") };
  }
};
// bt709 in, sRGB out. all=bt709 states the matrix and the primaries, which
// these files carry anyway, so what is left for the filter to do is the curve.
const TO_SRGB = "colorspace=all=bt709:trc=srgb:format=yuv444p";
const clips = [
  "probe-trc709-709", "probe-trc709-srgb", "probe-trcsrgb-srgb",
  // And the two clips the question was asked with for five chapters, which are
  // here to be refused rather than to be measured: neither says what it is.
  "probe-420-tv", "probe-444-lossless",
];
const out = {
  what: "the same patches read by ffmpeg, once as stored and once converted to an sRGB transfer",
  how: `ffmpeg -i <clip> -vf ${TO_SRGB} -pix_fmt rgb24`,
  version: execFileSync("ffmpeg", ["-version"]).toString().split("\n")[0],
  drawn_from: [0, 16, 32, 64, 96, 128, 160, 192, 235, 255],
  clips: Object.fromEntries(clips.map((clip) => [clip, {
    as_stored: decode(`${clip}.mp4`, null),
    to_srgb: decode(`${clip}.mp4`, TO_SRGB),
  }])),
};
fs.writeFileSync("ffmpeg-transfer.json", JSON.stringify(out, null, 2) + "\n");
'

ls -la
