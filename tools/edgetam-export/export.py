"""
Export the two graphs video tracking needs and the published release lacks.

See README.md for what is missing and why the memory bank is a fixed size. The
short version: a memory entry is 512 tokens, the bank holds 7 of them plus 64
pointer tokens, and padding it to that size rather than growing it is what keeps
the graph to one shape and the two rotary integers to constants.
"""

import pathlib

import torch
from transformers import EdgeTamVideoModel
from transformers.models.edgetam_video import modeling_edgetam_video as M

HERE = pathlib.Path(__file__).parent
OUT = HERE / "onnx"

# The checkpoint onnx-community/EdgeTAM-ONNX was exported from, so the graphs
# produced here and the ones already shipping hold the same weights.
CHECKPOINT = "yonigozlan/EdgeTAM-hf"

# Observed on a real clip rather than read off the config, because the config
# does not say how many tokens a memory entry becomes after the perceiver.
VISION_TOKENS = 4096
VISION_DIM = 256
MEMORY_DIM = 64
TOKENS_PER_MEMORY = 512
NUM_MASKMEM = 7
POINTER_TOKENS = 64  # 16 pointers, each split into 4 tokens of 64 dims
MEMORY_TOKENS = NUM_MASKMEM * TOKENS_PER_MEMORY + POINTER_TOKENS


def patch_cross_attention_for_masking() -> None:
    """
    Let the memory cross-attention take a key mask.

    The module passes `attention_mask=None` because the reference never needs
    one: it concatenates exactly as many memory entries as it has. A fixed-size
    bank does need one, and this is the smallest way to add it. The mask is
    read from an attribute the wrapper sets, so it is an ordinary traced tensor
    and every other line of the module is untouched.
    """
    original = M.EdgeTamVideoRoPECrossAttention.forward

    def forward(self, query, key, value, position_embeddings, position_embeddings_k, **kwargs):
        mask = getattr(self, "_key_mask", None)
        if mask is None:
            return original(self, query, key, value, position_embeddings, position_embeddings_k, **kwargs)

        batch_size, point_batch_size = query.shape[:2]
        shape = (batch_size * point_batch_size, -1, self.num_attention_heads, self.head_dim)
        queries = self.q_proj(query).view(*shape).transpose(1, 2)
        keys = self.k_proj(key).view(*shape).transpose(1, 2)
        values = self.v_proj(value).view(*shape).transpose(1, 2)

        cos, sin = position_embeddings
        cos_k, sin_k = position_embeddings_k
        queries, keys = M.apply_rotary_pos_emb_2d_cross_attn(
            queries,
            keys,
            cos=cos,
            sin=sin,
            cos_k=cos_k,
            sin_k=sin_k,
            repeat_freqs_k=kwargs.get("rope_k_repeat", 0),
            num_k_exclude_rope=kwargs.get("num_k_exclude_rope", 0),
        )

        scores = torch.matmul(queries, keys.transpose(-1, -2)) * self.scaling + mask
        weights = torch.softmax(scores, dim=-1)
        attended = torch.matmul(weights, values)
        attended = attended.transpose(1, 2).reshape(
            batch_size, point_batch_size, -1, self.num_attention_heads * self.head_dim
        )
        return self.o_proj(attended), weights

    M.EdgeTamVideoRoPECrossAttention.forward = forward


class MemoryEncoderGraph(torch.nn.Module):
    """
    A frame and its mask in, one memory entry out.

    The sigmoid, scale and bias the reference applies to the mask beforehand are
    left to the host: they are three lines of arithmetic, and keeping them out
    means the graph has one meaning rather than a mode.
    """

    def __init__(self, model: EdgeTamVideoModel):
        super().__init__()
        self.memory_encoder = model.memory_encoder
        self.spatial_perceiver = model.spatial_perceiver

    def forward(self, vision_features: torch.Tensor, mask_for_memory: torch.Tensor):
        features, positions = self.memory_encoder(vision_features, mask_for_memory)
        return self.spatial_perceiver(features, positions)


class MemoryAttentionGraph(torch.nn.Module):
    """The current frame's features, conditioned on a full memory bank."""

    def __init__(self, model: EdgeTamVideoModel):
        super().__init__()
        self.memory_attention = model.memory_attention

    def forward(
        self,
        vision_features: torch.Tensor,
        vision_position_embeddings: torch.Tensor,
        memory: torch.Tensor,
        memory_position_embeddings: torch.Tensor,
        key_mask: torch.Tensor,
    ) -> torch.Tensor:
        for layer in self.memory_attention.layers:
            layer.cross_attn_image._key_mask = key_mask
        return self.memory_attention(
            current_vision_features=vision_features,
            current_vision_position_embeddings=vision_position_embeddings,
            memory=memory,
            memory_posision_embeddings=memory_position_embeddings,
            num_object_pointer_tokens=POINTER_TOKENS,
            num_spatial_memory_tokens=NUM_MASKMEM,
        )


