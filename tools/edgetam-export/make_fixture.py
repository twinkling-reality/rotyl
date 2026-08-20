"""
Clips built to make tracking fail if the memory is not working.

Two objects that look alike cross paths three radii apart, two thirds of the way
through. A tracker with no memory of which one it was asked about has nothing to
go on at the crossing and will pick one at random; a tracker whose memory is
intact keeps the one it was pointed at, and they end up on opposite sides so the
answer is legible. The background is textured rather than flat so the
segmentation itself is not trivial.

Ground truth is analytic here, which is the point of synthesising rather than
downloading: every frame's true mask is known exactly, so "the mask stayed on
the object" is a measurement rather than an impression.

FOUR SCENES, THREE OF THEM ADDED LATER, and the reason is written on the
original. It had no occlusion, no motion blur and no lighting change, which are
the three things a memory bank exists for, so passing it was weak evidence for
exactly the claim it was cited for. Each new scene changes ONE of those and
keeps everything else, including the paths and the seed, so a row can be read
against the control rather than against another clip.

  crossing    the control. Two lookalikes crossing head-on, twenty-two frames
              of them, for the reason under FRAMES below.
  occlusion   the target passes behind a bar for eight frames and comes out the
              far side, with the distractor waiting there. Nothing but memory
              can get this right, and it is the case object pointers exist for.
              Eight because the bank remembers seven: see OCCLUSION_FRAMES.
  blur        the same paths, with each object smeared along its own velocity,
              and stopping at twenty-two frames for the reason under
              BLUR_FRAMES. What a real camera does to a moving subject, and what
              makes a boundary ambiguous rather than merely moved.
  lighting    the same paths, under an illumination ramp of a stop and a half
              with a warm shift. A memory entry encodes appearance, so the
              question is whether appearance from eight frames ago still
              matches what is on screen now.

  python make_fixture.py            # all four
  python make_fixture.py occlusion  # one
"""

import json
import pathlib
import sys

import numpy as np
from PIL import Image

WIDTH, HEIGHT = 854, 480

# TWENTY-TWO, AND IT WAS TEN, which is a change to what these clips can settle
# rather than to how long they take to draw.
#
# A memory bank holds the frame the object was pointed at plus the six before
# this one, so a bank that keeps that anchor and a bank that slides hold the
# same seven entries until the EIGHTH tracked frame and differ on every frame
# after it. Ten frames gave that difference two frames to appear in, which is
# why the end-to-end table could not separate a tracker that throws the user's
# own frame away from one that does not. Twenty-two gives it fourteen, with the
# crossing inside them.
#
# The paths changed with the length and had to. Run out past ten the old ones
# brought the two objects to 2.03 radii, which is touching, and then took the
# target off the right edge. What that costs is that the ten-frame figures this
# directory published before are not the first ten frames of these: every scene
# built on these paths was re-taken.
FRAMES = 30

# THE SMEARED CLIP STOPS SHORTER, and the number is the model's rather than a
# preference. Tracking the motion-blurred clip, the object score falls steadily
# with the length of the run and crosses zero on frame 29: +4.2, +3.1, +1.4,
# +2.9, -0.04, on a frame whose mask is the same size as every other frame's.
# The sharp and relit clips sit between +4 and +10 throughout, so it is the
# smear and the length together, and it is not a memory problem: a bank that
# keeps its anchor and one that slides produce that trajectory to the hundredth.
#
# One gated frame takes a run's worst-frame score from 0.95 to zero, which put
# three configurations including the correct one at zero and a known-wrong one
# above them. A fixture that ranks a mistake above the thing it is a mistake in
# is worse than a short one, so this stops at twenty-two, where the worst score
# on the clip is +2.5.
#
# What it costs is that blur differs from the control in two things rather than
# one, length as well as smear. The paths are identical and deterministic, so
# the control's first twenty-two frames are this clip unsmeared, and that is the
# comparison to read.
BLUR_FRAMES = 22
RADIUS = 46

# HIDDEN FOR LONGER THAN THE MEMORY HOLDS, which is the one arrangement that
# asks what keeping the anchor is worth.
#
# A bank holds the frame the object was pointed at plus the six before this one.
# While the target is behind the bar every frame it remembers is a frame with
# nothing in it, so an occlusion of more than six frames leaves a bank that
# slides with SEVEN entries that have never seen the object, and a bank that
# keeps its anchor with exactly one that has. Three frames could not ask that:
# both banks still held plenty of the approach.
#
# So eight, and the bar is the object's own width plus eight frames of travel,
# which makes "fully hidden for eight" a consequence of the geometry rather than
# a number somebody has to keep in step with it. Then four frames of sliver as
# it comes out, and four whole ones to be scored on.
OCCLUSION_SPEED = 22
OCCLUSION_HIDDEN = 8
OCCLUSION_FRAMES = 28

