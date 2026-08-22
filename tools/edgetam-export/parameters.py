"""
The four parameters a tracker needs that live in the checkpoint and in no graph.

`export.py` writes the three graphs. This writes everything else the project
release has to carry beside them, which is four tensors and a handful of
constants out of the config. None of it is large and all of it fails silently
when it is missing, which is the whole reason it is a checked file rather than a
paragraph.

    ./venv/bin/python parameters.py

Writes `onnx/parameters.json`, which is gitignored like the graphs and is
regenerated in a second, and refreshes the committed fixture the TypeScript
tests check their own position encoding against.
"""

import json
import pathlib

import torch
from transformers import EdgeTamVideoModel

CHECKPOINT = "yonigozlan/EdgeTAM-hf"
CHECKPOINT_REVISION = "c266ce53b3fc00f0f495b583f6a116c4e57f53bb"
HERE = pathlib.Path(__file__).parent
OUT = HERE / "onnx"
FIXTURE = HERE / "position-encoding.json"

# Where the vision position encoding is sampled for the fixture. Spread rather
# than contiguous: a wrong axis order, a wrong sin/cos interleave and a wrong
# normalisation all agree with each other somewhere, and none of them agrees
# everywhere.
SAMPLES = [0, 1, 63, 64, 127, 255, 1000, 2048, 4095]
CHANNELS = [0, 1, 2, 63, 64, 127, 128, 129, 255]


def main() -> None:
    OUT.mkdir(exist_ok=True)
    model = EdgeTamVideoModel.from_pretrained(
        CHECKPOINT, revision=CHECKPOINT_REVISION, dtype=torch.float32
    ).eval()

    parameters = {
        name: getattr(model, name).detach().flatten().tolist()
        for name in (
            "no_memory_embedding",
            "no_memory_positional_encoding",
            "no_object_pointer",
            "memory_temporal_positional_encoding",
        )
    }

    config = model.config
    written = {
        "parameters": parameters,
        # Read out of the checkpoint rather than typed in, for the same reason
        # the tensors are: a host that guesses one of these is wrong quietly.
        "constants": {
            "num_maskmem": model.num_maskmem,
            "hidden_dim": model.hidden_dim,
            "mem_dim": model.mem_dim,
            "sigmoid_scale_for_mem_enc": config.sigmoid_scale_for_mem_enc,
            "sigmoid_bias_for_mem_enc": config.sigmoid_bias_for_mem_enc,
            "feature_size": list(model.backbone_feature_sizes[-1]),
        },
        # What a host needs to rebuild the 4 MB of vision position encoding it
        # should not be sent. See the fixture below for the check on that.
        "vision_position_encoding": {
            "num_position_features": model.vision_encoder.neck.position_encoding.num_position_features,
            "temperature": model.vision_encoder.neck.position_encoding.temperature,
            "normalize": model.vision_encoder.neck.position_encoding.normalize,
            "scale": model.vision_encoder.neck.position_encoding.scale,
        },
    }
    (OUT / "parameters.json").write_text(json.dumps(written) + "\n")
    print(f"  onnx/parameters.json: {sum(len(v) for v in parameters.values())} floats")

    # The position encoding itself, at a few points, so a reimplementation of it
    # in another language is checked against this one rather than against its
    # author's reading of the formula.
    height, width = model.backbone_feature_sizes[-1]
    encoding = model.vision_encoder.neck.position_encoding(
        torch.Size([1, model.hidden_dim, height, width]), "cpu", torch.float32
    )
    # NxCxHxW to HWxNxC, which is the layout memory attention takes.
    flat = encoding.flatten(2).permute(2, 0, 1).squeeze(1)
    FIXTURE.write_text(
        json.dumps(
            {
                "size": [height, width],
                "channels": model.hidden_dim,
                "tokens": SAMPLES,
                "at": CHANNELS,
                "values": [[round(float(flat[t][c]), 6) for c in CHANNELS] for t in SAMPLES],
            },
            indent=2,
        )
        + "\n"
    )
    print(f"  position-encoding.json: {len(SAMPLES)}x{len(CHANNELS)} samples")


if __name__ == "__main__":
    main()
