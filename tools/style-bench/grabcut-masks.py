#!/usr/bin/env python3
"""GrabCut person masks for selective-composite evidence.

This is a labelled substitute for EdgeTAM. The product selection path is
EdgeTAM plus the command log. GrabCut is here because this VM's WebGPU is
SwiftShader, and a missing EdgeTAM mask would leave the compositor untested.
Every file this script writes should be read as "a person-shaped coverage
ramp", not as the product mask.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out" / "evaluation"
MASKS = OUT / "masks"

# Fractions of the 1200-long-edge evaluation stills already on disk.
CASES = {
    "portrait-somali": (0.08, 0.03, 0.96, 0.995),
    "portrait-lehna": (0.14, 0.07, 0.88, 0.995),
    "portrait-hands": (0.14, 0.16, 0.88, 0.995),
    "tos-occlusion-mid": (0.40, 0.02, 0.93, 0.995),
}


def grabcut(image: np.ndarray, box: tuple[float, float, float, float]) -> np.ndarray:
    h, w = image.shape[:2]
    x0, y0, x1, y1 = box
    rect = (
        int(w * x0),
        int(h * y0),
        max(1, int(w * (x1 - x0))),
        max(1, int(h * (y1 - y0))),
    )
    mask = np.zeros((h, w), np.uint8)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(image, mask, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
    sure = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    sure = cv2.morphologyEx(sure, cv2.MORPH_CLOSE, kernel)
    filled = sure.copy()
    cv2.floodFill(filled, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 255)
    holes = cv2.bitwise_not(filled)
    sure = cv2.bitwise_or(sure, holes)
    sure = cv2.GaussianBlur(sure, (0, 0), 3.0)
    return sure


def overlay(image: np.ndarray, coverage: np.ndarray) -> np.ndarray:
    tint = image.astype(np.float32)
    tint[:, :, 2] = np.minimum(255, tint[:, :, 2] + coverage.astype(np.float32) * 0.45)
    return np.clip(tint, 0, 255).astype(np.uint8)


def main() -> None:
    MASKS.mkdir(parents=True, exist_ok=True)
    for name, box in CASES.items():
        source = OUT / f"{name}-source.png"
        image = cv2.imread(str(source), cv2.IMREAD_COLOR)
        if image is None:
            raise FileNotFoundError(source)
        coverage = grabcut(image, box)
        cv2.imwrite(str(MASKS / f"{name}.png"), coverage)
        cv2.imwrite(str(MASKS / f"{name}-overlay.png"), overlay(image, coverage))
        selected = float(np.count_nonzero(coverage > 16)) / coverage.size
        print(f"{name} {image.shape[1]}x{image.shape[0]} selected={selected:.3f}")


if __name__ == "__main__":
    main()
