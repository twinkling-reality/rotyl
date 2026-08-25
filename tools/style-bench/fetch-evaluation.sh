#!/bin/sh
# Licensed evaluation stills for the Anime treatment. Photographs are CC0.
# Nothing fetched is committed or redistributed.
#
#   ./tools/style-bench/fetch-real.sh
#   ./tools/style-bench/fetch-evaluation.sh
set -eu
cd "$(dirname "$0")"
mkdir -p real/evaluation

# Hashes are of the file as downloaded. A stale URL fails rather than measuring
# a different person under the same name.

verify() {
  have=$(shasum -a 256 "$1" | cut -d' ' -f1)
  if [ "$2" != "PENDING" ] && [ "$have" != "$2" ]; then
    echo "  $1: expected $2"
    echo "  $1: got      $have"
    exit 1
  fi
  if [ "$2" = "PENDING" ]; then
    echo "  $1 sha256 $have"
  fi
}

get() {
  dest=$1
  sha=$2
  url=$3
  if [ -f "$dest" ]; then
    verify "$dest" "$sha"
    echo "  $dest (cached)"
    return
  fi
  echo "  $dest"
  curl -fsS -L --retry 3 -H 'User-Agent: rotyl-style-bench (research)' -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
  verify "$dest" "$sha"
}

echo "evaluation stills, CC0, from Wikimedia Commons"
if [ -f real/portrait.jpg ]; then
  ln -sfn ../portrait.jpg real/evaluation/portrait-close.jpg
  echo "  real/evaluation/portrait-close.jpg (from fetch-real.sh)"
else
  get real/evaluation/portrait-close.jpg 643d6477faf515340c758e140e0851247a4b02bffd7e899a8e1ab02c6638fb7b \
    "https://upload.wikimedia.org/wikipedia/commons/4/4a/Photographer_in_close-up_%28Unsplash%29.jpg"
fi

get real/evaluation/portrait-somali.jpg 96d0514bd2b13fb5f59f4c973c696dcb2114493d133d803e26671aa10c0b238d \
  "https://upload.wikimedia.org/wikipedia/commons/c/c4/Somali_girl_01.jpg"
get real/evaluation/portrait-lehna.jpg be879ed68c55a5fd0186b1e2eee93643c05840af2a46074297db3465b085ae6d \
  "https://upload.wikimedia.org/wikipedia/commons/a/ae/Lehna_Huie%2C_artist_%2833398617908%29.jpg"
get real/evaluation/portrait-doorway.jpg 47eb4419c469469205bd8d2ace11c8f109e8f613051a3c1e4d36b3a08ccc2085 \
  "https://upload.wikimedia.org/wikipedia/commons/c/ce/Indian_man_standing_in_doorway_%28Unsplash%29.jpg"
get real/evaluation/portrait-hands.jpg 38d23d8857f5f57e56ca2abba17c79901cf64d5ef82c772e784fda3dd3aa4886 \
  "https://upload.wikimedia.org/wikipedia/commons/d/dd/Woman_looking_up_%28Unsplash%29.jpg"
get real/evaluation/portrait-glasses.jpg 971b57395b29ce3fa74f2d1b9b1aef45ad48012ad82d800269575079a96038fc \
  "https://upload.wikimedia.org/wikipedia/commons/0/05/Woman_waiting_near_a_window_%28Unsplash%29.jpg"

# Crossing and occlusion windows from Tears of Steel. The film itself is fetched
# by fetch-real.sh and is not re-downloaded here. Stream-copied, so the written
# duration follows the next keyframe after the requested window.
if [ -f real/source/tears_of_steel_720p.mov ]; then
  verify real/source/tears_of_steel_720p.mov efa9062d9cdb7a338e40ad530dfdf234806743f29ae6a1a136b97ece4e588e8f
  if [ ! -f real/evaluation/tos-crossing.mp4 ]; then
    echo "  real/evaluation/tos-crossing.mp4"
    ffmpeg -nostdin -v error -y -ss 25.75 -i real/source/tears_of_steel_720p.mov -t 8.0 \
      -map 0:v:0 -c copy -avoid_negative_ts make_zero -movflags +faststart \
      real/evaluation/tos-crossing.mp4
  fi
  verify real/evaluation/tos-crossing.mp4 3a4b1af884a69da0da175976901811289eb98d9943da7340b38ee5b9d738f5e9
  if [ ! -f real/evaluation/tos-occlusion.mp4 ]; then
    echo "  real/evaluation/tos-occlusion.mp4"
    ffmpeg -nostdin -v error -y -ss 360.00 -i real/source/tears_of_steel_720p.mov -t 5.5 \
      -map 0:v:0 -c copy -avoid_negative_ts make_zero -movflags +faststart \
      real/evaluation/tos-occlusion.mp4
  fi
  verify real/evaluation/tos-occlusion.mp4 234c796e07ae62c1bca77cc6208dbe1c798d23bb68c22a31deea72e10333f322
else
  echo "  Tears of Steel film not local; run ./tools/style-bench/fetch-real.sh first for the video windows"
fi

ls -la real/evaluation
