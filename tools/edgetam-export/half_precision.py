"""Half-precision copies of the three tracking graphs.

Memory attention is the expensive half of tracking and half precision takes it
from 61 ms to 38 ms on WebGPU, with the file going from 69.6 MB to 34.9 MB. See
tools/video-bench/README.md for both numbers and for why the memory encoder is
NOT a safe conversion: its worst output element moves by half the signal, and
that output goes into the bank and conditions every later frame.

THE TRACKED-FRAME DECODER IS, and by a wide margin. Measured against its own
fp32 graph on the conditioned maps of a real clip, every output moves by under
three tenths of a per cent of its own scale: iou_scores 0.27%, pred_masks 0.09%,
object_score_logits 0.06%, object_pointer 0.07%. Over twenty-nine tracked frames
the head the host picks never changed and the present-or-absent gate never
flipped. The output worth worrying about is the pointer, for the same reason the
memory encoder's is: it goes into the bank and conditions every later frame. It
is the one that moves least, by seven hundredths of a per cent against the
encoder's fifty, and it halves the graph from 21.9 MB to 11.1.

All three are written here anyway. Measuring the one you should not ship is how
you know you should not ship it, and the conversion has a trap worth keeping.

    ./venv/bin/python half_precision.py
"""

from __future__ import annotations

import warnings
from pathlib import Path

import onnx
from onnx import TensorProto
from onnxconverter_common import float16

HERE = Path(__file__).parent
GRAPHS = ["memory_attention", "memory_encoder", "tracked_mask_decoder"]


def convert(source: Path, destination: Path) -> int:
    """Convert one graph, and repair the Cast nodes the tracer left behind.

    THE TRAP. Tracing left eight no-op `Cast(to=FLOAT)` nodes in the rotary
    path, where every tensor was already float. The fp16 pass rewrites the
    tensors around them and leaves the attribute alone, so the graph loads with
    `Type parameter (T) of Optype (Mul) bound to different types` from a node
    name that has nothing to do with the cause.

    They are repaired BY NAME, taken from the fp32 graph. The conversion adds
    its own boundary casts to keep the graph's inputs and outputs fp32
    (keep_io_types), and rewriting one of those instead produces a graph whose
    declared output type no longer matches what it emits -- which is the same
    error one step further along.
    """
    original = onnx.load(source)
    tracer_casts = {node.name for node in original.graph.node if node.op_type == "Cast"}

    with warnings.catch_warnings():
        # Warns once per constant too small to survive the conversion. They are
        # all around 1e-8 and all in positional-encoding tables.
        warnings.simplefilter("ignore")
        half = float16.convert_float_to_float16(original, keep_io_types=True)

    repaired = 0
    for node in half.graph.node:
        if node.op_type != "Cast" or node.name not in tracer_casts:
            continue
        for attribute in node.attribute:
            if attribute.name == "to" and attribute.i == TensorProto.FLOAT:
                attribute.i = TensorProto.FLOAT16
                repaired += 1

    onnx.checker.check_model(half)
    onnx.save(half, destination)
    return repaired


def main() -> None:
    for name in GRAPHS:
        source = HERE / "onnx" / f"{name}.onnx"
        if not source.exists():
            raise SystemExit(f"{source} is missing; run export.py first")
        destination = HERE / "onnx" / f"{name}_fp16.onnx"
        repaired = convert(source, destination)
        before = source.stat().st_size / 1e6
        after = destination.stat().st_size / 1e6
        print(f"{name}: {before:.1f} MB -> {after:.1f} MB, {repaired} tracer casts repaired")


if __name__ == "__main__":
    main()
