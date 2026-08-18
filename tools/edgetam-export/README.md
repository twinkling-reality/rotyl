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
./venv/bin/python make_fixture.py       # four clips, analytic ground truth
./venv/bin/python export.py
./venv/bin/python verify.py --sweep     # every clip, with and without pointers
```

`verify.py` alone takes `--scene crossing|occlusion|blur|lighting` and
`--no-pointers` and prints a frame by frame trace, which is what to run when
something is wrong. `--sweep` runs all eight combinations and writes
`results.json`, which is committed and which the research page reads.

`export.py` writes `onnx/memory_encoder.onnx` and `onnx/memory_attention.onnx`,
which are gitignored: they are 139 MB and regenerating them is one command.
Weights come from `yonigozlan/EdgeTAM-hf`, the checkpoint the published ONNX
release was exported from.

**Apache-2.0, checked rather than assumed.** `facebookresearch/EdgeTAM` carries
one `LICENSE`, Apache 2.0, with no `NOTICE` beside it and no acceptable-use
policy, and `checkpoints/edgetam.pt` is inside that repository rather than under
terms of its own. The Hugging Face checkpoint above and the ONNX release the
product fetches at runtime declare the same. Nothing here blocks a public build.
What it does mean is that the two graphs written by this script are a derivative
work: anyone hosting them ships the licence text and the attribution with them,
and says that the files were modified, which they were.

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
is not exposed.

`verify.py --no-pointers` used to report that going without cost nothing, and
said in the same breath that the result was weak because pointers exist for
re-identification after occlusion and the fixture had none. **It has one now,
and the cost is exactly where the warning said.** Without pointers the tracker
misses the frame the object comes back on, produces no mask at all, and picks it
up on the next one. One frame late.

Every average hides that, which is why it is a field in `results.json` rather
than something to notice: worst IoU over whole frames is a shade BETTER without
pointers, because a run that skips the hardest frame is not scored on it. So a
first implementation is still not blocked on re-exporting the decoder, and
re-exporting it buys back the one frame that a person watching a clip would
see.

## The memory bank is fixed-size

A memory entry is 512 tokens of 64 dims after the spatial perceiver, and the
bank holds up to 7 of them plus up to 16 object pointers at 4 tokens each:
7 × 512 + 64 = **3648 tokens, always**.

The reference concatenates only as many entries as it has, so its memory grows
over the first frames of a clip. That would mean a different graph shape per
frame and, on a WebGPU backend, a pipeline recompile with each one. So the bank
is padded to full size and the unused keys are masked out of the
cross-attention instead. Softmax with a masked key is softmax without it, which
`verify.py` checks across the whole ramp-up rather than asserting.

Fixing the size also turns the two integers the reference passes alongside the
memory into constants. They control rotary slicing and cannot be tensors, so a
variable-length bank would have needed a graph per size regardless.

## Size, which is not what the file says, and is now fixed

`memory_attention.onnx` is 69.6 MB and holds 11.8 MB of weights. The rest is
baked rotary tables, four distinct tables repeated across layers and attention
blocks by the tracer. Disabling constant folding does not help: the rotary
module takes no inputs, so tracing captures them whatever the folding setting.

An earlier version of this file estimated that sharing them would give about
24 MB and left it as work for whoever shipped it. `shrink.py` does it, and the
estimate was right: **69.6 MB to 24.0 MB, and 12.0 MB with half precision on
top**, with outputs identical to the bit and no change in run time on WebGPU.

**The obvious pass finds nothing, and that is the whole difficulty.** The tables
are not initializers. The tracer emits them as `Constant` NODES, each carrying
its own copy of the tensor in an attribute, so a sweep over `graph.initializer`
reports no duplication at all: this graph has 54 initializers holding 11.8 MB
and 166 Constant nodes holding 57.7 MB, of which 45.6 MB is copies. Hoist the
constants into initializers first, which changes nothing about what the graph
computes, and then the sharing is four lines.

So tracking's marginal download is 12 MB for attention plus 6.7 for the encoder,
which stays at full precision because half is not a safe conversion for it. Call
it nineteen on top of the twenty already fetched for object selection, against
seventy-six. The sizes and the WebGPU timings are on `/research/tracking.html`,
out of `shrink.json` and `tools/video-bench/results.json`.

## What the fixtures are for

`make_fixture.py` draws four clips over a textured ground, with analytic ground
truth, so "the mask stayed on the object" is a measurement rather than an
impression. The first is the control and the other three each change exactly one
thing about it, which is the only way a row means anything.

**crossing**, the original. Two identical objects on converging paths. A tracker
that has lost its memory has nothing to distinguish them by and will take
whichever is nearer; one whose memory is intact keeps the one it was pointed at.

**occlusion**, which is the one that was missing. The target passes behind a bar
for three frames and comes out the far side, with an identical object waiting
there. The bar is the object's own width plus three frames of travel, so "fully
hidden" follows from the geometry rather than from a number somebody has to keep
in step with it. Nothing in the picture says which object was pointed at on the
frame it reappears.

**blur**, the same paths with each object integrated along its own velocity over
half a frame, which is a 180 degree shutter. The ground truth stays the sharp
circle: a smeared object's extent is a matter of opinion, and the question is
whether the tracker stays on the thing rather than whether it agrees about where
a smear ends.

**lighting**, the same paths under a ramp of a stop and a half with a warm
shift, applied to the whole picture. A memory entry encodes appearance, so this
asks whether appearance from eight frames ago still matches what is on screen.

Nothing takes the wrong object on any of them, and the masks are identical to
the PyTorch reference on every frame of all four, not merely similar. The
numbers are on `/research/tracking.html`, out of `results.json`, along with what
motion blur costs, which is the only one of the three that costs anything.

## What a host has to supply, besides the two graphs

The graphs are the expensive half and they are not the whole of it. A tracked
frame is four sessions and a memory bank, and the parts that are neither are
listed here because rediscovering them costs a day each and every one of them
fails silently.

**Three parameters that are in the checkpoint and in no graph.** All are tiny
and all can be dumped to a few kilobytes beside the weights:

| parameter                       | shape   | what it is for                                 |
| ------------------------------- | ------- | ---------------------------------------------- |
| `no_memory_embedding`           | 1×1×256 | subtract from the encoder's last feature map   |
| `no_memory_positional_encoding` | 1×1×256 | the position that goes with it                 |
| `no_object_pointer`             | 1×256   | what stands in for an object that is not there |

The first is the trap the section below describes. The published vision encoder
ADDS it, which is right for a single image and wrong for a tracked frame, where
memory attention replaces it.

**The vision position embeddings, which are 4 MB and should not be shipped.**
`memory_attention` takes `vision_position_embeddings` at 4096×1×256, one per
cell of the 64×64 feature grid. It comes from `vision_encoder.neck.position_
encoding`, which is sinusoidal and takes no input beyond the grid size, so it is
the same tensor on every frame of every clip. Compute it at load. Shipping it
would add a third of the shared attention graph's whole size for something a
loop can produce in a millisecond.

**A 1024 px mask, where the decoder answers at 256.** `memory_encoder` takes
`mask_for_memory` at 1×1×1024×1024, and the mask decoder's `pred_masks` is
256 px square. The reference feeds it the high-resolution mask, so a host
upsamples by four before encoding a memory. Feeding the 256 px mask into a graph
that declares 1024 is a shape error and will say so; feeding it upsampled by
nearest rather than bilinear will not say anything at all.

**And the arithmetic either side of the encoder, which is deliberately not in
the graph.** A mask from a click is thresholded and a mask from a previous
frame's prediction is passed through a sigmoid, then both are scaled and shifted
by `sigmoid_scale_for_mem_enc` and `sigmoid_bias_for_mem_enc`. `verify.py` does
it in `encode_new_memory` and it is fifteen lines. It is outside the graph so
the graph has one meaning rather than a mode.

**What is still missing is the decoder.** Object pointers need
`object_pointer_proj` applied to a decoder output token that the published
decoder does not expose, so a host that does not re-export the decoder has no
pointers at all, and that costs one frame on every re-entry from an occlusion.
See the measurement above.

## Two things found on the way

The published encoder adds `no_memory_embedding` to its last feature map. That
is correct for a single image and wrong for a tracked frame, where memory
attention replaces it. It is a constant, so a host can subtract it, but it is
silent if missed.

Timing, on the CPU execution provider and therefore not a prediction for
WebGPU: 102 ms to encode a memory, 226 ms to attend against the bank. Memory
attention is the expensive half, and the fixed bank is why. It is 4096 queries
against 3648 keys on every frame, where the reference attends against fewer
early in a clip. Worth measuring on WebGPU before designing around it.
