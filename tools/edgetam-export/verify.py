"""
Prove the exported graphs are the model, and that they track.

Three claims, in order of how likely they are to be wrong.

  1. The graphs agree with the modules they came from. An ordinary question
     about an export, checked on inputs captured from a real tracking run
     rather than on random tensors.

  2. A padded, masked memory bank gives the same answer as the reference's
     variable-length one. This is a claim about a change made during export,
     and it is the load-bearing one: if it is false, a browser implementation
     recompiles a pipeline per frame for the first sixteen frames of a clip.

  3. The clip still tracks, with the memory running on ONNX Runtime, against
     the ground truth the fixture was drawn from.

    --scene NAME   which clip: crossing, occlusion, blur, lighting.
    --no-pointers  masks the object pointers out of the bank, which measures
                   what the published decoder's missing output would cost.
    --sweep        every scene with and without pointers, into results.json,
                   which is what the research page reads. Claim 1 is checked
                   once rather than per scene: it is a question about the
                   export, and the export does not know what a scene is.
"""

import argparse
import json
import pathlib

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image
from transformers import AutoProcessor, AutoVideoProcessor, EdgeTamVideoInferenceSession, EdgeTamVideoModel

from export import (
    CHECKPOINT,
    MEMORY_TOKENS,
    NUM_MASKMEM,
    TOKENS_PER_MEMORY,
    patch_cross_attention_for_masking,
)

HERE = pathlib.Path(__file__).parent
ONNX = HERE / "onnx"
FIXTURE = HERE / "fixture"

# Large enough to zero a softmax weight, small enough not to make an infinity.
MASKED = -1e30


def iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / union) if union else 0.0


def agreement(a: np.ndarray, b: np.ndarray) -> float:
    """IoU between two predictions, where saying nothing twice is agreement."""
    union = np.logical_or(a, b).sum()
    return 1.0 if union == 0 else float(np.logical_and(a, b).sum() / union)


def true_mask(centre, radius: float, shape) -> np.ndarray:
    ys, xs = np.mgrid[0 : shape[0], 0 : shape[1]]
    return ((xs - centre[0]) ** 2 + (ys - centre[1]) ** 2) <= radius**2


def pad(memory: np.ndarray, entries: int, pointers: int) -> tuple[np.ndarray, np.ndarray]:
    """
    Lay a variable-length bank out at the one shape the graph accepts.

    Real memory entries take the first slots so their rotary frequencies are the
    ones the reference would have given them, and the pointer block sits at the
    end, where the graph's `num_k_exclude_rope` expects it. Everything else is
    masked, which is the whole of what the fixed size costs.
    """
    padded = np.zeros((MEMORY_TOKENS, 1, memory.shape[2]), dtype=np.float32)
    mask = np.full((1, 1, 1, MEMORY_TOKENS), MASKED, dtype=np.float32)

    spatial = entries * TOKENS_PER_MEMORY
    padded[:spatial] = memory[:spatial]
    mask[..., :spatial] = 0.0

    start = NUM_MASKMEM * TOKENS_PER_MEMORY
    padded[start : start + pointers] = memory[spatial : spatial + pointers]
    mask[..., start : start + pointers] = 0.0
    return padded, mask


class OnnxMemory:
    """
    The host side of a memory bank, as a browser would have to write it.

    None of this is model code. It is bookkeeping over two sessions, and it is
    here rather than in a graph because that is where it belongs.
    """

    def __init__(self, use_pointers: bool = True):
        options = ort.SessionOptions()
        options.log_severity_level = 3
        self.encoder = ort.InferenceSession(
            str(ONNX / "memory_encoder.onnx"), options, providers=["CPUExecutionProvider"]
        )
        self.attention = ort.InferenceSession(
            str(ONNX / "memory_attention.onnx"), options, providers=["CPUExecutionProvider"]
        )
        self.use_pointers = use_pointers

    def encode(self, vision_features: np.ndarray, mask_for_memory: np.ndarray):
        return self.encoder.run(
            None, {"vision_features": vision_features, "mask_for_memory": mask_for_memory}
        )

    def attend(self, vision_features, vision_positions, memory, memory_positions, entries, pointers):
        if not self.use_pointers:
            pointers = 0
        padded_memory, mask = pad(memory, entries, pointers)
        padded_positions, _ = pad(memory_positions, entries, pointers)
        (conditioned,) = self.attention.run(
            None,
            {
                "vision_features": vision_features,
                "vision_position_embeddings": vision_positions,
                "memory": padded_memory,
                "memory_position_embeddings": padded_positions,
                "key_mask": mask,
            },
        )
        return conditioned


