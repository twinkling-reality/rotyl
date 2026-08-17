# edgetam-export

Produces the two ONNX graphs that video tracking needs and the published EdgeTAM
release does not contain.

**Nothing in Rotyl uses these yet.** No video pipeline exists. This is here
because it settled the question of whether one could be built, and because when
one is, these graphs are a build input rather than something to rediscover. It
is the same reason the font subsetting command is written down in the root
README: a binary artefact nobody can regenerate is a liability.

Python, and deliberately so. The reference implementation is PyTorch and the
export has to run against it; a TypeScript reimplementation of a tracker in
order to avoid a directory of Python would be a much worse trade.

## Running it

```bash
python3.12 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python make_fixture.py
./venv/bin/python export.py
./venv/bin/python verify.py
```

`export.py` writes `onnx/memory_encoder.onnx` and `onnx/memory_attention.onnx`,
which are gitignored: they are 139 MB and regenerating them is one command.
Weights come from `yonigozlan/EdgeTAM-hf`, the checkpoint the published ONNX
release was exported from.

## What was missing, and what still is

`onnx-community/EdgeTAM-ONNX` ships a vision encoder and a
prompt-encoder/mask-decoder pair. That answers "what is under this click" and
has nothing to say about "where did it go". Three things stand between it and
tracking:

**The memory encoder**, 6.7 MB. A frame's features plus its mask in, one memory
entry out. Exports unchanged.

**The memory attention**, which conditions the next frame's features on the
bank. Exports unchanged, but see the size note below.

**One extra decoder output.** The published decoder declares `iou_scores`,
`pred_masks` and `object_score_logits`. The memory bank also wants
`object_pointer`, the token carrying an object's identity between frames, and it
is not exposed. `verify.py --no-pointers` measures what going without costs: on
the fixture, nothing — worst IoU 0.982 against 0.949 with them. That is a weak
result and should not be leaned on, because pointers exist for
re-identification after occlusion and over long sequences and the fixture has
neither. It establishes only that a first implementation is not blocked on
re-exporting the decoder.

## The memory bank is fixed-size

A memory entry is 512 tokens of 64 dims after the spatial perceiver, and the
bank holds up to 7 of them plus up to 16 object pointers at 4 tokens each:
7 × 512 + 64 = **3648 tokens, always**.

The reference concatenates only as many entries as it has, so its memory grows
over the first frames of a clip. That would mean a different graph shape per
frame and, on a WebGPU backend, a pipeline recompile with each one. So the bank
is padded to full size and the unused keys are masked out of the
cross-attention instead — softmax with a masked key is softmax without it, which
`verify.py` checks across the whole ramp-up rather than asserting.

Fixing the size also turns the two integers the reference passes alongside the
memory into constants. They control rotary slicing and cannot be tensors, so a
variable-length bank would have needed a graph per size regardless.

## Size, which is not what the file says

`memory_attention.onnx` is 69.6 MB and holds 11.8 MB of weights. The rest is
baked rotary tables — four distinct tables totalling 12.1 MB, repeated across
layers and attention blocks by the tracer. Disabling constant folding does not
help: the rotary module takes no inputs, so tracing captures them whatever the
folding setting.

|                                             | size    |
| ------------------------------------------- | ------- |
| as exported, fp32                           | 69.6 MB |
| duplicate tables shared                     | ~24 MB  |
| fp16                                        | ~12 MB  |
| tables computed at load rather than shipped | ~6 MB   |

So video's marginal download is single-digit megabytes on top of the 20 MB
already fetched for object selection, not seventy. Deduplicating the
initializers, or making the tables graph inputs, is work for whoever ships it.

## What the fixture is for

`make_fixture.py` draws ten frames of two identical objects on converging paths
over a textured ground. A tracker that has lost its memory has nothing to
distinguish them by and will take whichever is nearer; one whose memory is
intact keeps the object it was pointed at. Ground truth is analytic, so "the
mask stayed on the object" is a measurement rather than an impression.

Measured, on a click on frame 0 with no further input:

|                              | worst IoU vs truth | swapped to the distractor |
| ---------------------------- | ------------------ | ------------------------- |
| PyTorch reference            | 0.949              | never                     |
| these graphs on ONNX Runtime | 0.949              | never                     |

The masks are identical, not merely similar: IoU 1.000 against the PyTorch run
on every frame.

## Two things found on the way

The published encoder adds `no_memory_embedding` to its last feature map. That
is correct for a single image and wrong for a tracked frame, where memory
attention replaces it. It is a constant, so a host can subtract it, but it is
silent if missed.

Timing, on the CPU execution provider and therefore not a prediction for
WebGPU: 102 ms to encode a memory, 226 ms to attend against the bank. Memory
attention is the expensive half, and the fixed bank is why — it is 4096 queries
against 3648 keys on every frame, where the reference attends against fewer
early in a clip. Worth measuring on WebGPU before designing around it.