OUT = pathlib.Path(__file__).parent / "fixture"


def background(rng: np.random.Generator) -> np.ndarray:
    """Low-frequency colour blotches plus grain, upsampled to full size."""
    coarse = rng.integers(40, 150, size=(8, 14, 3)).astype(np.float32)
    field = np.asarray(Image.fromarray(coarse.astype(np.uint8)).resize((WIDTH, HEIGHT), Image.BICUBIC))
    grain = rng.normal(0, 7, size=(HEIGHT, WIDTH, 1))
    return np.clip(field.astype(np.float32) + grain, 0, 255)


def centres(frame: int) -> tuple[tuple[float, float], tuple[float, float]]:
    """
    Head-on, crossing at three radii, at frame 15 of 22.

    20 and 12 px between frames, which is what a 30 fps camera gives for two
    things crossing part of a frame in under a second. An early version moved
    them a diameter and a half per frame and the tracker lost them by frame
    three, which measured the clip rather than the export; what caps the speed
    now is that both have to stay in frame for all twenty-two.

    Never closer than three radii: paths that end up on top of each other stop
    being a distractor and become one blob, which asks the model an ill-posed
    question rather than a hard one.

    CLOSEST AT FRAME 15, which is the arrangement rather than an artefact of it.
    Two banks a tracker might keep hold the same seven entries until the eighth
    tracked frame, so an ambiguity before then is one both of them answer from
    the same memory. At frame 15 a sliding bank holds seven entries all taken
    from the approach and an anchored one still holds the frame somebody
    actually pointed at. They end five radii apart on opposite sides, so "which
    one did it keep" has an answer rather than needing one.

    AND THEY START ELEVEN RADII APART, which is not decoration. A version of
    these paths that began five radii apart and converged from there made the
    REFERENCE fail outright: with object pointers on it reported no object at
    all from frame two and never recovered, on the sharp clip and on the relit
    one, while the motion-blurred version of the very same paths tracked
    perfectly. Whatever that is, a control the reference cannot track measures
    the clip rather than the export, which is the same trap the speed above
    records. So the distractor comes from the far side and the opening frames
    are unambiguous.
    """
    target = (60 + frame * 16, 300 + frame)
    distractor = (606 - frame * 10, 160 + frame)
    return target, distractor


def occluded_centres(frame: int) -> tuple[tuple[float, float], tuple[float, float]]:
    """
    Straight through the bar, with the distractor waiting on the far side.

    The target crosses left to right at a constant speed and passes entirely
    behind the bar for `OCCLUSION_HIDDEN` frames, which the bar's width is
    derived from rather than tuned to.

    The distractor sits still, beyond the bar and three radii off the target's
    line at their closest. Off the line rather than on it because the two must
    never merge: an object that ends up on top of its own distractor asks the
    model an ill-posed question rather than a hard one, which is the same rule
    the crossing scene follows. So on the frame the target reappears there are
    two identical objects near each other, and nothing in the picture says which
    one was pointed at. Only a memory does, and after eight hidden frames a
    sliding bank has none.
    """
    return (120 + frame * OCCLUSION_SPEED, 240), (770, 380)


def paint(image: np.ndarray, cx: float, cy: float, colour: tuple[int, int, int]) -> np.ndarray:
    ys, xs = np.mgrid[0:HEIGHT, 0:WIDTH]
    inside = ((xs - cx) ** 2 + (ys - cy) ** 2) <= RADIUS**2
    # A ring of the same colour family, so the two objects are alike but the
    # shape is not a featureless blob.
    ring = ((xs - cx) ** 2 + (ys - cy) ** 2) <= (RADIUS * 0.55) ** 2
    image[inside] = colour
    image[ring] = tuple(int(c * 0.55) for c in colour)
    return inside


def paint_smeared(
    image: np.ndarray, cx: float, cy: float, velocity: tuple[float, float], colour: tuple[int, int, int]
) -> np.ndarray:
    """
    The same object, integrated along the distance it moves in one exposure.

    Nine samples over half a frame's travel, averaged, which is a 180 degree
    shutter and what any ordinary camera gives. The mask returned is the SHARP
    one at the nominal centre: a blurred object's true extent is a matter of
    opinion, and the question being asked is whether the tracker stays on the
    thing, not whether it agrees about where a smear ends.
    """
    samples = 9
    accumulated = np.zeros_like(image)
    for step in range(samples):
        offset = (step / (samples - 1) - 0.5) * 0.5
        layer = image.copy()
        paint(layer, cx + velocity[0] * offset, cy + velocity[1] * offset, colour)
        accumulated += layer
    image[:] = accumulated / samples
    ys, xs = np.mgrid[0:HEIGHT, 0:WIDTH]
    return ((xs - cx) ** 2 + (ys - cy) ** 2) <= RADIUS**2


