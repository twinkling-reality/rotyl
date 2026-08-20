"""
The host, checked against the reference rather than against its author.

`verify.py` proves the two exported graphs are the modules they came from. This
proves everything else a tracked frame is: the two PUBLISHED graphs either side
of them, the transposes between the four sessions, the layout of the memory
bank, and the arithmetic the memory encoder is fed. None of that is in a graph.
All of it is host code. Every one of them fails by producing a plausible mask of
roughly the right object rather than by producing an error, which is why looking
at a mask and deciding it seems right settles nothing.

    ./venv/bin/python host.py                 # crossing, the stage table
    ./venv/bin/python host.py --scene occlusion
    ./venv/bin/python host.py --sweep         # every scene, written to host.json
    ./venv/bin/python host.py --fixtures      # the probes the Node test drives

The published vision encoder and mask decoder are fetched on first use, at the
revision `src/platform/perception/model-store.ts` pins, so what is measured here
is the graph the product actually runs and not whatever is on `main` today.

WHAT IT COMPARES AGAINST. The reference, with object pointers turned off. The
published decoder does not expose `object_pointer`, so the product has none; a
reference that had them would fold the cost of that trade, which is measured on
its own in `verify.py`, into every row here.
"""

import argparse
import json
import pathlib

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image
from transformers import (
    AutoProcessor,
    AutoVideoProcessor,
    EdgeTamVideoInferenceSession,
    EdgeTamVideoModel,
)

HERE = pathlib.Path(__file__).parent
ONNX = HERE / "onnx"
FIXTURE = HERE / "fixture"

CHECKPOINT = "yonigozlan/EdgeTAM-hf"
# The same repository and the same commit `model-store.ts` fetches at runtime.
PUBLISHED = "onnx-community/EdgeTAM-ONNX"
REVISION = "9c77c7bff7fd0f3079585fa17af7f730ddc531ed"

FEATURE = 64
TOKENS = FEATURE * FEATURE
CHANNELS = 256
MASK_SIZE = 256
MEMORY_MASK = 1024
TOKENS_PER_MEMORY = 512
MEMORY_ENTRIES = 7
MEMORY_DIM = 64
POINTER_TOKENS = 64
POINTER_SPLITS = 4
MAX_POINTERS = POINTER_TOKENS // POINTER_SPLITS
POINTER_DIM = POINTER_SPLITS * MEMORY_DIM
POINTER_START = MEMORY_ENTRIES * TOKENS_PER_MEMORY
MEMORY_TOKENS = MEMORY_ENTRIES * TOKENS_PER_MEMORY + POINTER_TOKENS
MASKED = -1e4
DECIDED_LOGIT = 2.0
# The reference's placeholder for a frame the object is not in.
NO_OBJECT = -1024.0

SCENES = ["crossing", "occlusion", "blur", "lighting"]


# --- the arithmetic, transcribed from the TypeScript ------------------------
#
# Deliberately a transcription rather than an implementation. What is being
# checked is whether `src/core/perception/memory-bank.ts` and
# `src/platform/perception/edgetam-tracker.ts` say the same thing as the
# reference, so anything clever here would be checking something else.