class TrackedDecoderGraph(torch.nn.Module):
    """
    The mask decoder a TRACKED frame needs, with the output the published one
    does not expose.

    WHY THIS EXISTS. The published prompt-encoder/mask-decoder pair declares
    `iou_scores`, `pred_masks` and `object_score_logits`. The memory bank also
    wants `object_pointer`, the token carrying an object's identity between
    frames, and without it a tracker comes back from an occlusion late and with
    no mask at all on the frames it is late by.

    WHY IT TAKES NO PROMPT. A tracked frame has no click. The reference answers
    one by padding an absent prompt into a single point at the origin labelled
    -1, which the prompt encoder then replaces wholesale with two "not a point"
    embeddings, and the dense half is the no-mask embedding expanded. All of
    that is the same on every tracked frame of every clip, so tracing folds it
    to constants and the graph takes the three feature maps and nothing else.
    That is worth more than the bytes it saves: the published graph accepts
    prompt tensors and gives a DIFFERENT answer for an empty one than for the
    padded one it expects, which is a mistake this graph cannot be asked to
    make. See the README.

    WHAT IT LEAVES TO THE HOST is what `memory_encoder` leaves it: the pointer
    comes back projected but not blended, so the host substitutes
    `no_object_pointer` on a frame the object is not in, exactly as it applies
    the sigmoid and the scale either side of the memory encoder. The graph has
    one meaning rather than a mode.

    THREE POINTERS, not one, because there are three masks. The decoder answers
    with a part, an object and a group and the host picks by the model's own IoU
    estimate; the pointer for that pick is the one at the same index.
    """

    def __init__(self, model: EdgeTamVideoModel):
        super().__init__()
        self.prompt_encoder = model.prompt_encoder
        self.mask_decoder = model.mask_decoder
        self.object_pointer_proj = model.object_pointer_proj
        self.register_buffer("positions", model.get_image_wide_positional_embeddings())

    def forward(self, image_embeddings_0, image_embeddings_1, image_embeddings_2):
        batch = image_embeddings_2.shape[0]
        # What the reference pads an absent prompt into, and the only prompt a
        # tracked frame ever has. `input_boxes=None` is what makes the encoder
        # append its trailing "not a point", so there are two of them.
        points = torch.zeros(batch, 1, 1, 2, dtype=image_embeddings_2.dtype)
        labels = -torch.ones(batch, 1, 1, dtype=torch.int32)
        sparse, dense = self.prompt_encoder(points, labels, None, None)

        masks, iou_scores, tokens, object_score_logits = self.mask_decoder(
            image_embeddings=image_embeddings_2,
            image_positional_embeddings=self.positions,
            sparse_prompt_embeddings=sparse,
            dense_prompt_embeddings=dense,
            multimask_output=True,
            high_resolution_features=[image_embeddings_0, image_embeddings_1],
        )
        return iou_scores, masks, object_score_logits, self.object_pointer_proj(tokens)


def write(module: torch.nn.Module, args: tuple, path: pathlib.Path, inputs: list[str], outputs: list[str]) -> None:
    torch.onnx.export(
        module,
        args,
        str(path),
        input_names=inputs,
        output_names=outputs,
        opset_version=17,
        dynamo=False,
        do_constant_folding=True,
    )
    print(f"  {path.name}: {path.stat().st_size / 1e6:.1f} MB")


def load_model() -> EdgeTamVideoModel:
    patch_cross_attention_for_masking()
    return EdgeTamVideoModel.from_pretrained(CHECKPOINT, dtype=torch.float32).eval()


def main() -> None:
    OUT.mkdir(exist_ok=True)
    model = load_model()

    print("memory encoder")
    write(
        MemoryEncoderGraph(model),
        (torch.randn(1, VISION_DIM, 64, 64), torch.rand(1, 1, 1024, 1024)),
        OUT / "memory_encoder.onnx",
        ["vision_features", "mask_for_memory"],
        ["memory_features", "memory_positions"],
    )

    print("memory attention")
    write(
        MemoryAttentionGraph(model),
        (
            torch.randn(VISION_TOKENS, 1, VISION_DIM),
            torch.randn(VISION_TOKENS, 1, VISION_DIM),
            torch.randn(MEMORY_TOKENS, 1, MEMORY_DIM),
            torch.randn(MEMORY_TOKENS, 1, MEMORY_DIM),
            torch.zeros(1, 1, 1, MEMORY_TOKENS),
        ),
        OUT / "memory_attention.onnx",
        ["vision_features", "vision_position_embeddings", "memory", "memory_position_embeddings", "key_mask"],
        ["conditioned_features"],
    )

    print("tracked-frame mask decoder")
    write(
        TrackedDecoderGraph(model),
        (torch.randn(1, 32, 256, 256), torch.randn(1, 64, 128, 128), torch.randn(1, 256, 64, 64)),
        OUT / "tracked_mask_decoder.onnx",
        ["image_embeddings.0", "image_embeddings.1", "image_embeddings.2"],
        ["iou_scores", "pred_masks", "object_score_logits", "object_pointer"],
    )

    print("\nMost of memory_attention is baked rotary tables, not weights.")
    print("See the size table in README.md before budgeting a download for it.")


if __name__ == "__main__":
    main()
