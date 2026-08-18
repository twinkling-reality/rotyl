"""Share the initializers the tracer duplicated, and say what it was worth.

`memory_attention.onnx` is 69.6 MB and holds 11.8 MB of weights. Almost all of
the rest is rotary tables: the rotary module takes no inputs, so tracing
captures its output as a constant, and it does that once per layer and once per
attention block. Disabling constant folding does not help, because the tables
are not folded, they are traced.

WHERE THEY ACTUALLY ARE IS THE POINT. They are not initializers. The tracer
emits them as `Constant` NODES, each carrying its own copy of the tensor in an
attribute, which is why the obvious pass over `graph.initializer` finds nothing
to share: this graph has 54 initializers holding 11.8 MB and 166 Constant nodes
holding 57.7 MB.

So there are two steps. Hoist every Constant node into an initializer, which
changes nothing about what the graph computes and is what an initializer is for.
Then share the ones whose bytes are identical, rewiring every node that
referenced a copy to the survivor. `--verify` runs both graphs on the same
inputs and compares, because "nothing about the computation changes" is a claim
rather than an observation.

    ./venv/bin/python shrink.py
    ./venv/bin/python shrink.py --verify    # slower, and the point

Writes `onnx/<name>_shared.onnx` beside the originals, and `shrink.json`, which
is committed and which the research page reads.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

HERE = Path(__file__).parent
ONNX = HERE / "onnx"
GRAPHS = ["memory_attention", "memory_encoder"]


def digest(tensor: onnx.TensorProto) -> str:
    """
    What makes two initializers the same initializer.

    The bytes, and the shape and dtype alongside them, because two tensors of
    the same bytes and different shapes are different tensors and merging them
    would produce a graph that loads and computes something else.
    """
    array = numpy_helper.to_array(tensor)
    return hashlib.sha256(
        array.tobytes() + str(array.dtype).encode() + str(array.shape).encode()
    ).hexdigest()


def hoist(graph: onnx.GraphProto) -> int:
    """
    Turn Constant nodes into initializers, which is what they are.

    Only `value`, which carries a TensorProto. The other Constant attributes
    (`value_float`, `value_ints` and the rest) hold scalars and short lists, are
    not where any of the bytes are, and would each need their own conversion.
    """
    hoisted = []
    kept = []
    for node in graph.node:
        tensor = next(
            (a.t for a in node.attribute if a.name == "value"), None
        ) if node.op_type == "Constant" else None
        if tensor is None or len(node.output) != 1:
            kept.append(node)
            continue
        copy = onnx.TensorProto()
        copy.CopyFrom(tensor)
        copy.name = node.output[0]
        hoisted.append(copy)

    del graph.node[:]
    graph.node.extend(kept)
    graph.initializer.extend(hoisted)
    return len(hoisted)


def share(model: onnx.ModelProto) -> dict:
    graph = model.graph
    hoisted = hoist(graph)
    groups: dict[str, list[str]] = defaultdict(list)
    for tensor in graph.initializer:
        groups[digest(tensor)].append(tensor.name)

    # Which name survives, and what every other name becomes.
    rename: dict[str, str] = {}
    duplicated_bytes = 0
    sizes = {tensor.name: numpy_helper.to_array(tensor).nbytes for tensor in graph.initializer}
    for names in groups.values():
        keeper = names[0]
        for other in names[1:]:
            rename[other] = keeper
            duplicated_bytes += sizes[other]

    for node in graph.node:
        for index, name in enumerate(node.input):
            if name in rename:
                node.input[index] = rename[name]

    kept = [tensor for tensor in graph.initializer if tensor.name not in rename]
    del graph.initializer[:]
    graph.initializer.extend(kept)

    return {
        "hoisted_constants": hoisted,
        "initializers": len(sizes),
        "distinct": len(groups),
        "removed": len(rename),
        "duplicated_bytes": duplicated_bytes,
    }


def check(before: Path, after: Path) -> float:
    """Run both, on the same inputs, and return the worst absolute difference."""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.log_severity_level = 3
    original = ort.InferenceSession(str(before), options, providers=["CPUExecutionProvider"])
    shared = ort.InferenceSession(str(after), options, providers=["CPUExecutionProvider"])

    rng = np.random.default_rng(11)
    feed = {}
    for tensor in original.get_inputs():
        # Every dimension of these two graphs is fixed by design; the bank is
        # padded rather than grown, which is the decision the README is about.
        shape = [d if isinstance(d, int) else 1 for d in tensor.shape]
        feed[tensor.name] = rng.standard_normal(shape).astype(np.float32)

    worst = 0.0
    for a, b in zip(original.run(None, feed), shared.run(None, feed)):
        worst = max(worst, float(np.abs(a - b).max()))
    return worst


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true", help="run both graphs and compare the outputs")
    parser.add_argument("--fp16", action="store_true", help="also convert the shared graph to half precision")
    arguments = parser.parse_args()

    out: dict = {}
    for name in GRAPHS:
        source = ONNX / f"{name}.onnx"
        if not source.exists():
            raise SystemExit(f"no {source}; run export.py first")
        destination = ONNX / f"{name}_shared.onnx"

        model = onnx.load(source)
        counts = share(model)
        onnx.save(model, destination)

        row = {
            **counts,
            "bytes": source.stat().st_size,
            "shared_bytes": destination.stat().st_size,
        }
        fp16 = ONNX / f"{name}_fp16.onnx"
        if fp16.exists():
            row["fp16_bytes"] = fp16.stat().st_size
        if arguments.fp16:
            # The same conversion the fp16 graphs get, on top of the sharing, so
            # the two savings can be read together rather than assumed to
            # compose. They do, and the file says by how much.
            from half_precision import convert

            both = ONNX / f"{name}_shared_fp16.onnx"
            convert(destination, both)
            row["shared_fp16_bytes"] = both.stat().st_size
        if arguments.verify:
            row["worst_abs_diff"] = check(source, destination)
        out[name] = row

        print(
            f"{name}: {row['bytes'] / 1e6:.1f} MB -> {row['shared_bytes'] / 1e6:.1f} MB, "
            f"{counts['hoisted_constants']} constants hoisted, "
            f"{counts['removed']} of {counts['initializers']} were copies"
            + (f", worst difference {row['worst_abs_diff']:.1e}" if arguments.verify else "")
        )

    results = HERE / "shrink.json"
    results.write_text(json.dumps(out, indent=2) + "\n")
    print(f"\nwritten to {results}")


if __name__ == "__main__":
    main()
