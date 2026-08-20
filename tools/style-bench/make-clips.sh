#!/bin/sh
# The inputs the style measurements run against. Needs ffmpeg and node.
#
# Gitignored, like video-bench's: they are a few megabytes and this is one
# command. What matters is that the numbers can be reproduced against the same
# picture rather than against whatever happened to be on the machine.
#
# THE STATIC CLIP IS THE MEASUREMENT. Camera fixed, scene fixed, so every
# difference between consecutive frames is sensor grain and the codec's own
# noise - a couple of codes. Whatever a style turns that into is its own doing,
# and that is what temporal stability means.
set -eu
cd "$(dirname "$0")"
mkdir -p clips
node make-scene.mjs clips/scene.png

cd clips
common="-c:v libx264 -profile:v high -preset medium -crf 18 -pix_fmt yuv420p \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -movflags +faststart"

echo "static-1080p.mp4 (fixed camera, grain only)"
# shellcheck disable=SC2086
ffmpeg -v error -y -loop 1 -i scene.png -t 2 -r 30 \
  -vf "noise=alls=4:allf=t,format=yuv420p" $common -g 30 static-1080p.mp4

echo "static-720p.mp4 (the same, at the size playback was measured at)"
# shellcheck disable=SC2086
ffmpeg -v error -y -loop 1 -i scene.png -t 2 -r 30 \
  -vf "scale=1280:720,noise=alls=4:allf=t,format=yuv420p" $common -g 30 static-720p.mp4

echo "traffic-720p.mp4 (the camera is fixed and things in front of it move)"
# THE CLIP A TEMPORAL METHOD HAS TO BE JUDGED ON. The two above are the two
# degenerate cases: on the static one nothing moves at all, and on the pan
# everything moves together, which is the case a warp of the last frame gets
# right by construction. Neither can show a smear, because a smear needs
# something to move against something that does not, and ground that has just
# been uncovered.
#
# The masks beside it say which pixels a moving thing covered on each frame,
# drawn from the same geometry as the picture rather than inferred from it, and
# encoded through the same scale filter so the two line up to the pixel.
node ../make-scene.mjs --sequence traffic --frames 60 --fps 30

# shellcheck disable=SC2086
ffmpeg -v error -y -framerate 30 -i "traffic/f%04d.png" \
  -vf "scale=1280:720,noise=alls=4:allf=t,format=yuv420p" $common -g 30 traffic-720p.mp4

# The same frames with no temporal grain on them, so a measurement can ask what
# the motion alone does before asking what the motion and the grain do together.
# shellcheck disable=SC2086
ffmpeg -v error -y -framerate 30 -i "traffic/f%04d.png" \
  -vf "scale=1280:720,format=yuv420p" $common -g 30 traffic-clean-720p.mp4

echo "traffic-mask-720p.mp4 (which pixels a moving thing covered)"
# Lossless, because this one is not a picture: a mask read back through a lossy
# codec is a mask with a different boundary from the one that was drawn, and the
# boundary is the half of it that matters.
ffmpeg -v error -y -framerate 30 -i "traffic/m%04d.png" \
  -vf "scale=1280:720,format=yuv444p" -c:v libx264 -qp 0 -g 30 -movflags +faststart \
  traffic-mask-720p.mp4

# The frames themselves are a quarter of a gigabyte and everything that reads
# them is now a video, so they go. Re-run this script to get them back.
rm -rf traffic

echo "pan-720p.mp4 (the camera moves, so the picture genuinely changes)"
# A slow push across the frame: real inter-frame difference to compare the
# static clip's amplification against.
# shellcheck disable=SC2086
ffmpeg -v error -y -loop 1 -i scene.png -t 2 -r 30 \
  -vf "crop=1280:720:x='(in_w-1280)*t/2.2':y='(in_h-720)*0.55',noise=alls=4:allf=t,format=yuv420p" \
  $common -g 30 pan-720p.mp4

ls -la
