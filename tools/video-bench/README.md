# video-bench

The measurements video was waiting on, and the harness that took them.

**Nothing in Rotyl uses this.** It exists for the same reason `edgetam-export`
does: it answered questions that decide an architecture, and a number nobody can
reproduce is worth about as much as a guess. Four things were unknown, all of
them capable of forcing a different design, and all four now have an answer that
can be re-taken on other hardware in one command.

## Running it

```bash
./tools/video-bench/make-clips.sh          # ffmpeg + node, writes clips/
pnpm dev --port 5180                       # in another shell
node tools/video-bench/run.mjs all         # real Chrome, headed
```

`run.mjs` takes any subset: `readback`, `ort-device`, `attention`,
`bank-rampup`, `half-precision`, `decode`, `colour`, `shared-device`. The clips
are gitignored, `results.json` is not, and the graphs come from
`tools/edgetam-export`. `export.py` for the pair, then `half_precision.py`.

Real Chrome and headed, for the reason `playwright.config.ts` gives: bundled
Chromium falls back to SwiftShader, which reports success while producing
different pixels and entirely different timings.

**Every GPU number below is fenced with `queue.onSubmittedWorkDone()` on the
device that did the work**, and `mapAsync` is awaited. `requestAnimationFrame`
appears nowhere: it throttles when the pane is hidden, which silently turns a
3 ms number into a 16 ms one. Medians of 15 to 30 runs after warm-up, on an
Apple M3 Pro (Mac15,7, 18 GB) under Chrome 151, adapter `apple / metal-3`.

---

## 1. The 12 MB readback does not bind, and it is avoidable anyway

ONNX Runtime declines to accept an external `GPUDevice`, so the model's input
tensor is built on Rotyl's GPU and read back: 12.58 MB per frame, once per image
today. The worry was 360 MB/s at 30 fps across the PCIe boundary.

The whole thing, using the real `FrameTensorEncoder`:

| 12.58 MB tensor, per frame | 1920×1080 source | 4032×3024 source |
| -------------------------- | ---------------- | ---------------- |
| fullscreen pass + 3 copies | 1.0 ms           | 1.2 ms           |
| map, and copy out of it    | 1.4 ms           | 1.4 ms           |
| **total**                  | **2.4 ms**       | **2.5 ms**       |

Taken apart, on the copies alone: `copyTextureToBuffer` fenced 0.4 ms, mapping
without copying 0.6 ms, mapping and copying 1.9 ms. An ordinary 12.58 MB
`ArrayBuffer.slice` on the same machine is 1.1 ms, so **most of the readback is
a memcpy, and the transfer itself is nearly free.** That is unified memory: there
is no bus to cross. It also means the copy is the part worth removing, and it
can be, because `getMappedRange` gives a view the runtime can read directly for
as long as the buffer stays mapped.

Sustained, with a ring of staging buffers so the map of frame N overlaps the GPU
work of frame N+1:

| ring depth | ms/frame | frames/s | effective |
| ---------- | -------- | -------- | --------- |
| 1 (today)  | 1.89     | 529      | 6.7 GB/s  |
| 2          | 1.20     | 837      | 10.5 GB/s |
| 4          | 1.14     | 880      | 11.1 GB/s |

**2.4 ms of a 33 ms frame is 7%.** The readback is not the thing that binds, on
this hardware or on any bus that moves more than a gigabyte a second.

### It can be removed anyway, for video

Asked again, against 1.27.0, rather than inherited as a belief:

- `ort.env.webgpu.device` is `null` before a session exists. Assigning our
  device to it succeeds, the setter reads back the same object, and session
  creation then replaces it. `device === ours` is `false` afterwards. Ignored,
  exactly as the comment in `edgetam-engine.ts` says.
- The `{ name: 'webgpu', device }` execution-provider option fails session
  creation with `Failed to wait for the operation:3`. The runtime's docs say it
  creates its device with particular features and limits and one made
  differently is not guaranteed to work, so this was tried **with those features
  and limits matched and without**. Identical failure. That hypothesis is dead;
  the option is broken rather than fussy.

But the runtime's own device is reachable once a session exists, and:

- it accepts a decoded `VideoFrame` through `copyExternalImageToTexture`;
- it accepts an input tensor that is one of its own `GPUBuffer`s, via
  `Tensor.fromGpuBuffer`, and the result is **bit-identical** to feeding the same
  data as a CPU array. Max absolute difference 0.0 across both outputs of
  `memory_encoder`, 32,768 elements each. Not close. Equal.
