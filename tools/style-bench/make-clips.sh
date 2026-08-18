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

echo "pan-720p.mp4 (the camera moves, so the picture genuinely changes)"
# A slow push across the frame: real inter-frame difference to compare the
# static clip's amplification against.
# shellcheck disable=SC2086
ffmpeg -v error -y -loop 1 -i scene.png -t 2 -r 30 \
  -vf "crop=1280:720:x='(in_w-1280)*t/2.2':y='(in_h-720)*0.55',noise=alls=4:allf=t,format=yuv420p" \
  $common -g 30 pan-720p.mp4

ls -la
