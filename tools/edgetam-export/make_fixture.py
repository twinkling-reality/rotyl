"""
A clip built to make tracking fail if the memory is not working.

Two objects that look alike cross paths in the middle of the sequence. A
tracker with no memory of which one it was asked about has nothing to go on at
the crossing and will pick one at random; a tracker whose memory is intact
keeps the one it was pointed at. The background is textured rather than flat so
the segmentation itself is not trivial.

Ground truth is analytic here, which is the point of synthesising rather than
downloading: every frame's true mask is known exactly, so "the mask stayed on
the object" is a measurement rather than an impression.
"""

import json
import pathlib

import numpy as np
from PIL import Image

WIDTH, HEIGHT = 854, 480
FRAMES = 10
RADIUS = 46

OUT = pathlib.Path(__file__).parent / "fixture"


def background(rng: np.random.Generator) -> np.ndarray:
    """Low-frequency colour blotches plus grain, upsampled to full size."""
    coarse = rng.integers(40, 150, size=(8, 14, 3)).astype(np.float32)
    field = np.asarray(Image.fromarray(coarse.astype(np.uint8)).resize((WIDTH, HEIGHT), Image.BICUBIC))
    grain = rng.normal(0, 7, size=(HEIGHT, WIDTH, 1))
    return np.clip(field.astype(np.float32) + grain, 0, 255)


def centres(frame: int) -> tuple[tuple[float, float], tuple[float, float]]:
    """
    Converging paths at a plausible speed.

    Roughly 25 px between frames, which is what a 30 fps camera gives for
    something crossing the frame in a few seconds. The first version moved the
    objects a diameter and a half per frame and the tracker lost them by frame
    three, which measured the clip rather than the export.

    Converging, but never closer than about three radii: paths that end up on
    top of each other stop being a distractor and become one blob, which asks
    the model an ill-posed question rather than a hard one.
    """
    target = (200 + frame * 26, 200 + frame * 6)
    distractor = (640 - frame * 12, 340 + frame * 2)
    return target, distractor


def paint(image: np.ndarray, cx: float, cy: float, colour: tuple[int, int, int]) -> np.ndarray:
    ys, xs = np.mgrid[0:HEIGHT, 0:WIDTH]
    inside = ((xs - cx) ** 2 + (ys - cy) ** 2) <= RADIUS**2
    # A ring of the same colour family, so the two objects are alike but the
    # shape is not a featureless blob.
    ring = (((xs - cx) ** 2 + (ys - cy) ** 2) <= (RADIUS * 0.55) ** 2)
    image[inside] = colour
    image[ring] = tuple(int(c * 0.55) for c in colour)
    return inside


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for existing in OUT.glob("*.png"):
        existing.unlink()

    rng = np.random.default_rng(7)
    truth = []
    for frame in range(FRAMES):
        image = background(rng)
        (tx, ty), (dx, dy) = centres(frame)
        # The distractor is painted first, so where they overlap the target is
        # in front and remains the thing that was pointed at.
        paint(image, dx, dy, (232, 96, 64))
        inside = paint(image, tx, ty, (232, 96, 64))

        Image.fromarray(image.astype(np.uint8)).save(OUT / f"f{frame:02d}.png")
        truth.append({"frame": frame, "target": [tx, ty], "distractor": [dx, dy], "area": int(inside.sum())})

    (OUT / "truth.json").write_text(json.dumps({"radius": RADIUS, "frames": truth}, indent=2))
    print(f"wrote {FRAMES} frames of {WIDTH}x{HEIGHT} to {OUT}")


if __name__ == "__main__":
    main()