def vision_position_encoding(width, height, channels, temperature=10000.0):
    features = channels // 2
    scale = 2 * np.pi
    out = np.zeros(width * height * channels, np.float32)
    freq = [temperature ** ((2 * (i // 2)) / features) for i in range(features)]
    for y in range(height):
        down = ((y + 1) / (height + 1e-6)) * scale
        for x in range(width):
            across = ((x + 1) / (width + 1e-6)) * scale
            token = (y * width + x) * channels
            for i in range(0, features, 2):
                out[token + i] = np.sin(down / freq[i])
                out[token + i + 1] = np.cos(down / freq[i + 1])
                out[token + features + i] = np.sin(across / freq[i])
                out[token + features + i + 1] = np.cos(across / freq[i + 1])
    return out


def to_token_major(features, no_memory):
    """`rawTokens`: (1,256,64,64) with the no-memory embedding taken back off."""
    grid = features.reshape(CHANNELS, TOKENS) - np.asarray(no_memory).reshape(CHANNELS, 1)
    return np.ascontiguousarray(grid.T).reshape(-1)


def to_channel_major(tokens):
    """`toChannelMajor`: (4096,256) back to (1,256,64,64) for the mask decoder."""
    return np.ascontiguousarray(tokens.reshape(TOKENS, CHANNELS).T).reshape(-1)


def lay_out_bank(anchor, recent, temporal, anchored=True, pointers=()):
    """
    `layOutBank`. `anchored=False` is the sliding window this had first, kept so
    the table below can say what keeping the seed frame is worth.
    """
    memory = np.zeros(MEMORY_TOKENS * MEMORY_DIM, np.float32)
    positions = np.zeros(MEMORY_TOKENS * MEMORY_DIM, np.float32)
    key_mask = np.full(MEMORY_TOKENS, MASKED, np.float32)

    if anchored:
        held = [(anchor, MEMORY_ENTRIES - 1)] + [
            (entry, len(recent) - 1 - i) for i, entry in enumerate(recent)
        ]
    else:
        window = ([anchor] + list(recent))[-MEMORY_ENTRIES:]
        held = [(entry, len(window) - 1 - i) for i, entry in enumerate(window)]

    for slot, (entry, age) in enumerate(held):
        at = slot * TOKENS_PER_MEMORY * MEMORY_DIM
        span = TOKENS_PER_MEMORY * MEMORY_DIM
        memory[at : at + span] = entry[0]
        row = min(age, MEMORY_ENTRIES - 1) * MEMORY_DIM
        block = entry[1].reshape(TOKENS_PER_MEMORY, MEMORY_DIM) + temporal[row : row + MEMORY_DIM]
        positions[at : at + span] = block.reshape(-1)
        key_mask[slot * TOKENS_PER_MEMORY : (slot + 1) * TOKENS_PER_MEMORY] = 0.0

    # The pointer block, at the end where `num_k_exclude_rope` looks for it.
    # Four tokens per pointer, no position at all, and order-invariant because
    # of both; laid out in the reference's order so the comparison is exact.
    for index, pointer in enumerate(list(pointers)[:MAX_POINTERS]):
        at = (POINTER_START + index * POINTER_SPLITS) * MEMORY_DIM
        memory[at : at + POINTER_DIM] = np.asarray(pointer, np.float32).reshape(-1)[:POINTER_DIM]
        key_mask[
            POINTER_START + index * POINTER_SPLITS : POINTER_START + (index + 1) * POINTER_SPLITS
        ] = 0.0
    return memory, positions, key_mask


def mask_for_memory(logits, from_prompt, scale, bias):
    # Clipped only to keep numpy quiet: a frame the object is not in arrives as
    # -1024 and exp(1024) overflows to a warning on the way to the zero it was
    # always going to give. Sigmoid is 0 and 1 to double precision well inside
    # this, so no value here differs from what the TypeScript computes, which
    # gets the same answer from Math.exp returning Infinity.
    decided = (
        (logits > 0).astype(np.float32)
        if from_prompt
        else 1 / (1 + np.exp(-np.clip(logits, -80, 80)))
    )
    return decided * scale + bias


def at_memory_resolution(field, bilinear=True):
    """
    `atMemoryResolution`: the 256 px field the decoder answered at, at the
    1024 px the memory encoder declares.

    Bilinear because that is what the reference does. It has no
    higher-resolution mask of its own to feed the encoder either: its
    `pred_masks_high_res` is exactly this interpolation of exactly these logits.
    """
    source = torch.from_numpy(np.asarray(field, np.float32).reshape(1, 1, MASK_SIZE, MASK_SIZE))
    if bilinear:
        out = torch.nn.functional.interpolate(
            source, size=(MEMORY_MASK, MEMORY_MASK), mode="bilinear", align_corners=False
        )
    else:
        out = torch.nn.functional.interpolate(source, scale_factor=4, mode="nearest")
    return out.numpy().reshape(-1)


def coverage_from(logits):
    """`coverageFrom`: logits to the 8-bit coverage the command log holds."""
    t = np.clip(np.asarray(logits, np.float32) / DECIDED_LOGIT, 0, 1)
    return np.round(255 * t * t * (3 - 2 * t)).astype(np.uint8)


def seed_logits(coverage):
    """`seedLogits`: a seed's coverage read back as the logits the rest works in."""
    return ((coverage.astype(np.float32) - 127.5) / 127.5).astype(np.float32)


# --- the sessions -----------------------------------------------------------


def published(name):
    """The published graph, fetched once at the revision the product pins."""
    local = ONNX / name
    if not local.exists():
        from huggingface_hub import hf_hub_download

        for part in (name, f"{name}_data"):
            try:
                path = hf_hub_download(PUBLISHED, f"onnx/{part}", revision=REVISION)
            except Exception as error:  # noqa: BLE001 - the message is the useful half
                raise SystemExit(f"could not fetch {part} from {PUBLISHED}: {error}") from error
            (ONNX / part).write_bytes(pathlib.Path(path).read_bytes())
    return local


def session(path):
    options = ort.SessionOptions()
    options.log_severity_level = 3
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def empty_prompt(padding_point):
    """
    What a tracked frame sends the mask decoder instead of a click.

    ONE POINT WITH LABEL -1, not none at all, and the difference is the whole
    reason this file exists. The reference pads a prompt of points with a
    trailing "not a point" and the published graph was traced with that padding
    baked in, so a graph handed zero points produces ONE such token where the
    reference produces two. It answers, it answers plausibly, and it answers
    differently. The coordinates are discarded: a label of -1 replaces the
    embedding wholesale.
    """
    if padding_point:
        return np.zeros((1, 1, 1, 2), np.float32), -np.ones((1, 1, 1), np.int64)
    return np.zeros((1, 1, 0, 2), np.float32), np.zeros((1, 1, 0), np.int64)


class Host:
    """The four sessions and the bank, driven as `edgetam-tracker.ts` drives them."""

    def __init__(self, graphs, parameters, positions, **flags):
        self.encoder, self.decoder, self.attention, self.memory, self.tracked, self.tracked_half = graphs
        self.no_memory = np.array(parameters["parameters"]["no_memory_embedding"], np.float32)
        self.no_object_pointer = np.array(parameters["parameters"]["no_object_pointer"], np.float32).reshape(-1)
        self.temporal = np.array(
            parameters["parameters"]["memory_temporal_positional_encoding"], np.float32
        )
        self.scale = parameters["constants"]["sigmoid_scale_for_mem_enc"]
        self.bias = parameters["constants"]["sigmoid_bias_for_mem_enc"]
        self.positions = positions.reshape(TOKENS, 1, CHANNELS)
        self.flags = flags
        self.anchor = None
        self.recent = []
        self.anchor_pointer = None
        self.recent_pointers = []

    def read(self, pixel_values):
        e0, e1, e2 = self.encoder.run(None, {"pixel_values": pixel_values})
        return e0, e1, e2, to_token_major(e2, self.no_memory)

    def decode(self, e0, e1, top, points, labels):
        """The published decoder, which a click still goes through."""
        iou, masks, obj = self.decoder.run(
            None,
            {
                "image_embeddings.0": e0,
                "image_embeddings.1": e1,
                "image_embeddings.2": top.reshape(1, CHANNELS, FEATURE, FEATURE),
                "input_points": points,
                "input_labels": labels,
                "input_boxes": np.zeros((1, 0, 4), np.float32),
            },
        )
        best = int(np.argmax(iou.reshape(-1)))
        return masks.reshape(3, MASK_SIZE * MASK_SIZE)[best].copy(), float(obj.reshape(-1)[0])

    def decode_tracked(self, e0, e1, top):
        """
        The re-exported decoder, which takes no prompt and gives up the pointer.

        Half precision by default, because that is what ships; `decoder_fp16`
        off runs the full-precision graph so the table can say what the halving
        costs rather than assuming it costs nothing.
        """
        session = self.tracked_half if self.flags["decoder_fp16"] else self.tracked
        iou, masks, obj, pointer = session.run(
            None,
            {
                "image_embeddings.0": e0,
                "image_embeddings.1": e1,
                "image_embeddings.2": top.reshape(1, CHANNELS, FEATURE, FEATURE),
            },
        )
        best = int(np.argmax(iou.reshape(-1)))
        return (
            masks.reshape(3, MASK_SIZE * MASK_SIZE)[best].copy(),
            float(obj.reshape(-1)[0]),
            pointer.reshape(3, POINTER_DIM)[best].copy(),
        )

    def remember(self, raw, logits, from_prompt):
        field = at_memory_resolution(logits, self.flags["bilinear"])
        features, positions = self.memory.run(
            None,
            {
                "vision_features": to_channel_major(raw).reshape(1, CHANNELS, FEATURE, FEATURE),
                "mask_for_memory": mask_for_memory(
                    field, from_prompt, self.scale, self.bias
                ).reshape(1, 1, MEMORY_MASK, MEMORY_MASK),
            },
        )
        return features.reshape(-1), positions.reshape(-1)

    def begin(self, pixel_values, point):
        e0, e1, e2, raw = self.read(pixel_values)
        logits, _ = self.decode(
            e0, e1, e2, np.array([[[point]]], np.float32), np.ones((1, 1, 1), np.int64)
        )
        # Through the coverage the command log holds, which is what a seed
        # really is by the time a run starts: the user has clicked, chosen
        # between the three readings of that click, and possibly brushed.
        if self.flags["seed_round_trip"]:
            logits = seed_logits(coverage_from(logits))
        self.anchor = self.remember(raw, logits, True)
        return logits

    def advance(self, pixel_values):
        e0, e1, _, raw = self.read(pixel_values)
        pointers = (
            [self.anchor_pointer, *reversed(self.recent_pointers)]
            if self.anchor_pointer is not None
            else []
        )
        memory, positions, key_mask = lay_out_bank(
            self.anchor, self.recent, self.temporal, self.flags["anchored"], pointers
        )
        (conditioned,) = self.attention.run(
            None,
            {
                "vision_features": raw.reshape(TOKENS, 1, CHANNELS),
                "vision_position_embeddings": self.positions,
                "memory": memory.reshape(MEMORY_TOKENS, 1, MEMORY_DIM),
                "memory_position_embeddings": positions.reshape(MEMORY_TOKENS, 1, MEMORY_DIM),
                "key_mask": key_mask.reshape(1, 1, 1, MEMORY_TOKENS),
            },
        )
        top = to_channel_major(conditioned)
        if self.flags["pointers"]:
            logits, obj, pointer = self.decode_tracked(e0, e1, top)
        else:
            points, labels = empty_prompt(self.flags["padding_point"])
            logits, obj = self.decode(e0, e1, top, points, labels)
            pointer = None
        # What goes into the bank is a hard choice about whether the object is
        # there at all, which is the reference's, not a count of pixels.
        remembered = np.where(obj > 0, logits, NO_OBJECT).astype(np.float32) if self.flags["gate"] else logits
        self.recent.append(self.remember(raw, remembered, False))
        del self.recent[: max(0, len(self.recent) - (MEMORY_ENTRIES - 1))]

        if pointer is not None:
            # What the object IS, rather than where it was. A frame it is not in
            # contributes the checkpoint's stand-in, which is the reference's
            # blend written as the choice it is.
            held = pointer if obj > 0 else self.no_object_pointer
            if self.anchor_pointer is None:
                self.anchor_pointer = held
            else:
                self.recent_pointers.append(held)
                del self.recent_pointers[: max(0, len(self.recent_pointers) - (MAX_POINTERS - 1))]
        return logits, obj


# --- the reference ----------------------------------------------------------


class Reference:
    """One scene through the PyTorch tracker, with everything it hands a graph kept."""

    def __init__(self, scene, pointers=True):
        folder = FIXTURE / scene
        self.truth = json.loads((folder / "truth.json").read_text())
        images = [Image.open(p).convert("RGB") for p in sorted(folder.glob("f*.png"))]
        if not images:
            raise SystemExit(f"no {scene} fixture; run make_fixture.py first")
        self.height, self.width = np.asarray(images[0]).shape[:2]

        processor = AutoVideoProcessor.from_pretrained(CHECKPOINT)
        full_processor = AutoProcessor.from_pretrained(CHECKPOINT)
        self.video = processor(videos=[images], return_tensors="pt")["pixel_values_videos"][0]

        model = EdgeTamVideoModel.from_pretrained(CHECKPOINT, dtype=torch.float32).eval()
        # The reference keeps its object pointers, because the product has them
        # now. `pointers=False` is how a run asks what going without costs, and
        # it is what every figure here was taken against before the mask decoder
        # was re-exported.
        if not pointers:
            model._get_object_pointers = lambda *a, **k: ([], [], 0)
        self.model = model
        self.processor = processor

        self.vision = {}
        self.entries = {}
        self.encoded = {}
        self.attends = []
        self.decodes = []
        self.frame = 0

        original = model._prepare_vision_features

        def prepare(inference_session, frame_idx, batch_size):
            feats, pos = original(inference_session, frame_idx, batch_size)
            self.frame = frame_idx
            self.vision[frame_idx] = (feats[-1].clone(), pos[-1].clone())
            return feats, pos

        model._prepare_vision_features = prepare
        model.memory_encoder.register_forward_hook(
            lambda m, a, k, o: self.encoded.__setitem__(
                self.frame, {"features": a[0].clone(), "mask": a[1].clone()}
            ),
            with_kwargs=True,
        )
        model.spatial_perceiver.register_forward_hook(
            lambda m, a, k, o: self.entries.__setitem__(
                self.frame, (o[0].detach().numpy().reshape(-1), o[1].detach().numpy().reshape(-1))
            ),
            with_kwargs=True,
        )
        model.memory_attention.register_forward_hook(
            lambda m, a, k, o: self.attends.append(
                {
                    "frame": self.frame,
                    **{n: (v.clone() if torch.is_tensor(v) else v) for n, v in k.items()},
                    "out": o.clone(),
                }
            ),
            with_kwargs=True,
        )
        model.mask_decoder.register_forward_hook(
            lambda m, a, k, o: self.decodes.append(
                {
                    "frame": self.frame,
                    "top": k["image_embeddings"].clone(),
                    "high": [h.clone() for h in k["high_resolution_features"]],
                    "masks": o[0].clone(),
                    "iou": o[1].clone(),
                    "tokens": o[2].clone(),
                    "object": o[3].clone(),
                }
            ),
            with_kwargs=True,
        )

        session = EdgeTamVideoInferenceSession(
            video=self.video, video_height=self.height, video_width=self.width, dtype=torch.float32
        )
        start = self.truth["frames"][0]["target"]
        full_processor.add_inputs_to_inference_session(
            inference_session=session,
            frame_idx=0,
            obj_ids=1,
            input_points=[[[[start[0], start[1]]]]],
            input_labels=[[[1]]],
        )
        self.masks = []
        for output in model.propagate_in_video_iterator(session, start_frame_idx=0):
            self.masks.append(output.pred_masks[0, 0].numpy().copy())
        self.session = session

        # The reference's own projection of the tokens its decoder produced,
        # taken after the run because the propagate loop holds inference-mode
        # tensors that autograd will not accept.
        with torch.no_grad():
            for call in self.decodes:
                call["pointer"] = model.object_pointer_proj(call["tokens"].clone()).numpy()

    @property
    def seed_point(self):
        """The click, in the 1024 px square the model resizes everything to."""
        start = self.truth["frames"][0]["target"]
        return [start[0] * 1024 / self.width, start[1] * 1024 / self.height]

    def pointers_at(self, frame):
        """
        The pointers the reference held on one frame, in the order it held them.

        Its own gathering rather than a reading of its source: the conditioning
        frames it has kept, then the fifteen frames before this one, which is
        what `_get_object_pointers` walks. Read back out of the session it
        filled, so a change to that walk shows up here as a difference rather
        than as agreement with a stale copy of it.
        """
        store = self.session.output_dict_per_obj[0]
        gathered = [
            out["object_pointer"].detach().numpy().reshape(-1)
            for index, out in sorted(store["cond_frame_outputs"].items())
            if index <= frame
        ]
        for offset in range(1, MAX_POINTERS):
            earlier = store["non_cond_frame_outputs"].get(frame - offset)
            if earlier is not None:
                gathered.append(earlier["object_pointer"].detach().numpy().reshape(-1))
        return gathered[:MAX_POINTERS]

    def bank_slots(self, attend):
        """
        Which frame each 512-token block of the reference's bank came from.

        Matched against the entries the memory encoder actually produced rather
        than derived from reading the reference's source, because what the slots
        mean is exactly the thing being checked.
        """
        memory = attend["memory"].detach().numpy().reshape(-1, MEMORY_DIM)
        slots = []
        for start in range(0, memory.shape[0], TOKENS_PER_MEMORY):
            block = memory[start : start + TOKENS_PER_MEMORY].reshape(-1)
            if block.shape[0] < TOKENS_PER_MEMORY * MEMORY_DIM:
                break
            found = None
            for frame, (features, _) in self.entries.items():
                if features.shape == block.shape and np.array_equal(features, block):
                    found = frame
                    break
            slots.append(found)
        return slots


# --- what a stage is worth --------------------------------------------------


def worst(a, b):
    return float(np.abs(np.asarray(a, np.float64) - np.asarray(b, np.float64)).max())


def stages(reference, graphs, parameters, positions):
    """
    Each piece of host arithmetic, fed the reference's own inputs.

    Teacher-forced on purpose. A free-running host diverges a little on every
    frame and then every later stage is being compared against a slightly
    different frame, which turns six sharp answers into one blurred one.
    """
    encoder, decoder, attention, memory, tracked, tracked_half = graphs
    no_memory = np.array(parameters["parameters"]["no_memory_embedding"], np.float32)
    temporal = np.array(parameters["parameters"]["memory_temporal_positional_encoding"], np.float32)
    scale = parameters["constants"]["sigmoid_scale_for_mem_enc"]
    bias = parameters["constants"]["sigmoid_bias_for_mem_enc"]

    rows = {}
    rows["vision position encoding"] = worst(
        positions.reshape(TOKENS, CHANNELS), reference.vision[0][1].numpy().reshape(TOKENS, CHANNELS)
    )

    published_features = {}
    encoder_worst = 0.0
    raw_worst = 0.0
    for frame in sorted(reference.vision):
        e0, e1, e2 = encoder.run(
            None, {"pixel_values": reference.video[frame : frame + 1].numpy()}
        )
        published_features[frame] = (e0, e1, e2)
        top = reference.vision[frame][0].permute(1, 2, 0).reshape(1, CHANNELS, FEATURE, FEATURE)
        encoder_worst = max(
            encoder_worst, worst(e2, top.numpy() + no_memory.reshape(1, CHANNELS, 1, 1))
        )
        raw_worst = max(raw_worst, worst(to_token_major(e2, no_memory), reference.vision[frame][0].numpy().reshape(-1)))
    rows["the published encoder's own no-memory embedding"] = encoder_worst
    rows["the frame's features, token-major, no-memory off"] = raw_worst

    bank_worst = position_worst = 0.0
    slot_trouble = []
    for attend in reference.attends:
        slots = reference.bank_slots(attend)
        if any(slot is None for slot in slots):
            slot_trouble.append((attend["frame"], slots))
            continue
        anchor = reference.entries[slots[0]]
        recent = [reference.entries[slot] for slot in slots[1:]]
        laid, laid_positions, key_mask = lay_out_bank(anchor, recent, temporal)
        # THE SPATIAL PART ONLY. The reference concatenates its pointers onto
        # the end of the same tensor, so comparing the whole of it against a
        # padded bank lines a pointer up against a spatial slot; the pointers
        # get their own row below.
        spatial = len(slots) * TOKENS_PER_MEMORY * MEMORY_DIM
        theirs = attend["memory"].detach().numpy().reshape(-1)[:spatial]
        their_positions = attend["memory_posision_embeddings"].detach().numpy().reshape(-1)[:spatial]
        bank_worst = max(bank_worst, worst(laid[:spatial], theirs))
        position_worst = max(position_worst, worst(laid_positions[:spatial], their_positions))
        open_tokens = int((key_mask == 0).sum())
        if open_tokens != len(slots) * TOKENS_PER_MEMORY:
            slot_trouble.append((attend["frame"], f"{open_tokens} open for {len(slots)} entries"))
    rows["the bank, laid out against the reference's own"] = bank_worst
    rows["the bank's positions, with the temporal row on"] = position_worst

    # THE POINTER BLOCK, which the reference gathers as the conditioning frame's
    # pointer followed by the most recent fifteen, splits four ways and gives no
    # position at all. Every one of those three is silent if it is wrong.
    pointer_worst = pointer_position_worst = 0.0
    pointer_count = 0
    for attend in reference.attends:
        theirs = attend["memory"].detach().numpy().reshape(-1, MEMORY_DIM)
        their_positions = attend["memory_posision_embeddings"].detach().numpy().reshape(-1, MEMORY_DIM)
        spatial = attend["num_spatial_memory_tokens"] * TOKENS_PER_MEMORY
        block = theirs[spatial:]
        gathered = reference.pointers_at(attend["frame"])
        mine = np.zeros_like(block)
        for index, pointer in enumerate(gathered[: block.shape[0] // POINTER_SPLITS]):
            mine[index * POINTER_SPLITS : (index + 1) * POINTER_SPLITS] = pointer.reshape(
                POINTER_SPLITS, MEMORY_DIM
            )
        pointer_count = max(pointer_count, abs(block.shape[0] - len(gathered) * POINTER_SPLITS))
        pointer_worst = max(pointer_worst, worst(mine, block))
        pointer_position_worst = max(pointer_position_worst, float(np.abs(their_positions[spatial:]).max()))
    rows["the pointer block, against the reference's own"] = pointer_worst
    rows["the pointers the reference held, counted"] = float(pointer_count)
    rows["the position the reference gave a pointer"] = pointer_position_worst

    conditioned_worst = 0.0
    for attend in reference.attends:
        slots = reference.bank_slots(attend)
        if any(slot is None for slot in slots):
            continue
        anchor = reference.entries[slots[0]]
        recent = [reference.entries[slot] for slot in slots[1:]]
        laid, laid_positions, key_mask = lay_out_bank(
            anchor, recent, temporal, pointers=reference.pointers_at(attend["frame"])
        )
        (out,) = attention.run(
            None,
            {
                "vision_features": attend["current_vision_features"].detach().numpy(),
                "vision_position_embeddings": attend["current_vision_position_embeddings"]
                .detach()
                .numpy(),
                "memory": laid.reshape(MEMORY_TOKENS, 1, MEMORY_DIM),
                "memory_position_embeddings": laid_positions.reshape(MEMORY_TOKENS, 1, MEMORY_DIM),
                "key_mask": key_mask.reshape(1, 1, 1, MEMORY_TOKENS),
            },
        )
        conditioned_worst = max(conditioned_worst, worst(out, attend["out"].detach().numpy()))
    rows["the conditioned features, off a laid-out bank"] = conditioned_worst

    mask_worst = nearest_worst = 0.0
    for frame, call in reference.encoded.items():
        if frame == 0:
            continue
        low = reference.masks[frame].reshape(-1)
        theirs = call["mask"].detach().numpy().reshape(-1)
        mask_worst = max(
            mask_worst, worst(mask_for_memory(at_memory_resolution(low, True), False, scale, bias), theirs)
        )
        nearest_worst = max(
            nearest_worst,
            worst(mask_for_memory(at_memory_resolution(low, False), False, scale, bias), theirs),
        )
    rows["the mask a memory is encoded from"] = mask_worst
    rows["the same, resampled nearest instead of bilinear"] = nearest_worst

    padded_worst = empty_worst = 0.0
    for call in reference.decodes:
        if call["frame"] == 0:
            continue
        e0, e1, _ = published_features[call["frame"]]
        for padding, keep in ((True, "padded"), (False, "empty")):
            points, labels = empty_prompt(padding)
            iou, masks, obj = decoder.run(
                None,
                {
                    "image_embeddings.0": e0,
                    "image_embeddings.1": e1,
                    "image_embeddings.2": call["top"].detach().numpy(),
                    "input_points": points,
                    "input_labels": labels,
                    "input_boxes": np.zeros((1, 0, 4), np.float32),
                },
            )
            delta = worst(masks, call["masks"].detach().numpy())
            if keep == "padded":
                padded_worst = max(padded_worst, delta)
            else:
                empty_worst = max(empty_worst, delta)
    rows["the published decoder, one point labelled -1"] = padded_worst
    rows["the same, with no prompt tensors at all"] = empty_worst

    # And the re-exported decoder, which is the published one plus the output it
    # does not expose. Checked against the reference's own decoder, and its
    # pointer against the reference's own projection of the same tokens.
    tracked_worst = pointer_output_worst = half_worst = 0.0
    for call in reference.decodes:
        if call["frame"] == 0:
            continue
        e0, e1, _ = published_features[call["frame"]]
        feeds = {
            "image_embeddings.0": e0,
            "image_embeddings.1": e1,
            "image_embeddings.2": call["top"].detach().numpy(),
        }
        _, masks, _, pointer = tracked.run(None, feeds)
        tracked_worst = max(tracked_worst, worst(masks, call["masks"].detach().numpy()))
        pointer_output_worst = max(pointer_output_worst, worst(pointer, call["pointer"]))
        _, half_masks, _, half_pointer = tracked_half.run(None, feeds)
        half_worst = max(half_worst, worst(half_pointer, pointer))
    rows["the re-exported decoder against the reference's"] = tracked_worst
    rows["its object pointer, against the reference's own"] = pointer_output_worst
    rows["what half precision moves that pointer by"] = half_worst

    return rows, slot_trouble


# --- what each difference costs, end to end ---------------------------------

BUILT = dict(
    padding_point=True,
    bilinear=True,
    anchored=True,
    gate=True,
    seed_round_trip=True,
    pointers=True,
    decoder_fp16=True,
)

# WHAT THE PRODUCT COULD ACTUALLY BE, one wrong thing at a time.
#
# `no padding point` is kept although it can no longer differ, and that is the
# point of keeping it. It used to be the largest row here: the published decoder
# accepts an empty prompt and answers differently from the padded one it
# expects, which was worth seventeen points of agreement on the occlusion clip
# and turned a whole visible frame into "no object" on the blurred one. A
# tracked frame now goes through a decoder with no prompt input at all, so the
# flag reaches nothing and the row reads exactly as `as it is built`. A mistake
# that has become unreachable is worth one identical row saying so.
DIFFERENCES = {
    "as it is built": {},
    "no padding point": {"padding_point": False},
    "nearest, not bilinear": {"bilinear": False},
    "a sliding bank, no anchor": {"anchored": False},
    "no absent gate": {"gate": False},
    "the seed as raw logits": {"seed_round_trip": False},
    "no object pointers": {"pointers": False},
    "a full-precision decoder": {"decoder_fp16": False},
}


def agreement(a, b):
    union = np.logical_or(a, b).sum()
    return 1.0 if union == 0 else float(np.logical_and(a, b).sum() / union)


def true_mask(centre, radius, shape):
    ys, xs = np.mgrid[0 : shape[0], 0 : shape[1]]
    return ((xs - centre[0]) ** 2 + (ys - centre[1]) ** 2) <= radius**2


def run_host(reference, graphs, parameters, positions, flags):
    host = Host(graphs, parameters, positions, **{**BUILT, **flags})
    host.begin(reference.video[0:1].numpy(), reference.seed_point)

    agreements, rows = [], []
    for frame in range(1, len(reference.masks)):
        logits, obj = host.advance(reference.video[frame : frame + 1].numpy())
        # Gated, because a gated mask is what the product writes into its log:
        # a decoder told there is nothing there still draws something, and both
        # sides of this comparison have to agree about what that means.
        mine = np.logical_and(logits.reshape(MASK_SIZE, MASK_SIZE) > 0, obj > 0)
        agreements.append(agreement(mine, reference.masks[frame] > 0))

        full = reference.processor.post_process_masks(
            [torch.from_numpy(logits.reshape(1, 1, MASK_SIZE, MASK_SIZE))],
            original_sizes=[[reference.height, reference.width]],
            reshaped_input_sizes=[[1024, 1024]],
            binarize=False,
        )[0]
        mask = (full[0, 0] > 0).numpy() if obj > 0 else np.zeros((reference.height, reference.width), bool)
        record = reference.truth["frames"][frame]
        rows.append(
            {
                "frame": frame,
                "visible": bool(record.get("visible", True)),
                "whole": bool(record.get("whole", True)),
                "target": round(
                    agreement(mask, true_mask(record["target"], reference.truth["radius"], mask.shape))
                    if mask.any() or true_mask(record["target"], reference.truth["radius"], mask.shape).any()
                    else 0.0,
                    4,
                ),
                "distractor": round(
                    float(
                        np.logical_and(
                            mask, true_mask(record["distractor"], reference.truth["radius"], mask.shape)
                        ).sum()
                        / max(
                            1,
                            np.logical_or(
                                mask,
                                true_mask(record["distractor"], reference.truth["radius"], mask.shape),
                            ).sum(),
                        )
                    ),
                    4,
                ),
                "area": int(mask.sum()),
                "present": bool(obj > 0),
            }
        )

    whole = [r for r in rows if r["whole"]]
    return {
        "worst_agreement": round(min(agreements), 4),
        "mean_agreement": round(float(np.mean(agreements)), 4),
        "worst_iou": round(min((r["target"] for r in whole), default=0.0), 4),
        "swapped": [r["frame"] for r in rows if r["visible"] and r["distractor"] > r["target"]],
        "absent": [r["frame"] for r in rows if not r["present"]],
        "frames": rows,
    }


# --- the probes the Node test drives ----------------------------------------

# Spread rather than contiguous, for the reason `parameters.py` gives: a wrong
# axis order, a swapped sine and cosine and a wrong stride all agree with each
# other somewhere and none of them agrees everywhere.
PROBE_TOKENS = [0, 1, 63, 64, 127, 255, 1000, 2048, 4095]
PROBE_CHANNELS = [0, 1, 2, 63, 64, 127, 128, 129, 255]
PROBE_MEMORY_TOKENS = [0, 1, 63, 64, 255, 511]
PROBE_MEMORY_CHANNELS = [0, 1, 31, 32, 62, 63]
# Into one 256-dimensional pointer, spread across all four of the tokens it
# becomes so a split done three ways or in the wrong order disagrees somewhere.
PROBE_POINTER = [0, 1, 63, 64, 127, 128, 191, 192, 255]
PATCH = 8


def r(value):
    """Six decimals, which is four more than any assertion here reads."""
    return round(float(value), 6)


def fixture_frames(reference, graphs, parameters, positions):
    """
    What the reference hands each graph, at a few dozen points per stage.

    NOT THE TENSORS THEMSELVES, which are four megabytes each and would be a
    binary blob nobody could read in a diff. Every stage here is a permutation
    or an elementwise map, so a value at one index depends on the value at one
    other index: a Node test can set exactly the probed inputs, run the real
    function at the real size, and read exactly the probed outputs. Spread over
    both axes, a transposed field disagrees at nearly all of them.
    """
    encoder = graphs[0]
    no_memory = np.array(parameters["parameters"]["no_memory_embedding"], np.float32)

    wanted = [attend["frame"] for attend in reference.attends]
    chosen = [wanted[0], wanted[len(wanted) // 2], wanted[-1]]
    out = []

    for frame in chosen:
        attend = next(a for a in reference.attends if a["frame"] == frame)
        decoded = next(d for d in reference.decodes if d["frame"] == frame)
        _, _, e2 = encoder.run(None, {"pixel_values": reference.video[frame : frame + 1].numpy()})
        encoded = e2.reshape(-1)
        raw = attend["current_vision_features"].detach().numpy().reshape(-1)

        token_major = attend["out"].detach().numpy().reshape(-1)
        channel_major = (
            attend["out"].squeeze(1).transpose(1, 2).reshape(1, CHANNELS, FEATURE, FEATURE)
        ).detach().numpy().reshape(-1)

        slots = reference.bank_slots(attend)
        their_memory = attend["memory"].detach().numpy().reshape(-1)
        their_positions = attend["memory_posision_embeddings"].detach().numpy().reshape(-1)

        low = reference.masks[frame].reshape(MASK_SIZE, MASK_SIZE)
        theirs = reference.encoded[frame]["mask"].detach().numpy().reshape(MEMORY_MASK, MEMORY_MASK)

        out.append(
            {
                "frame": frame,
                # (1,256,64,64) from the published encoder, against the
                # (4096,1,256) the reference hands memory attention.
                "rawTokens": [
                    {
                        "channel": c,
                        "token": t,
                        "encoded": r(encoded[c * TOKENS + t]),
                        "raw": r(raw[t * CHANNELS + c]),
                    }
                    for t in PROBE_TOKENS
                    for c in PROBE_CHANNELS
                ],
                # (1,1,4096,256) back out of attention, against the
                # (1,256,64,64) the reference hands the mask decoder.
                "channelMajor": [
                    {
                        "token": t,
                        "channel": c,
                        "conditioned": r(token_major[t * CHANNELS + c]),
                        "decoded": r(channel_major[c * TOKENS + t]),
                    }
                    for t in PROBE_TOKENS
                    for c in PROBE_CHANNELS
                ],
                "bank": {
                    "slots": slots,
                    "entries": [
                        {
                            "features": [
                                r(reference.entries[slot][0][t * MEMORY_DIM + c])
                                for t in PROBE_MEMORY_TOKENS
                                for c in PROBE_MEMORY_CHANNELS
                            ],
                            "positions": [
                                r(reference.entries[slot][1][t * MEMORY_DIM + c])
                                for t in PROBE_MEMORY_TOKENS
                                for c in PROBE_MEMORY_CHANNELS
                            ],
                        }
                        for slot in slots
                    ],
                    "memory": [
                        r(their_memory[(slot * TOKENS_PER_MEMORY + t) * MEMORY_DIM + c])
                        for slot in range(len(slots))
                        for t in PROBE_MEMORY_TOKENS
                        for c in PROBE_MEMORY_CHANNELS
                    ],
                    "positions": [
                        r(their_positions[(slot * TOKENS_PER_MEMORY + t) * MEMORY_DIM + c])
                        for slot in range(len(slots))
                        for t in PROBE_MEMORY_TOKENS
                        for c in PROBE_MEMORY_CHANNELS
                    ],
                },
                "maskForMemory": mask_patches(low, theirs),
                # THE POINTER BLOCK, source and destination at the same points.
                # `values` is what the reference's decoder produced and `block`
                # is where its own bank put it, so a test that sets one and
                # reads the other is checking the split and the offset against
                # the reference rather than against its own arithmetic.
                "pointers": {
                    "values": [
                        [r(pointer[at]) for at in PROBE_POINTER]
                        for pointer in reference.pointers_at(frame)
                    ],
                    # Read at the reference's OWN offset, which is straight
                    # after its spatial entries rather than at 3584: its bank is
                    # as long as it needs to be and the padded one is not. That
                    # the two hold the same values at different offsets is the
                    # thing being checked.
                    "block": [
                        [
                            r(
                                their_memory[
                                    (
                                        len(slots) * TOKENS_PER_MEMORY
                                        + index * POINTER_SPLITS
                                        + at // MEMORY_DIM
                                    )
                                    * MEMORY_DIM
                                    + at % MEMORY_DIM
                                ]
                            )
                            for at in PROBE_POINTER
                        ]
                        for index in range(len(reference.pointers_at(frame)))
                    ],
                },
            }
        )
    return out


def mask_patches(low, theirs):
    """
    Small windows of the 256 px logits and what the reference made of them.

    Chosen where the mask has an edge, because that is the only place the
    difference between nearest and bilinear exists, and one flat patch either
    side so a test that only ever looked at edges cannot pass by accident.
    """
    inside = low > 4
    edge = np.logical_and(low > -1, low < 1)
    origins = []
    for field in (edge, inside, ~inside):
        ys, xs = np.nonzero(field[: MASK_SIZE - PATCH, : MASK_SIZE - PATCH])
        if ys.size:
            pick = ys.size // 2
            origins.append((int(ys[pick]), int(xs[pick])))
    patches = []
    for sy, sx in origins:
        source = low[sy : sy + PATCH, sx : sx + PATCH]
        # One source pixel of halo either side, so every probed output reads
        # only pixels the patch carries.
        probes = [
            {"y": y, "x": x, "value": r(theirs[y, x])}
            for y in range((sy + 1) * 4, (sy + PATCH - 1) * 4, 5)
            for x in range((sx + 1) * 4, (sx + PATCH - 1) * 4, 5)
        ]
        patches.append(
            {
                "origin": [sy, sx],
                "source": [r(v) for v in source.reshape(-1)],
                "probes": probes,
            }
        )
    return patches


# --- driving it -------------------------------------------------------------


def graphs_and_parameters():
    parameters_path = ONNX / "parameters.json"
    if not parameters_path.exists():
        raise SystemExit("no onnx/parameters.json; run parameters.py first")
    for name in ("memory_attention.onnx", "memory_encoder.onnx"):
        if not (ONNX / name).exists():
            raise SystemExit(f"no onnx/{name}; run export.py first")
    for name in ("tracked_mask_decoder.onnx", "tracked_mask_decoder_fp16.onnx"):
        if not (ONNX / name).exists():
            raise SystemExit(f"no onnx/{name}; run export.py then half_precision.py")
    graphs = (
        session(published("vision_encoder.onnx")),
        session(published("prompt_encoder_mask_decoder.onnx")),
        session(ONNX / "memory_attention.onnx"),
        session(ONNX / "memory_encoder.onnx"),
        session(ONNX / "tracked_mask_decoder.onnx"),
        session(ONNX / "tracked_mask_decoder_fp16.onnx"),
    )
    return graphs, json.loads(parameters_path.read_text())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene", default="crossing", choices=SCENES)
    parser.add_argument("--sweep", action="store_true", help="every scene, written to host.json")
    parser.add_argument(
        "--fixtures", action="store_true", help="write the probes the Node test drives"
    )
    arguments = parser.parse_args()

    graphs, parameters = graphs_and_parameters()
    positions = vision_position_encoding(FEATURE, FEATURE, CHANNELS)

    scenes = SCENES if arguments.sweep else [arguments.scene]
    written = {}

    for scene in scenes:
        reference = Reference(scene)
        print(f"\n=== {scene}: what each stage is worth, on the reference's own inputs ===", flush=True)
        rows, trouble = stages(reference, graphs, parameters, positions)
        for name, delta in rows.items():
            print(f"  {name:52s} {delta:.3e}", flush=True)
        for frame, note in trouble:
            print(f"  !! frame {frame}: {note}", flush=True)

        print(f"\n=== {scene}: what each difference costs, end to end ===", flush=True)
        costs = {}
        for name, flags in DIFFERENCES.items():
            result = run_host(reference, graphs, parameters, positions, flags)
            costs[name] = result
            print(
                f"  {name:26s} agreement worst {result['worst_agreement']:.4f} "
                f"mean {result['mean_agreement']:.4f}   IoU {result['worst_iou']:.4f}   "
                f"swapped {result['swapped'] or 'never'}"
            )
        written[scene] = {"stages": rows, "differences": costs}

        if arguments.fixtures and scene == "crossing":
            fixture = {
                "scene": scene,
                "constants": {
                    "feature": FEATURE,
                    "channels": CHANNELS,
                    "tokensPerMemory": TOKENS_PER_MEMORY,
                    "memoryDim": MEMORY_DIM,
                    "memoryEntries": MEMORY_ENTRIES,
                    "maskSize": MASK_SIZE,
                    "memoryMask": MEMORY_MASK,
                    "sigmoidScale": parameters["constants"]["sigmoid_scale_for_mem_enc"],
                    "sigmoidBias": parameters["constants"]["sigmoid_bias_for_mem_enc"],
                },
                "tokens": PROBE_TOKENS,
                "channels_at": PROBE_CHANNELS,
                "memoryTokens": PROBE_MEMORY_TOKENS,
                "memoryChannels": PROBE_MEMORY_CHANNELS,
                "pointerAt": PROBE_POINTER,
                "patch": PATCH,
                "noMemoryEmbedding": [r(v) for v in parameters["parameters"]["no_memory_embedding"]],
                "temporal": [
                    r(v) for v in parameters["parameters"]["memory_temporal_positional_encoding"]
                ],
                "frames": fixture_frames(reference, graphs, parameters, positions),
            }
            path = HERE / "host-fixture.json"
            path.write_text(json.dumps(fixture) + "\n")
            print(f"\n  written to {path} ({path.stat().st_size / 1024:.0f} KB)", flush=True)

    if arguments.sweep:
        path = HERE / "host.json"
        path.write_text(json.dumps(written, indent=2) + "\n")
        print(f"\nwritten to {path}", flush=True)


if __name__ == "__main__":
    main()
