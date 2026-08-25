#!/usr/bin/env python3
"""Official DCT-Net anime graphs on Rotyl's evaluation stills.

Downloads are the ModelScope files, hashed in evaluation-set / the decision log.
This script does not convert or relicense them. It runs the published frozen
graphs with TensorFlow CPU so the look can be compared with the shader chain
on the same photographs.

Two head alignments are available:

- ``haar``: OpenCV frontal box + resize. Fast enough to judge the head look.
  Not the published path.
- ``official``: FaceAna 68-point landmarks, pupil-refined 5-point warp, and
  the published 288 head graph, from the DCT-Net checkout. That is the path
  the paper and ``source/cartoonize.py`` describe.

The background graph is the official full-image pass (short edge 720, pad to
16) in both modes.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")

import cv2
import numpy as np
import tensorflow as tf

tf.compat.v1.disable_eager_execution()

ROOT = Path(__file__).resolve().parent
DCT = ROOT / "real" / "dct"
EVAL = ROOT / "real" / "evaluation"
OUT = ROOT / "out" / "evaluation"
SHEETS = OUT / "sheets"
DCT_NET = Path("/tmp/DCT-Net")

CASES = [
    "portrait-close",
    "portrait-glasses",
    "portrait-somali",
    "portrait-lehna",
    "portrait-doorway",
    "portrait-hands",
    "tos-crossing-mid",
    "tos-occlusion-mid",
]


def resize_size(image: np.ndarray, size: int = 720) -> np.ndarray:
    h, w, _ = image.shape
    if min(h, w) > size:
        if h > w:
            h, w = int(size * h / w), size
        else:
            h, w = size, int(size * w / h)
        image = cv2.resize(image, (w, h), interpolation=cv2.INTER_AREA)
    return image


def pad_to_16(image: np.ndarray) -> tuple[np.ndarray, int, int]:
    h, w, _ = image.shape
    if h % 16 == 0 and w % 16 == 0:
        return image, h, w
    nh, nw = (h // 16 + 1) * 16, (w // 16 + 1) * 16
    padded = np.ones((nh, nw, 3), np.uint8) * 255
    padded[:h, :w, :] = image
    return padded, h, w


def load_graph(path: Path, name: str) -> tf.compat.v1.Session:
    graph = tf.Graph()
    with graph.as_default():
        sess = tf.compat.v1.Session(graph=graph)
        with tf.io.gfile.GFile(str(path), "rb") as handle:
            definition = tf.compat.v1.GraphDef()
            definition.ParseFromString(handle.read())
        tf.import_graph_def(definition, name=name)
    return sess


def run_bg(sess: tf.compat.v1.Session, bgr: np.ndarray) -> np.ndarray:
    padded, h, w = pad_to_16(bgr)
    out = sess.run(
        sess.graph.get_tensor_by_name("model_bg/output_image:0"),
        feed_dict={"model_bg/input_image:0": padded},
    )
    return out[:h, :w]


def largest_face_box(gray: np.ndarray) -> tuple[int, int, int, int] | None:
    detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80))
    if len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda box: box[2] * box[3])
    return int(x), int(y), int(w), int(h)


def run_head_haar(
    sess: tf.compat.v1.Session,
    bgr: np.ndarray,
    box: tuple[int, int, int, int],
    mask: np.ndarray,
) -> np.ndarray:
    x, y, w, h = box
    pad = int(0.35 * max(w, h))
    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(bgr.shape[1], x + w + pad)
    y1 = min(bgr.shape[0], y + h + pad)
    crop = bgr[y0:y1, x0:x1]
    if crop.size == 0:
        return bgr
    head = cv2.resize(crop, (288, 288), interpolation=cv2.INTER_AREA)
    styled = sess.run(
        sess.graph.get_tensor_by_name("model_head/output_image:0"),
        feed_dict={"model_head/input_image:0": head},
    )
    styled = np.clip(styled, 0, 255).astype(np.uint8)
    placed = cv2.resize(styled, (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR)
    alpha = cv2.resize(mask, (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR)
    alpha = np.expand_dims(alpha.astype(np.float32), 2)
    region = bgr[y0:y1, x0:x1].astype(np.float32)
    blended = alpha * placed.astype(np.float32) + (1.0 - alpha) * region
    out = bgr.copy()
    out[y0:y1, x0:x1] = np.clip(blended, 0, 255).astype(np.uint8)
    return out


def prepare_official_imports() -> None:
    if not DCT_NET.is_dir():
        raise FileNotFoundError(f"DCT-Net checkout missing at {DCT_NET}")
    root = str(DCT_NET)
    if root not in sys.path:
        sys.path.insert(0, root)


def run_head_official(
    facer: object,
    sess: tf.compat.v1.Session,
    rgb: np.ndarray,
    bg_bgr: np.ndarray,
    mask: np.ndarray,
) -> tuple[np.ndarray, int]:
    from source.mtcnn_pytorch.src.align_trans import get_reference_facial_points, warp_and_crop_face
    from source.utils import get_f5p

    img_bgr = rgb[:, :, ::-1]
    facer.reset()
    boxes, landmarks, _ = facer.run(rgb)
    if landmarks is None or len(landmarks) == 0:
        return bg_bgr, 0

    res = bg_bgr.astype(np.float32)
    reference = get_reference_facial_points(default_square=True)
    for landmark in landmarks:
        f5p = get_f5p(landmark, img_bgr)
        head_img, trans_inv = warp_and_crop_face(
            rgb,
            f5p,
            ratio=0.75,
            reference_pts=reference,
            crop_size=(288, 288),
            return_trans_inv=True,
        )
        head_res = sess.run(
            sess.graph.get_tensor_by_name("model_head/output_image:0"),
            feed_dict={"model_head/input_image:0": head_img[:, :, ::-1]},
        )
        head_trans_inv = cv2.warpAffine(
            head_res,
            trans_inv,
            (rgb.shape[1], rgb.shape[0]),
            borderValue=(0, 0, 0),
        )
        mask_trans_inv = cv2.warpAffine(
            mask,
            trans_inv,
            (rgb.shape[1], rgb.shape[0]),
            borderValue=(0, 0, 0),
        )
        mask_trans_inv = np.expand_dims(mask_trans_inv.astype(np.float32), 2)
        res = mask_trans_inv * head_trans_inv + (1.0 - mask_trans_inv) * res
    return np.clip(res, 0, 255).astype(np.uint8), int(len(landmarks))


def load_case(name: str) -> np.ndarray:
    for folder, suffix in ((EVAL, ".jpg"), (EVAL, ".png"), (OUT / "video-frames", ".png")):
        path = folder / f"{name}{suffix}"
        if path.exists():
            image = cv2.imread(str(path), cv2.IMREAD_COLOR)
            if image is None:
                raise RuntimeError(f"failed to read {path}")
            return image
    raise FileNotFoundError(name)


def write_full(name: str, suffix: str, small: np.ndarray, source: np.ndarray) -> Path:
    full = cv2.resize(small, (source.shape[1], source.shape[0]), interpolation=cv2.INTER_AREA)
    path = OUT / f"{name}-{suffix}.png"
    cv2.imwrite(str(path), full)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--align",
        choices=("haar", "official", "both"),
        default="official",
        help="Head alignment. official is the published FaceAna path.",
    )
    parser.add_argument("--cases", nargs="*", default=CASES)
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    SHEETS.mkdir(parents=True, exist_ok=True)
    bg = load_graph(DCT / "cartoon_anime_bg.pb", "model_bg")
    head = load_graph(DCT / "cartoon_anime_h.pb", "model_head")
    mask = cv2.imread(str(DCT / "alpha.jpg"), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        raise RuntimeError("alpha.jpg missing")
    mask = cv2.resize(mask, (288, 288), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0

    facer = None
    if args.align in ("official", "both"):
        prepare_official_imports()
        from source.facelib.facer import FaceAna

        facer = FaceAna(str(DCT))

    for name in args.cases:
        source = load_case(name)
        work = resize_size(source, 720)
        bg_small = run_bg(bg, work)
        write_full(name, "dct-bg", bg_small, source)
        note = []

        if args.align in ("haar", "both"):
            face = largest_face_box(cv2.cvtColor(work, cv2.COLOR_BGR2GRAY))
            hybrid = run_head_haar(head, bg_small, face, mask) if face else bg_small
            write_full(name, "dct-hybrid", hybrid, source)
            note.append(f"haar={'yes' if face else 'no'}")

        if args.align in ("official", "both"):
            rgb = work[:, :, ::-1]
            official, count = run_head_official(facer, head, rgb, bg_small, mask)
            write_full(name, "dct-official", official, source)
            note.append(f"official={count}")

        print(f"{name} {' '.join(note)} {source.shape[1]}x{source.shape[0]}")

    bg.close()
    head.close()


if __name__ == "__main__":
    main()