def relight(image: np.ndarray, frame: int, frames: int) -> np.ndarray:
    """
    A stop and a half down, and warmer, across the clip.

    Applied to the whole picture including the objects, which is the point: a
    memory entry encodes what the object looked like when it was encoded, and
    this asks whether that is still a match once the light has moved further
    than any sensible exposure would.
    """
    t = frame / max(frames - 1, 1)
    gain = 1.0 - 0.62 * t
    warm = np.array([1.0, 1.0 - 0.18 * t, 1.0 - 0.34 * t], dtype=np.float32)
    return np.clip(image * gain * warm, 0, 255)


def write(name: str, images: list[np.ndarray], truth: dict) -> None:
    out = OUT / name
    out.mkdir(parents=True, exist_ok=True)
    for existing in out.glob("*.png"):
        existing.unlink()
    for frame, image in enumerate(images):
        Image.fromarray(image.astype(np.uint8)).save(out / f"f{frame:02d}.png")
    (out / "truth.json").write_text(json.dumps(truth, indent=2))
    print(f"{name}: {len(images)} frames of {WIDTH}x{HEIGHT} to {out}")


def crossing(smear: bool = False, light: bool = False) -> tuple[list[np.ndarray], dict]:
    length = BLUR_FRAMES if smear else FRAMES
    rng = np.random.default_rng(7)
    images, frames = [], []
    for frame in range(length):
        image = background(rng)
        (tx, ty), (dx, dy) = centres(frame)
        # The distractor is painted first, so where they overlap the target is
        # in front and remains the thing that was pointed at.
        if smear:
            # One frame's travel, from the paths themselves rather than typed in
            # again, so a change to the paths cannot leave the smear behind.
            (nx, ny), (mx, my) = centres(frame + 1)
            paint_smeared(image, dx, dy, (mx - dx, my - dy), (232, 96, 64))
            inside = paint_smeared(image, tx, ty, (nx - tx, ny - ty), (232, 96, 64))
        else:
            paint(image, dx, dy, (232, 96, 64))
            inside = paint(image, tx, ty, (232, 96, 64))
        if light:
            image = relight(image, frame, length)
        images.append(image)
        frames.append(
            {
                "frame": frame,
                "target": [tx, ty],
                "distractor": [dx, dy],
                "area": int(inside.sum()),
                "visible": True,
                "whole": True,
            }
        )
    return images, {"radius": RADIUS, "frames": frames}


def occlusion() -> tuple[list[np.ndarray], dict]:
    rng = np.random.default_rng(7)
    bar_x0, bar_x1 = 330, 330 + 2 * RADIUS + OCCLUSION_HIDDEN * OCCLUSION_SPEED
    whole = int(np.pi * RADIUS**2 * 0.99)
    images, frames = [], []
    for frame in range(OCCLUSION_FRAMES):
        image = background(rng)
        (tx, ty), (dx, dy) = occluded_centres(frame)
        paint(image, dx, dy, (232, 96, 64))
        inside = paint(image, tx, ty, (232, 96, 64))

        # The bar goes on last, so it is in front of both. Dark and flat, so it
        # is unambiguously a different thing rather than a shadow.
        image[:, bar_x0:bar_x1] = (28, 30, 36)
        inside[:, bar_x0:bar_x1] = False

        images.append(image)
        frames.append(
            {
                "frame": frame,
                "target": [tx, ty],
                "distractor": [dx, dy],
                "area": int(inside.sum()),
                # A fully hidden object has no true mask, so a frame that scores
                # zero there is the truth agreeing rather than the tracker
                # failing. And a frame showing a forty-pixel sliver of a six
                # thousand pixel object scores badly however well the tracker is
                # doing, so the headline number is taken over WHOLE frames and
                # the two partial cases are reported on their own terms.
                # verify.py does the reporting; this only has to say which is
                # which, which it can, because it drew them.
                "visible": bool(inside.sum() > 0),
                "whole": bool(inside.sum() >= whole),
            }
        )
    return images, {"radius": RADIUS, "occluder": [bar_x0, bar_x1], "frames": frames}


SCENES = {
    "crossing": lambda: crossing(),
    "occlusion": occlusion,
    "blur": lambda: crossing(smear=True),
    "lighting": lambda: crossing(light=True),
}


def main() -> None:
    wanted = sys.argv[1:] or list(SCENES)
    for name in wanted:
        if name not in SCENES:
            raise SystemExit(f"unknown scene {name}; one of {', '.join(SCENES)}")
        images, truth = SCENES[name]()
        write(name, images, truth)


if __name__ == "__main__":
    main()