def install(model: EdgeTamVideoModel, memory: OnnxMemory) -> None:
    """Route the two memory modules through ONNX Runtime, leave the rest alone."""
    config = model.config
    if model.occlusion_spatial_embedding_parameter is not None:
        raise SystemExit("this checkpoint uses an occlusion embedding; the graph would need it too")

    # Parameter names match the reference: it calls this with keywords.
    def encode_new_memory(current_vision_feats, pred_masks_high_res, object_score_logits, is_mask_from_pts):
        batch = current_vision_feats.size(1)
        height, width = model.backbone_feature_sizes[-1]
        pixels = current_vision_feats.permute(1, 2, 0).view(batch, model.hidden_dim, height, width)

        # The arithmetic the reference does before the encoder, kept out of the
        # graph so the graph has one meaning rather than a mode.
        if is_mask_from_pts:
            mask_for_memory = (pred_masks_high_res > 0).to(pred_masks_high_res.dtype)
        else:
            mask_for_memory = torch.sigmoid(pred_masks_high_res)
        mask_for_memory = mask_for_memory * config.sigmoid_scale_for_mem_enc + config.sigmoid_bias_for_mem_enc

        features, positions = memory.encode(
            pixels.detach().numpy().astype(np.float32),
            mask_for_memory.detach().numpy().astype(np.float32),
        )
        return torch.from_numpy(features), torch.from_numpy(positions)

    model._encode_new_memory = encode_new_memory
    # The forward rather than the module: torch refuses a plain function as a
    # child, and the forward is what gets called.
    model.memory_attention.forward = lambda **kwargs: torch.from_numpy(
        memory.attend(
            kwargs["current_vision_features"].detach().numpy().astype(np.float32),
            kwargs["current_vision_position_embeddings"].detach().numpy().astype(np.float32),
            kwargs["memory"].detach().numpy().astype(np.float32),
            kwargs["memory_posision_embeddings"].detach().numpy().astype(np.float32),
            kwargs["num_spatial_memory_tokens"],
            kwargs["num_object_pointer_tokens"],
        )
    )


def prepare(scene: str) -> tuple:
    folder = FIXTURE / scene
    truth = json.loads((folder / "truth.json").read_text())
    images = [Image.open(p).convert("RGB") for p in sorted(folder.glob("f*.png"))]
    if not images:
        raise SystemExit(f"no {scene} fixture; run make_fixture.py first")
    height, width = np.asarray(images[0]).shape[:2]
    processor = AutoVideoProcessor.from_pretrained(CHECKPOINT)
    full_processor = AutoProcessor.from_pretrained(CHECKPOINT)
    return truth, images, height, width, processor, full_processor


def session_for(model, processor, full_processor, images, height, width, truth):
    video = processor(videos=[images], return_tensors="pt")["pixel_values_videos"][0]
    session = EdgeTamVideoInferenceSession(
        video=video, video_height=height, video_width=width, dtype=torch.float32
    )
    start = truth["frames"][0]["target"]
    full_processor.add_inputs_to_inference_session(
        inference_session=session,
        frame_idx=0,
        obj_ids=1,
        input_points=[[[[start[0], start[1]]]]],
        input_labels=[[[1]]],
    )
    return session


def track(model, processor, full_processor, images, height, width, truth) -> tuple[list[dict], np.ndarray]:
    session = session_for(model, processor, full_processor, images, height, width, truth)
    rows, masks = [], []
    for output in model.propagate_in_video_iterator(session, start_frame_idx=0):
        frame = output.frame_idx
        logits = processor.post_process_masks(
            [output.pred_masks],
            original_sizes=[[height, width]],
            reshaped_input_sizes=[[1024, 1024]],
            binarize=False,
        )[0]
        mask = (logits[0, 0] > 0).numpy()
        masks.append(mask)
        record = truth["frames"][frame]
        rows.append(
            {
                "frame": frame,
                # A fully hidden object has no true mask, so its IoU is zero
                # whatever the tracker does and averaging it in would report a
                # failure that is the fixture agreeing with itself. Every
                # statistic below is taken over the visible frames, and what
                # happens on the hidden ones is reported on its own terms.
                "visible": bool(record.get("visible", True)),
                "whole": bool(record.get("whole", True)),
                "target": round(iou(mask, true_mask(record["target"], truth["radius"], mask.shape)), 4),
                "distractor": round(
                    iou(mask, true_mask(record["distractor"], truth["radius"], mask.shape)), 4
                ),
                "area": int(mask.sum()),
            }
        )
    return rows, np.stack(masks)


