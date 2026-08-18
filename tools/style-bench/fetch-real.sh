#!/bin/sh
# The real inputs, fetched by URL and pinned by hash. Needs curl and ffmpeg.
#
# WHY THIS EXISTS. Every temporal and cost number in this project was taken
# against make-scene.mjs, and the README next door says plainly that it is not a
# photograph: "Real footage has texture statistics no procedure here reproduces,
# and the anisotropic Kuwahara's cost in particular depends on content." The
# headline finding, that no style amplifies its input, is the whole argument for
# why per-frame stylisation is acceptable at all, and it had never been checked
# against a picture a camera took.
#
# WHY FETCHING RATHER THAN A CAVEAT. Real footage cannot be committed, so there
# were two honest ways to take this number: fetch a known clip by URL and hash,
# or publish the result with a note saying the input is unavailable. The second
# is worse than it sounds. The measurement it applies to is the one the whole
# design rests on, and a number nobody can re-take is a number nobody can
# contradict. So it is fetched.
#
# Pinning is by SHA-256 of the file as downloaded, checked before anything is
# derived from it. That leaves one failure mode the synthetic scene does not
# have, a URL that stops resolving, and removes the one that matters: if the
# bytes at the far end change, this refuses to run rather than quietly measuring
# a different picture. A stale hash is a loud failure. A stale input is not.
#
# The film is 372 MB and is kept after the cuts are taken, so that choosing a
# different shot is a local decision rather than another download. Delete
# real/source when you are done with it.
#
#   ./tools/style-bench/fetch-real.sh
#   node tools/style-bench/run.mjs real-chain real-clips real-perturbation
#
# LICENCES. The photographs are CC0 and carry no obligation. The film is
# CC-BY 3.0, so its authors are named here and in the README; nothing fetched by
# this script is redistributed by this project, and none of it is committed.
set -eu
cd "$(dirname "$0")"
mkdir -p real/source

# name|sha256|url
#
# Four photographs, chosen for the statistics the chain is sensitive to rather
# than for looking like anything. Between them they cover the two ends of the
# axis the Kuwahara's cost actually depends on, and the case the palette exists
# for:
#
#   facade    strong directional structure, near monochrome, high contrast.
#             The high-anisotropy end, and a picture with no hue to keep.
#   foliage   fine, isotropic, saturated. The low-anisotropy end.
#   fog       hazy distance, large flat regions, hard architectural edges, thin
#             road markings. What make-scene.mjs was drawn to imitate, taken by
#             a camera instead.
#   portrait  skin, and large out-of-focus areas. Smooth gradients are where a
#             quantiser boils, and skin is what nobody forgives being wrong.
PHOTOGRAPHS="facade|7b6c0eca84d003bb632123baebce3d96faabc7d515e898641e2f8a942a5f7320|https://upload.wikimedia.org/wikipedia/commons/b/b5/House_facade_in_%C3%8Ele_d%27Orl%C3%A9ans%2C_Quebec_city%2C_Quebec%2C_Canada202204-23.jpg
foliage|bf0c4cb0a559967fc1b41dd286074d30607ebfd87308213ed721926c13ddd269|https://upload.wikimedia.org/wikipedia/commons/f/f8/Redbud%2C_Forest-Pansy%2C_Cercis-canadensis_IMG_7211.jpg
fog|eda3d823ce19c5b66557c86139c76abc7c19a657795c0952d5ebd4356cc53987|https://upload.wikimedia.org/wikipedia/commons/1/19/St_Peter%27s_Church%2C_Brighton_in_fog_2024-12-24.jpg
portrait|643d6477faf515340c758e140e0851247a4b02bffd7e899a8e1ab02c6638fb7b|https://upload.wikimedia.org/wikipedia/commons/4/4a/Photographer_in_close-up_%28Unsplash%29.jpg"

FILM_SHA=efa9062d9cdb7a338e40ad530dfdf234806743f29ae6a1a136b97ece4e588e8f
FILM_URL=https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov

verify() {
  have=$(shasum -a 256 "$1" | cut -d' ' -f1)
  if [ "$have" != "$2" ]; then
    echo "  $1: expected $2"
    echo "  $1: got      $have"
    echo "  The bytes at the far end are not the bytes this measurement was taken against."
    exit 1
  fi
}

get() { # file sha url
  if [ -f "$1" ]; then
    verify "$1" "$2"
    echo "  $1 (cached)"
    return
  fi
  echo "  $1"
  curl -fsS -L --retry 3 -H 'User-Agent: rotyl-style-bench (research)' -o "$1.part" "$3"
  mv "$1.part" "$1"
  verify "$1" "$2"
}

# Split on whitespace, which is safe because no field here contains any. A
# `read` loop would put every fetch in a subshell, where a failed hash check
# would exit the subshell and let the script carry on regardless.
echo "photographs, CC0, from Wikimedia Commons"
for entry in $PHOTOGRAPHS; do
  name=${entry%%|*}
  rest=${entry#*|}
  get "real/$name.jpg" "${rest%%|*}" "${rest#*|}"
done

echo "Tears of Steel, CC-BY 3.0, (CC) Blender Foundation, mango.blender.org"
get real/source/tears_of_steel_720p.mov "$FILM_SHA" "$FILM_URL"

# TWO SHOTS, STREAM COPIED. Not re-encoded, deliberately: what is being measured
# is what a style does to real codec noise, and putting an x264 generation
# between the film and the measurement would replace the noise being asked about
# with this machine's. The cuts start on a keyframe, which the film has every
# 0.75 s, so a copy is exact rather than approximate.
#
# Both are the quietest real shots in the film, found by scanning every frame of
# it for the window whose worst consecutive-frame difference is smallest. Neither
# is locked off. That is the point of measurement 2 below: the fixed camera the
# synthetic clip provides does not exist in footage, so the amplification ratio
# has to carry the argument rather than the absolute difference.
echo "cuts"
cut() { # name start seconds
  echo "  real/$1.mp4"
  ffmpeg -nostdin -v error -y -ss "$2" -i real/source/tears_of_steel_720p.mov -t "$3" \
    -map 0:v:0 -c copy -avoid_negative_ts make_zero -movflags +faststart "real/$1.mp4"
}
# Amsterdam, exterior daylight, two actors on a canal bridge. Brick, foliage,
# water, skin and a hazy distance in one frame, which is the mix the synthetic
# scene was drawn to have.
cut tos-bridge 25.75 2.0
# Interior, practical lamp against a papered wall. Large smooth gradients and
# almost no motion, which is the case a quantiser is most likely to boil on. One
# second, because a camera move starts at 1.05.
cut tos-interior 172.791667 1.0

# STATIC CLIPS FROM THE PHOTOGRAPHS, on exactly the recipe make-clips.sh uses for
# the synthetic scene. That is the whole value of them: one variable changes
# between this table and the existing one, the picture, and everything else
# including the grain, the encoder, the rate and the keyframe interval is held.
# The film cannot do that, and these cannot carry real sensor noise. Between them
# the two say whether the finding survives.
echo "static clips, one variable changed from the synthetic scene"
common="-c:v libx264 -profile:v high -preset medium -crf 18 -pix_fmt yuv420p \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -movflags +faststart"
for entry in $PHOTOGRAPHS; do
  name=${entry%%|*}
  echo "  real/static-$name-720p.mp4"
  # Cropped to 16:9 before scaling rather than stretched into it. A photograph
  # stretched to another aspect has different anisotropy in x and y, and
  # anisotropy is exactly what the expensive stage's cost depends on.
  # shellcheck disable=SC2086
  ffmpeg -nostdin -v error -y -loop 1 -i "real/$name.jpg" -t 2 -r 30 \
    -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,noise=alls=4:allf=t,format=yuv420p" \
    $common -g 30 "real/static-$name-720p.mp4"
done

ls -la real real/source
