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
# shellcheck disable=SC2086
ffmpeg -v error -y $probe -c:v libx264 -crf 14 -pix_fmt yuv420p -color_range pc probe-420-pc.mp4
rm -f /tmp/rotyl-probe.rgb

ls -la