def summarise(rows: list[dict], masks: np.ndarray, reference_masks: np.ndarray) -> dict:
    """
    What a run of one scene amounts to, as the four numbers that decide a design.

    `swapped` is the one that matters and it is deliberately not an IoU
    threshold: a tracker that has taken the wrong object scores higher against
    the distractor than against the target, whatever either number is, and a
    tracker that has merely drifted does not.
    """
    visible = [r for r in rows if r["visible"]]
    hidden = [r for r in rows if not r["visible"]]
    whole = [r for r in rows if r["whole"]]

    # HOW LATE IT WAS BACK. On a clip with an occlusion, the frame the object
    # returns on is the one thing a memory bank exists to get right, and it is
    # not visible in any average: a tracker that misses it and picks the object
    # up on the next frame scores about the same over the clip as one that does
    # not. In frames, and None where nothing was ever hidden.
    delay = None
    if hidden:
        back = next((r["frame"] for r in rows if r["frame"] > hidden[-1]["frame"] and r["visible"]), None)
        if back is not None:
            found = next((r["frame"] for r in rows if r["frame"] >= back and r["area"] > 0), None)
            delay = None if found is None else found - back

    return {
        "reacquisition_delay": delay,
        "worst_iou": round(min((r["target"] for r in whole), default=0.0), 4),
        "worst_iou_partial": round(
            min((r["target"] for r in visible if not r["whole"]), default=1.0), 4
        ),
        "swapped": [r["frame"] for r in visible if r["distractor"] > r["target"]],
        # What it did while there was nothing to see. A tracker that keeps
        # predicting the object it cannot see is guessing; one that goes quiet
        # and comes back is the behaviour the memory bank is for.
        "hidden_frames": [r["frame"] for r in hidden],
        "hidden_area": [r["area"] for r in hidden],
        "hidden_on_distractor": [r["frame"] for r in hidden if r["distractor"] > 0.1],
        # Two empty masks agree completely, and on a hidden frame that is the
        # expected answer rather than a disagreement. iou() reports zero for an
        # empty union because that is right when one side is a ground truth.
        "worst_vs_pytorch": round(
            min((agreement(a, b) for a, b in zip(masks, reference_masks)), default=0.0), 4
        ),
    }


def compare_modules(truth, images, height, width, processor, full_processor) -> None:
    """Claims 1 and 2: the graphs are the modules, and padding is not an approximation."""
    patch_cross_attention_for_masking()
    model = EdgeTamVideoModel.from_pretrained(CHECKPOINT, dtype=torch.float32).eval()

    encoder_calls: list[dict] = []
    attention_calls: list[dict] = []
    model.memory_encoder.register_forward_hook(
        lambda m, a, k, o: encoder_calls.append({"features": a[0].clone(), "mask": a[1].clone()}),
        with_kwargs=True,
    )
    model.spatial_perceiver.register_forward_hook(
        lambda m, a, k, o: encoder_calls[-1].update(out_features=o[0].clone(), out_positions=o[1].clone()),
        with_kwargs=True,
    )
    model.memory_attention.register_forward_hook(
        lambda m, a, k, o: attention_calls.append({**{n: v.clone() if torch.is_tensor(v) else v for n, v in k.items()}, "out": o.clone()}),
        with_kwargs=True,
    )

    session = session_for(model, processor, full_processor, images, height, width, truth)
    for _ in model.propagate_in_video_iterator(session, start_frame_idx=0):
        pass

    options = ort.SessionOptions()
    options.log_severity_level = 3
    encoder = ort.InferenceSession(str(ONNX / "memory_encoder.onnx"), options, providers=["CPUExecutionProvider"])
    attention = ort.InferenceSession(
        str(ONNX / "memory_attention.onnx"), options, providers=["CPUExecutionProvider"]
    )

    worst_encoder = 0.0
    for call in encoder_calls:
        features, positions = encoder.run(
            None,
            {"vision_features": call["features"].numpy(), "mask_for_memory": call["mask"].numpy()},
        )
        worst_encoder = max(
            worst_encoder,
            float(np.abs(features - call["out_features"].numpy()).max()),
            float(np.abs(positions - call["out_positions"].numpy()).max()),
        )

    worst_attention = 0.0
    print("  padded bank against the reference's own length:")
    for call in attention_calls:
        entries = call["num_spatial_memory_tokens"]
        pointers = call["num_object_pointer_tokens"]
        memory, mask = pad(call["memory"].numpy(), entries, pointers)
        positions, _ = pad(call["memory_posision_embeddings"].numpy(), entries, pointers)
        (conditioned,) = attention.run(
            None,
            {
                "vision_features": call["current_vision_features"].numpy(),
                "vision_position_embeddings": call["current_vision_position_embeddings"].numpy(),
                "memory": memory,
                "memory_position_embeddings": positions,
                "key_mask": mask,
            },
        )
        delta = float(np.abs(conditioned - call["out"].numpy()).max())
        worst_attention = max(worst_attention, delta)
        print(f"    {entries} entries + {pointers} pointer tokens padded to {MEMORY_TOKENS}: {delta:.1e}")

    print(f"\n  worst memory encoder difference:   {worst_encoder:.1e}")
    print(f"  worst memory attention difference: {worst_attention:.1e}")