- doing so saves 0.8 ms on that graph's 8 MB of input (19.3 ms → 18.5 ms).

**A `VideoFrame` belongs to no device.** So for video the tensor never has to
cross at all: import the frame on the runtime's device, run the frame-tensor
pass there, hand the buffer straight in. The image path cannot do this, its
source texture belongs to Rotyl's device and textures are not shareable between
devices, and by the numbers above it does not need to.

---

## 2. Memory attention is 59 ms, and 38 at half precision

The export README measured 226 ms on the CPU execution provider and said plainly
that it was not a prediction. On WebGPU, fenced:

|                    | WebGPU fp32 | WebGPU fp16 | wasm    |
| ------------------ | ----------- | ----------- | ------- |
| `memory_attention` | 59.4 ms     | **38.4 ms** | 1950 ms |
| `memory_encoder`   | 18.7 ms     | 14.7 ms     | 352 ms  |

wasm is 33× and 19× slower. Tracking is a WebGPU-only feature, and if the
runtime ever falls back the honest answer is to say so rather than run it.

**The fixed bank costs nothing, as designed.** Masking most of it out makes no
difference. 58.9 ms with 64 of 3648 keys live, 58.8 ms with all of them. The
decision to pad the bank and mask rather than grow it was taken to keep one
graph shape and one pipeline; it turns out not to have bought that with compute
either.

**Half precision is a good trade for attention and not for the encoder.**
Converted with `onnxconverter-common`, `keep_io_types=True`, so the caller is
unchanged. Against the fp32 graph on identical inputs:

| output                 | max abs diff | on values up to | mean abs diff |
| ---------------------- | ------------ | --------------- | ------------- |
| `conditioned_features` | 0.074        | 2.53            | 0.0090        |
| `memory_features`      | 2.48         | 4.70            | 0.042         |

Attention's worst element moves by 3% of the signal. The memory encoder's moves
by half of it, and that output is what goes into the bank and conditions every
later frame, so it compounds. Take fp16 on attention; leave the encoder alone
until someone has checked it against real feature maps rather than random ones.

The download halves too, 69.6 MB to 34.9 MB. Session creation is about 400 ms
for the first session on a page and 40 to 55 ms for every one after it, at
either precision, so the size buys the download rather than the startup. The
rotary tables the export README describes are still duplicated inside that;
deduplicating them is a separate and larger win.

### What a tracked frame costs

Summed from parts measured separately on this machine, not measured end to end,
because the end to end does not exist yet:

| vision encoder | memory attention | mask decoder | memory encoder | total      |
| -------------- | ---------------- | ------------ | -------------- | ---------- |
| ~20 ms¹        | 59 ms            | ~13 ms¹      | 19 ms          | **111 ms** |
| ~20 ms         | 38 ms (fp16)     | ~13 ms       | 19 ms          | **90 ms**  |

¹ from the root README's object-selection table; the encoder always works at
1024² so it is nearly flat in frame size.

**That is 9 to 11 tracked frames per second against 30 for playback.** Tracking
cannot be a render-loop activity, and no amount of tidying makes it one. It runs
behind the playhead, or ahead of it, and the interface has to be honest that a
mask arrives after the frame does.

---

## 3. Decode is 72× real time; the only cost is seeking

1080p30 H.264 High with B-frames, hardware decode, driven by mediabunny's packet
sink into our own `VideoDecoder`. Two clips, identical content, differing only
in keyframe interval:

|                                    | 1 s keyframes   | one keyframe     |
| ---------------------------------- | --------------- | ---------------- |
| open file, read decoder config     | 11.0 ms         | 8.1 ms           |
| walk all 300 packets (11.4 MB)     | 1.8 ms          | 1.6 ms           |
| decode 300 frames                  | 138 ms          | 135 ms           |
| decode **and** upload 300 frames   | 141 ms          | 147 ms           |
| new decoder to first frame         | 9.8 ms          | 9.8 ms           |
| **seek, median / worst**           | **12.4 / 23.4** | **88.4 / 136.8** |
| frames decoded per seek, med/worst | 14 / 26         | 164 / 292        |

Demux is 6.3 GB/s and rounds to zero. Decode is 0.46 ms a frame, 2174 fps, 72×
real time, and uploading each frame as it arrives adds 3 ms across all 300.

**Everything interesting is in the last two rows.** There is no such thing as
decoding frame N; there is decoding from the keyframe at or before N and
throwing away what comes between, so the cost is set by GOP length and by
nothing else. A clip with one-second keyframes scrubs in 12 ms. The same content
with one keyframe takes 88 ms typical and 137 ms worst, which is not a scrub.

