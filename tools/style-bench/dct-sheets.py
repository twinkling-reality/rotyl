#!/usr/bin/env python3
"""Contact sheets and face crops for the DCT comparison.

Inputs are already on disk under out/evaluation. Nothing here re-runs a model.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out" / "evaluation"
SHEETS = OUT / "sheets"
CROPS = OUT / "crops"

SHEET_CASES = [
    "portrait-close",
    "portrait-glasses",
    "portrait-somali",
    "portrait-lehna",
    "portrait-doorway",
    "portrait-hands",
    "tos-crossing-mid",
    "tos-occlusion-mid",
]

CROPS_SPEC = {
    "somali": ("portrait-somali", (0.28, 0.12, 0.72, 0.62)),
    "lehna": ("portrait-lehna", (0.30, 0.14, 0.70, 0.58)),
    "hands": ("portrait-hands", (0.28, 0.22, 0.72, 0.72)),
    "occlusion-mid": ("tos-occlusion-mid", (0.48, 0.08, 0.86, 0.78)),
    "crossing-mid": ("tos-crossing-mid", (0.22, 0.18, 0.62, 0.72)),
}

VARIANTS = (
    ("source", "source"),
    ("anime", "anime"),
    ("dct-bg", "dct-bg"),
    ("dct-hybrid", "dct-hybrid"),
    ("dct-official", "dct-official"),
)


def read_rgb(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(path)
    return image


def letterbox(image: np.ndarray, width: int, height: int) -> np.ndarray:
    scale = min(width / image.shape[1], height / image.shape[0])
    resized = cv2.resize(
        image,
        (max(1, int(round(image.shape[1] * scale))), max(1, int(round(image.shape[0] * scale)))),
        interpolation=cv2.INTER_AREA,
    )
    canvas = np.full((height, width, 3), 40, dtype=np.uint8)
    x = (width - resized.shape[1]) // 2
    y = (height - resized.shape[0]) // 2
    canvas[y : y + resized.shape[0], x : x + resized.shape[1]] = resized
    return canvas


def hstack_labelled(tiles: list[tuple[str, np.ndarray]], height: int = 720) -> np.ndarray:
    width = max(1, int(round(height * tiles[0][1].shape[1] / tiles[0][1].shape[0])))
    gutter = 6
    label_h = 36
    panel_w = width
    panel_h = height + label_h
    sheet = np.full((panel_h, panel_w * len(tiles) + gutter * (len(tiles) - 1), 3), 30, dtype=np.uint8)
    for index, (label, image) in enumerate(tiles):
        x = index * (panel_w + gutter)
        fitted = letterbox(image, width, height)
        sheet[label_h : label_h + height, x : x + panel_w] = fitted
        cv2.putText(
            sheet,
            label,
            (x + 10, 26),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (230, 230, 230),
            1,
            cv2.LINE_AA,
        )
    return sheet


def crop_frac(image: np.ndarray, box: tuple[float, float, float, float]) -> np.ndarray:
    x0, y0, x1, y1 = box
    h, w = image.shape[:2]
    return image[int(h * y0) : int(h * y1), int(w * x0) : int(w * x1)]


def write_sheets() -> None:
    SHEETS.mkdir(parents=True, exist_ok=True)
    CROPS.mkdir(parents=True, exist_ok=True)
    for name in SHEET_CASES:
        tiles: list[tuple[str, np.ndarray]] = []
        missing = []
        for label, suffix in VARIANTS:
            path = OUT / f"{name}-{suffix}.png"
            if path.exists():
                tiles.append((label, read_rgb(path)))
            else:
                missing.append(suffix)
        if len(tiles) < 2:
            print(f"skip {name}: missing {missing}")
            continue
        sheet = hstack_labelled(tiles)
        path = SHEETS / f"{name}-source-anime-dct-official.jpg"
        cv2.imwrite(str(path), sheet, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        print(path.name, "x".join(map(str, sheet.shape[1::-1])), f"missing={missing or 'none'}")

    for crop_name, (case, box) in CROPS_SPEC.items():
        for suffix in ("source", "anime", "dct-bg", "dct-hybrid", "dct-official"):
            path = OUT / f"{case}-{suffix}.png"
            if not path.exists():
                continue
            crop = crop_frac(read_rgb(path), box)
            if crop.size == 0:
                continue
            out = CROPS / f"{crop_name}-{suffix}-face.png"
            cv2.imwrite(str(out), crop)
            print(out.name, "x".join(map(str, crop.shape[1::-1])))


if __name__ == "__main__":
    write_sheets()
