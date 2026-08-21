# edgetam-export

Produces the three ONNX graphs that video tracking needs and the published
EdgeTAM release does not contain.

**Rotyl fetches these at runtime, from wherever whoever built it put them.**
There is no default host, because the failure mode of a wrong one is nineteen
megabytes fetched and then a 404 at the moment somebody presses Track; a build
sets `VITE_TRACKING_HOST` or there is no Track button. What a host serves is the
two graphs and `parameters.json`, and what it owes anyone it serves them to is
below.

It is the same reason the font subsetting command is written down in the root
README: a binary artefact nobody can regenerate is a liability.

Python, and deliberately so. The reference implementation is PyTorch and the
export has to run against it; a TypeScript reimplementation of a tracker in
order to avoid a directory of Python would be a much worse trade.

## Running it

```bash
python3.12 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python make_fixture.py       # four clips, analytic ground truth
./venv/bin/python export.py             # three graphs
./venv/bin/python half_precision.py     # and the halves two of them ship as
./venv/bin/python parameters.py         # the four tensors no graph carries
./venv/bin/python verify.py --sweep     # every clip, with and without pointers
./venv/bin/python host.py --sweep       # everything that is NOT in a graph
```

`host.py` is the one that checks the product rather than the export, and it is
the subject of [what is not in a graph](#what-is-not-in-a-graph-and-what-that-cost).
It fetches the two published graphs on first use, at the revision
`src/platform/perception/model-store.ts` pins.

`verify.py` alone takes `--scene crossing|occlusion|blur|lighting` and
`--no-pointers` and prints a frame by frame trace, which is what to run when
something is wrong. `--sweep` runs all eight combinations and writes
`results.json`, which is committed and which the research page reads.

`export.py` writes `onnx/memory_encoder.onnx`, `onnx/memory_attention.onnx` and
`onnx/tracked_mask_decoder.onnx`, which are gitignored: they are 161 MB and
regenerating them is one command.
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

**One extra decoder output**, which is what the third graph here exists for.
The published decoder declares `iou_scores`, `pred_masks` and
`object_score_logits`. The memory bank also wants `object_pointer`, the token
carrying an object's identity between frames, and it is not exposed.

`tracked_mask_decoder.onnx` is that decoder re-exported with the pointer on it,
21.8 MB and 11.0 at half precision. It takes NO PROMPT: what a tracked frame
sends is the same two "not a point" embeddings every time, so they are evaluated
once and kept as a buffer, and the graph cannot be handed the nearly-right
prompt the published one accepts. Its three shared outputs match the published
graph to 2e-5 and the reference's own decoder to 4e-5, and its pointer matches
the reference's own projection to 4e-6, over twenty-nine tracked frames.

`verify.py --no-pointers` used to report that going without cost nothing, and
said in the same breath that the result was weak because pointers exist for
re-identification after occlusion and the fixture had none. **It has one now,
and the cost is exactly where the warning said.** Without pointers the tracker
produces no mask at all on the frame the object comes back on and finds it again
later; the figure is `reacquisition_delay` in `results.json` and on
`/research/tracking.html`.

Taking that occlusion from three hidden frames to eight moved both numbers and
not the gap: pointers buy back one frame either way. The frame the object first
shows again is a five per cent sliver, which nothing segments well, so some of
the delay is the fixture rather than the memory.

Every average hides that, which is why it is a field in `results.json` rather
than something to notice: worst IoU over whole frames is a shade BETTER without
pointers, because a run that skips the hardest frame is not scored on it. So a
first implementation is still not blocked on re-exporting the decoder, and
re-exporting it buys back the one frame that a person watching a clip would
see.

## What is not in a graph, and what that cost

`verify.py` proves the two exported graphs are the modules they came from. That
is half of a tracked frame. The other half is host code, and none of it is
checkable by looking at a mask:

- the published vision encoder either side of the subtraction above, and the
  published mask decoder at the end
- four transposes between four sessions, since the encoder answers channel-major
  and attention takes token-major and the decoder wants channel-major again
- the memory bank's layout, its temporal rows, and its key mask
- resampling the decoder's 256 px answer to the 1024 px the memory encoder
  declares, and the sigmoid, scale and bias either side of it
- the prompt a frame with no click sends

`host.py` runs each of those against the reference's own inputs and compares its
answer with the reference's own. **Three of the five were wrong the first time it
was run, and not one of them produced an error.** The tables are on
`/research/the-host.html`, out of `host.json`.

**The mask decoder accepts an empty prompt and gives a different answer from the
reference's.** It accepts empty `input_points` and empty `input_boxes` together,
which nothing had ever sent it, because the object-selection path returns early
when a prompt has neither. It runs. It is out by 1.5 to 4.1 on mask logits and
by up to 0.39 on the object score, which is enough to move a boundary and to
flip whether the object is there at all.

The cause is one line in the reference and it is worth writing down. A prompt
made of points is padded with a trailing "not a point", and the published graph
was traced with `pad=True` baked in, so a graph handed zero points appends one
and produces ONE such token where the reference has two. What a tracked frame
has to send is **one point with a label of -1**, whose coordinates are discarded
and whose embedding is replaced wholesale. With that, the published decoder is
the reference's decoder to 1e-4.

**The mask into the memory encoder is upsampled bilinearly, not nearest.** This
was nearest first, on the reasoning that the reference upsamples a
high-resolution mask it already holds while a host reconstructs a decision. The
reference holds no such mask: `pred_masks_high_res` is
`F.interpolate(low_res_logits, 1024, mode="bilinear")` and nothing else. Nearest
is out by 18.7 on a field the encoder receives in the range −10 to 10, along
every edge of every mask.

**And the bank is not a sliding window.** The reference holds the conditioning
frame plus the six frames before this one, gives the conditioning frame the
OLDEST temporal row whatever else is in the bank, and never drops it: it indexes
`memory_temporal_positional_encoding[relative_temporal_offset - 1]` and a
conditioning frame's offset is zero, so it lands on the last row. Keeping the
most recent seven instead gets the first frame of every run wrong and throws the
seed away on the eighth. Laid out the reference's way, `layOutBank` reproduces
the reference's own bank to the bit, all 233,472 floats of it, on every frame of
every clip.

**Pricing any of this end to end took a change to the clips**, and it was not
the obvious one. Running the whole tracker with and without each mistake used to
put every configuration between 0.91 and 0.99 against the reference with an
ordering that was not consistent between clips, which was the fixtures rather
than the corrections.

Length alone did not fix it. A longer control whose two lookalikes merely
converged and stayed three radii apart moved the sliding bank by nothing at all,
over twenty-two frames of divergence. **An anchored bank is insurance against
the recent frames being wrong**, so pricing it needs a clip carrying a moment
where the tracker could plausibly go wrong; on one where it never does, every
entry in the bank is right and which seven are kept cannot matter.

Rebuilt around that, all four clips carry such a moment and all four separate
every correction, in the right order, which had never happened before. The
control crosses head-on and the two objects end five radii apart on opposite
sides, so afterwards the tracker has to keep the one it was pointed at while the
other leaves. The occlusion hides the target for longer than the bank remembers.
The smeared clip is ambiguous at the boundary throughout, and is the one that
prices the anchor highest. Keeping the anchor is worth between 0.65 and 2.11
points of worst-frame agreement depending on the clip; sending the decoder no
prompt costs up to 17 on the occlusion. The table is on
`/research/the-host.html`.

One row moves on a single clip, and that is the row behaving correctly rather
than the clips failing: the absent gate decides what a frame the object is not
in contributes to the bank, and the occlusion is the only fixture with such
frames.

**One row does separate.** Seeded with the reference's own mask rather than with
the coverage Rotyl's command log holds, this host reproduces the PyTorch tracker
exactly, frame for frame, on all four clips. The coverage round trip is the only
remaining difference, it costs between one and nine points of worst-frame
agreement, and against the fixtures' ground truth it is a shade better rather
than worse, because a slightly eroded seed sits better inside a hard-edged disc.

**What `host.py` also writes is `host-fixture.json`**, which is what
`test/memory-bank.test.ts` drives the TypeScript over: for three frames, the
reference's own values at a few dozen spread indices per stage. Not the tensors,
which are four megabytes each; every stage there is a permutation or an
elementwise map, so a test can set exactly the probed inputs, run the real
function at the real size, and read exactly the probed outputs.

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

**crossing**, the original, thirty frames of it. Two identical objects crossing
head-on, twelve radii apart at the start and three at their closest on frame 21,
ending five apart on opposite sides so that "which one did it keep" has an
answer. A tracker that has lost its memory has nothing to distinguish them by
and will take whichever is nearer; one whose memory is intact keeps the one it
was pointed at.

It was ten frames, and it is thirty because a memory bank holds seven entries:
at ten, a bank that keeps the frame the user pointed at and a bank that slides
differ on two frames out of nine and the clip cannot price the difference. At
thirty they differ on twenty-two, with the crossing inside them, and it can. At
twenty-two frames, which was tried, it cannot: the two banks score the same to
four places, so the last eight frames are doing the work.

**Length was not sufficient on its own**, which is worth more than the row is. A
version of these paths that merely converged and stayed three radii apart moved
the sliding bank by nothing at all, over twenty-two frames of divergence. An
anchored bank is insurance against the recent frames being WRONG, so what a clip
has to carry is a moment where the tracker could plausibly go wrong. Converging
and staying close never produces one. Crossing and then pulling apart on
opposite sides does, because afterwards the tracker has to keep the one it was
pointed at while the other leaves.

**And length was not free**, which is why the smeared clip stops at twenty-two
while these run to thirty. See the blur scene below.

Getting there cost one wrong turn worth recording. A first version of the longer
paths started the two objects five radii apart and converged from there, and
that made the REFERENCE tracker fail outright: with object pointers on it
reported no object at all from frame two and never found it again, on the sharp
clip and on the relit one, while the motion-blurred version of the very same
paths tracked perfectly. A control the reference cannot track measures the clip
rather than the export, so the distractor comes from the far side now and the
opening frames are unambiguous.

**occlusion**, which is the one that was missing, and the one that prices
everything. The target passes behind a bar for eight frames and comes out the
far side, with an identical object waiting there. The bar is the object's own
width plus eight frames of travel, so "fully hidden" follows from the geometry
rather than from a number somebody has to keep in step with it. Nothing in the
picture says which object was pointed at on the frame it reappears.

**Eight because the bank remembers seven.** It was three, and three is fewer
than the six tracked frames a bank keeps beside its anchor, so a sliding bank
still held plenty of the approach and the anchor bought nothing measurable. At
eight, every entry a sliding bank holds is a frame with nothing in it. It is the
sharpest of the two clips that can price the host's mistakes, and the only one
that starves the memory outright rather than merely testing it.

**And it is now the only one of the four that also leaves this directory.**
`e2e/fixtures/occlusion.mp4` is these twenty-eight frames encoded, with
`truth.json` copied beside it, so the product's own end-to-end suite can open
the clip, track through it and check the frames the model called absent against
the geometry drawn here rather than against another run of itself. What that
cost, and the ladder of encodes it was measured over, is in
`e2e/fixtures/README.md`. One number out of it belongs here: every encode from
2.1 MB down to 89 KB reports the object absent on all eight frames the bar
covers and misses none, so the eight frames are not delicate. What is delicate
is coming back afterwards, which two encodes in the middle of that ladder never
do.

**blur**, the same paths with each object integrated along its own velocity over
half a frame, which is a 180 degree shutter. The ground truth stays the sharp
circle: a smeared object's extent is a matter of opinion, and the question is
whether the tracker stays on the thing rather than whether it agrees about where
a smear ends.

**It stops at twenty-two frames where the others run to thirty**, and the number
is the model's rather than a preference. On the smeared clip the object score
falls with the length of the run and crosses zero on frame 29: +4.2, +3.1, +1.4,
+2.9, -0.04, on a frame whose mask is the same size as every other frame's. The
sharp and relit clips sit between +4 and +10 throughout, so it is the smear and
the length together, and it is not a memory problem: a bank that keeps its
anchor and one that slides produce that trajectory to the hundredth. One gated
frame takes a run's worst-frame score from 0.95 to zero, which put three
configurations including the correct one at zero and a known-wrong one above
them, and a fixture that ranks a mistake above the thing it is a mistake in is
worse than a short one. At twenty-two the worst score on the clip is +2.5.

What that costs is that this scene differs from the control in two things rather
than one. The paths are identical and deterministic, so the control's first
twenty-two frames are this clip unsmeared, and that is the comparison to read.

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

**Four parameters that are in the checkpoint and in no graph.** All are tiny,
and `parameters.py` writes all four to `onnx/parameters.json` along with the
constants below, so a host serves one small file beside the graphs:

| parameter                             | shape    | what it is for                                 |
| ------------------------------------- | -------- | ---------------------------------------------- |
| `no_memory_embedding`                 | 1×1×256  | subtract from the encoder's last feature map   |
| `no_memory_positional_encoding`       | 1×1×256  | the position that goes with it                 |
| `no_object_pointer`                   | 1×256    | what stands in for an object that is not there |
| `memory_temporal_positional_encoding` | 7×1×1×64 | how long ago an entry in the bank is from      |

**And the decoder has to be the re-export, which the product now asks rather
than assumes.** It is the third graph a host serves and the only one with a
plausible substitute: every EdgeTAM release contains a mask decoder, and serving
that one is the obvious mistake. It is missing both of the outputs a tracked
frame needs. `object_pointer` fails on the first frame, loudly, because the
product reads it the way it reads everything else. `object_score_logits` used to
fail into nothing at all: the product fell back to the best head's predicted
IoU, which is a different quantity compared against the same zero and is
essentially always positive, so the tracker ran, and reported the object present
on every frame of every clip including the ones it is behind something on.
`loadEdgeTamTracker` now asks the session for its output names and refuses a
graph without either, naming which one is missing.

The first parameter above is the trap the section below describes. The published vision encoder
ADDS it, which is right for a single image and wrong for a tracked frame, where
memory attention replaces it.

**The fourth was missing from this list until somebody went to write the host**,
which is the omission this file exists to prevent, so it is worth saying what it
does. `memory_attention` takes `memory_position_embeddings` as an input, and
what belongs there is not what `memory_encoder` returned. The encoder gives the
SPATIAL position of each token; the reference then adds one of these seven rows
to it, chosen by how many frames back that entry is, which is what orders the
bank in time. Leave it out and every entry claims to be from the same moment. It
is 448 floats, and all four of these are nonzero in this checkpoint, so none of
them is a placeholder a host could skip.

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
by `sigmoid_scale_for_mem_enc` and `sigmoid_bias_for_mem_enc`, which are 20.0
and -10.0 here and belong to the config rather than to anyone's memory. `verify.py` does
it in `encode_new_memory` and it is fifteen lines. It is outside the graph so
the graph has one meaning rather than a mode.

**The decoder is no longer missing.** Object pointers need
`object_pointer_proj` applied to a decoder output token the published decoder
does not expose, so `export.py` writes a third graph that does. A host that
serves only the two memory graphs still works and still has no pointers, which
is what the pointer rows in `host.json` price.

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