The consequence is a design constraint, not a number to optimise: **a scrub that
moves forward must never re-seek.** Keeping one decoder alive and feeding it the
next packet costs 0.46 ms whatever the GOP is. Re-seeking is only for a backward
jump or a far-forward one, and standing up a fresh decoder to do it costs 9.8 ms,
the sixth one as much as the first, so that is a real per-seek figure rather
than a warm-up artefact.

Getting one 1080p frame onto the GPU, fenced:

| `copyExternalImageToTexture(VideoFrame)` | 0.9 ms     |
| ---------------------------------------- | ---------- |
| `importExternalTexture` + one pass       | **0.1 ms** |
| `createImageBitmap`, then copy           | 1.6 ms     |

### The demuxer

mediabunny 1.55.1, MPL-2.0. Built through Rotyl's own Vite, importing only
`Input`, `MP4`, `BlobSource` and `EncodedPacketSink`. `node
tools/video-bench/bundle-size.mjs`:

| formats         | raw    | gzip    |
| --------------- | ------ | ------- |
| `MP4`           | 166 KB | 38.1 KB |
| `MP4 QTFF`      | 167 KB | 38.2 KB |
| `MP4 QTFF WEBM` | 243 KB | 53.6 KB |

QuickTime, which is what a phone or a camera writes, costs 64 bytes gzipped: it
is the same demuxer with a different brand list. Matroska costs 15.4 KB, because
it is not.

The current application bundle is 46.3 KB gzipped, so this is not
going in it. It gets the same treatment as the inference runtime, a dynamic
import and its own chunk, and a session that never opens a video never fetches
it.

It earns that over hand-rolling for a reason worth writing down. A standard
ffmpeg H.264-with-B-frames MP4 carries an edit list whose `media_time` removes
the initial composition delay. Ignore it and every timestamp in the file is two
frames late. No crash, no warning, a constant offset that only shows up when a
mask no longer lines up with the frame it was drawn on. The packet sink also
gives `getKeyPacket(t)` and `getNextPacket(p)` directly, which is exactly the
shape a seek wants, and hands back a `VideoDecoderConfig` with the `avcC` in it.

---

## 4. A decoded frame lands in the existing colour contract unchanged

Sixteen flat patches with known sRGB bytes, encoded to H.264 and brought back.
The question is where the values belong, and both ways of being wrong are
silent.

| written through              | worst error, 4:4:4 lossless | 4:2:0 |
| ---------------------------- | --------------------------- | ----- |
| plain `rgba8unorm` view      | **1**                       | 11    |
| `rgba8unorm-srgb` view       | 73                          | 82    |
| `copyExternalImageToTexture` | 1                           | 11    |

**What an external texture samples is sRGB-encoded, exactly like the bytes of a
decoded image.** So a video frame belongs in the existing `rgba8unorm` source
texture written through a plain view, and everything downstream, which samples
through the sRGB view and gets the hardware EOTF for free, is untouched. The
invariant survives with no shader changes and no special case. Writing through
the sRGB view instead encodes twice, and the 73 in that table is what that costs.

The two upload paths agree exactly, so the choice between them is only the
0.9 ms against 0.1 ms above.

**The 4:2:0 column is Chrome, not the encoder.** ffmpeg round-trips all three
probes at worst 1, so the +11 in the midtones is introduced in the browser: 128
comes back as 139, which is the BT.709→sRGB transfer conversion to within a
code. Chrome applies it on the NV12 path and not on the I444 one. Since all real
footage is 4:2:0 the colour-managed path is the one that matters and it is the
correct one, but the discrepancy is Chrome's and nothing here can compensate
for it.

**What this did not establish:** limited versus full range. Both 4:2:0 probes
produced identical values and Chrome reported `fullRange: false` for both,
including the one ffmpeg tagged `pc`, so the range path was never exercised.
That remains the open colour question, and the clip needed to settle it is one
whose range flag is verifiably in the bitstream and actually differs.

---

## What follows

1. **Decode is free and seeking is not.** Scrubbing is a decoder kept alive and
   fed forward, with a re-seek only for backward or distant jumps.
2. **Tracking is a background job.** 9 to 11 frames per second against 30. It
   cannot live in the render loop and the interface should not pretend it does.
3. **The frame-tensor readback stays where it is for images** and can be removed
   for video by building the tensor on the runtime's own device, which will take
   a `GPUBuffer` input and gives back the same answer bit for bit.
4. **Colour needs nothing.** Upload the frame into the source texture the way an
   image is uploaded and stop.