SCENES = ["crossing", "occlusion", "blur", "lighting"]


def run_scene(scene: str, reference_model, model, memory: "OnnxMemory", pointers: bool) -> dict:
    truth, images, height, width, processor, full_processor = prepare(scene)
    reference_rows, reference_masks = track(
        reference_model, processor, full_processor, images, height, width, truth
    )
    memory.use_pointers = pointers
    rows, masks = track(model, processor, full_processor, images, height, width, truth)

    summary = summarise(rows, masks, reference_masks)
    summary["pytorch_worst_iou"] = round(
        min((r["target"] for r in reference_rows if r["whole"]), default=0.0), 4
    )
    summary["pytorch_swapped"] = [
        r["frame"] for r in reference_rows if r["visible"] and r["distractor"] > r["target"]
    ]
    summary["frames_total"] = len(rows)
    summary["frames"] = rows
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene", default="crossing", choices=SCENES)
    parser.add_argument(
        "--no-pointers",
        action="store_true",
        help="mask the object pointers out, measuring what the published decoder's missing output costs",
    )
    parser.add_argument(
        "--sweep",
        action="store_true",
        help="every scene, with and without pointers, written to results.json",
    )
    arguments = parser.parse_args()

    # Claim 1 is about the export rather than about a clip, so it is checked
    # once, on the scene the original figures were taken against.
    truth, images, height, width, processor, full_processor = prepare("crossing")
    print("=== the graphs against the modules they came from ===")
    compare_modules(truth, images, height, width, processor, full_processor)

    reference_model = EdgeTamVideoModel.from_pretrained(CHECKPOINT, dtype=torch.float32).eval()
    model = EdgeTamVideoModel.from_pretrained(CHECKPOINT, dtype=torch.float32).eval()
    memory = OnnxMemory()
    install(model, memory)

    if not arguments.sweep:
        label = "pointers masked out" if arguments.no_pointers else "with pointers"
        print(f"\n=== tracking {arguments.scene}, {label} ===")
        summary = run_scene(arguments.scene, reference_model, model, memory, not arguments.no_pointers)
        for row in summary["frames"]:
            print(
                f"  frame {row['frame']:2d}: IoU {row['target']:.3f} target, "
                f"{row['distractor']:.3f} distractor" + ("" if row["visible"] else "   (hidden)")
            )
        print(f"\n  worst IoU against the target, PyTorch: {summary['pytorch_worst_iou']:.3f}")
        print(f"  worst IoU against the target, ONNX:    {summary['worst_iou']:.3f}")
        print(f"  worst IoU between the two runs:        {summary['worst_vs_pytorch']:.3f}")
        print(f"  frames where it swapped to the distractor: {summary['swapped'] or 'none'}")
        return

    out: dict = {}
    for scene in SCENES:
        for pointers in (True, False):
            key = f"{scene}, {'with pointers' if pointers else 'no pointers'}"
            print(f"\n=== {key} ===")
            summary = run_scene(scene, reference_model, model, memory, pointers)
            print(
                f"  worst IoU {summary['worst_iou']:.3f}, PyTorch {summary['pytorch_worst_iou']:.3f}, "
                f"agreement {summary['worst_vs_pytorch']:.3f}, swapped {summary['swapped'] or 'never'}"
            )
            out[key] = summary

    results = HERE / "results.json"
    results.write_text(json.dumps(out, indent=2) + "\n")
    print(f"\nwritten to {results}")


if __name__ == "__main__":
    main()
