# video-bench

The measurements video was waiting on, and the harness that took them.

**Nothing in Rotyl uses this.** It exists for the same reason `edgetam-export`
does: it answered questions that decide an architecture, and a number nobody can
reproduce is worth about as much as a guess. Seven things were unknown, all of
them capable of forcing a different design, and all seven now have an answer
that can be re-taken on other hardware in one command.

## Running it

```bash
./tools/video-bench/make-clips.sh          # ffmpeg + node, writes clips/
pnpm dev --port 5180                       # in another shell
node tools/video-bench/run.mjs all         # real Chrome, headed
```

`run.mjs` takes any subset: `readback`, `ort-device`, `attention`,
`bank-rampup`, `half-precision`, `decode`, `colour`, `encode`, `encode-colour`,
`shared-device`. The bundle sizes are separate and need no browser:
`node tools/video-bench/bundle-size.mjs`. The clips are gitignored,
`results.json` is not, and the graphs come from `tools/edgetam-export`.
`export.py` for the pair, then `half_precision.py`.

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
| fullscreen pass + 3 copies | 0.9 ms           | 1.1 ms           |
| map, and copy out of it    | 1.2 ms           | 1.2 ms           |
| **total**                  | **2.1 ms**       | **2.3 ms**       |

Taken apart, on the copies alone: `copyTextureToBuffer` fenced 0.2 ms, mapping
without copying 0.6 ms, mapping and copying 1.5 ms. An ordinary 12.58 MB
`ArrayBuffer.slice` on the same machine is 0.8 ms, so **most of the readback is
a memcpy, and the transfer itself is nearly free.** That is unified memory: there
is no bus to cross. It also means the copy is the part worth removing, and it
can be, because `getMappedRange` gives a view the runtime can read directly for
as long as the buffer stays mapped.

Sustained, with a ring of staging buffers so the map of frame N overlaps the GPU
work of frame N+1:

| ring depth | ms/frame | frames/s | effective |
| ---------- | -------- | -------- | --------- |
| 1 (today)  | 1.53     | 652      | 8.2 GB/s  |
| 2          | 1.08     | 929      | 11.7 GB/s |
| 4          | 1.04     | 963      | 12.1 GB/s |

**2.1 ms of a 33 ms frame is 6%.** The readback is not the thing that binds, on
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
- doing so saves 1.4 ms on that graph's 8 MB of input (19.3 ms → 17.9 ms).

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
| `memory_attention` | 60.1 ms     | **37.7 ms** | 1904 ms |
| `memory_encoder`   | 18.7 ms     | 14.7 ms     | 348 ms  |

wasm is 32× and 19× slower. Tracking is a WebGPU-only feature, and if the
runtime ever falls back the honest answer is to say so rather than run it.

**The fixed bank costs nothing, as designed.** Masking most of it out makes no
difference. 58.0 ms with 64 of 3648 keys live, 58.2 ms with all of them. The
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
| ~20 ms¹        | 60 ms            | ~13 ms¹      | 19 ms          | **112 ms** |
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
| open file, read decoder config     | 9.4 ms          | 7.1 ms           |
| walk all 300 packets (11.4 MB)     | 1.8 ms          | 1.6 ms           |
| decode 300 frames                  | 140 ms          | 136 ms           |
| decode **and** upload 300 frames   | 141 ms          | 137 ms           |
| new decoder to first frame         | 12.3 ms         | 12.5 ms          |
| **seek, median / worst**           | **15.3 / 25.3** | **88.0 / 137.2** |
| frames decoded per seek, med/worst | 14 / 26         | 164 / 292        |

Demux is 6.3 GB/s and rounds to zero. Decode is 0.47 ms a frame, 2146 fps, 71×
real time, and uploading each frame as it arrives adds under a millisecond
across all 300.

**Everything interesting is in the last two rows.** There is no such thing as
decoding frame N; there is decoding from the keyframe at or before N and
throwing away what comes between, so the cost is set by GOP length and by
nothing else. A clip with one-second keyframes scrubs in 15 ms. The same content
with one keyframe takes 88 ms typical and 137 ms worst, which is not a scrub.

The consequence is a design constraint, not a number to optimise: **a scrub that
moves forward must never re-seek.** Keeping one decoder alive and feeding it the
next packet costs 0.47 ms whatever the GOP is. Re-seeking is only for a backward
jump or a far-forward one, and standing up a fresh decoder to do it costs 12 ms,
the sixth one as much as the first, so that is a real per-seek figure rather
than a warm-up artefact.

Getting one 1080p frame onto the GPU, fenced:

| `copyExternalImageToTexture(VideoFrame)` | 0.6 ms     |
| ---------------------------------------- | ---------- |
| `importExternalTexture` + one pass       | **0.1 ms** |
| `createImageBitmap`, then copy           | 1.2 ms     |

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

---

## 5. The whole export pipeline is 5 ms a frame, and almost all of it is the encoder

The question was not what one encoded frame costs. A `VideoEncoder` is
asynchronous and holds its own queue, so one frame answers nothing. What decides
whether a clip export is a wait or an ordeal is SUSTAINED throughput with
decode, style, composite, capture, encode and mux all in flight.

Measured as a ladder, each rung adding exactly one step to the one below it,
over the same ninety frames of the same clip, at the poster style and the export
quality tier. Wall-clock milliseconds per frame:

| rung                                     | 720p    | 1080p   |
| ---------------------------------------- | ------- | ------- |
| decode the frame and upload it           | 1.1     | 1.7     |
| + the style chain and the composite      | 2.7     | 3.3     |
| + capture the canvas as a frame          | 2.4     | 3.4     |
| + our own `VideoEncoder`, packets binned | 2.9     | 4.9     |
| + write them into an MP4                 | **3.0** | **5.0** |
| the library driving the encoder as well  | 2.9     | 5.2     |

**The encoder is the pipeline.** The encoder handed the same picture with the
GPU taken out of the loop entirely measures 4.7 ms a frame at 1080p, against
5.0 for everything. Every rung below it runs on threads the encoder is not
using, so the ladder does not add up, and that is the finding rather than an
artefact: at 1080p with a cheap style there is no point optimising anything
except the encoder.

Which makes a clip export **6.7 times real time at 1080p and 12 at 720p**, per
style:

| end to end, export tier | 720p             | 1080p            |
| ----------------------- | ---------------- | ---------------- |
| poster                  | 2.9 ms (345 fps) | 5.0 ms (199 fps) |
| print                   | 2.7 ms (375 fps) | 5.3 ms (190 fps) |
| comic                   | 117 ms (9 fps)   | 339 ms (3 fps)   |

The comic chain is the style-cost table again with an encoder underneath it that
it never has to wait for. A minute of 1080p through it is five and a half
minutes of work, which is why an export has to be stoppable and has to say how
far it has got.

### Capture the canvas. The other way costs a millisecond and a de-padding loop

Two ways to get the composite to the encoder, timed under identical conditions:
build a `VideoFrame` from the canvas the composite already renders into, or copy
the texture into a buffer and rebuild a frame from the bytes.

At 720p they are the same, because a 1280-pixel row is already a multiple of the
256 bytes `copyTextureToBuffer` insists on. At 1080p the readback path costs
**1.4 ms a frame more**, and 1920 pixels is not a multiple of 256, so every row
has to be copied out of its padding on the CPU.

Capturing the canvas costs nothing detectable at either size. It is below the
noise of the rung underneath it, which is why the 720p column shows the capture
rung as marginally cheaper than the composite rung it contains.

### The muxer is free, and the encoder wrapper costs 5%

Writing the packets into an MP4 rather than binning them costs 0.1 ms a frame.
Whatever the container writer costs, it is not per frame.

Letting the library own the `VideoEncoder` too, rather than driving it here,
costs 0.26 ms a frame at 1080p. An earlier run put that at 0.7 ms and it was
wrong: the library was being asked for `high` quality, which resolves to a
quantizer, and it was encoding two and a half times the bits. Given the same
bitrate the two produce byte-identical file sizes and differ by 5%.

### `latencyMode: 'realtime'` is slower, and once it was catastrophic

| encoder alone, 90 frames | mean    | median | worst   |
| ------------------------ | ------- | ------ | ------- |
| 720p, `quality`          | 2.6 ms  | 2.4 ms | 15.8 ms |
| 720p, `realtime`         | 39.6 ms | 3.1 ms | 3026 ms |
| 1080p, `quality`         | 4.7 ms  | 4.8 ms | 15.6 ms |
| 1080p, `realtime`        | 5.9 ms  | 5.6 ms | 24.8 ms |

The three-second stall at 720p reproduced on every run. The mode also permits
the encoder to DROP frames when it falls behind, which for an export is not a
trade-off, it is a corrupt file. Nothing here recommends it.

### Rate control is a decision about file size and not about speed

A qualitative quality level resolves to a QUANTIZER where the codec supports
one, which is constant quality and therefore an unbounded file. Measured on a
styled 1080p frame, ninety frames, three seconds:

| what was asked for        | ms/frame | file     | rate        |
| ------------------------- | -------- | -------- | ----------- |
| `high`, as a quantizer    | 5.4      | 11.24 MB | 30.0 Mbit/s |
| `high`, as a bitrate      | 5.3      | 2.32 MB  | 6.2 Mbit/s  |
| `very-high`, as a bitrate | 5.3      | 4.42 MB  | 11.8 Mbit/s |
| 12 Mbit/s, stated         | 5.3      | 4.57 MB  | 12.2 Mbit/s |

**Five times the file for no time at all.** The default is the quantizer, so a
clip export that says nothing about rate control ships the first row. Rotyl asks
for `very-high` as a bitrate, which is the third.

### The capture takes frame N, and that had to be checked

A canvas is PRESENTED rather than read, so "capture the canvas" is a claim about
when as much as about what. Being one frame out is invisible in every number
above while making every exported clip wrong, and wrong in the way that matters
most: the selection drawn on frame N would land on the pixels of frame N minus
one.

So the whole path was run for real and the file decoded back, with the composite
at zero coverage so a written frame should match the source frame it came from
and no other. **All sixteen frames matched their own source frame**, by a margin
of 1.5 against the next best candidate.

The first attempt at this reported offsets of one and two frames and it was the
measurement that was wrong, not the pipeline: consecutive frames of a slow zoom
differ by less than the codec does, so an argmin over them was reading noise.
Spacing the frames four apart, taking the fingerprint and the encoded frame from
the same uploaded source frame, and reporting the margin as well as the answer,
turned an ambiguous result into a conclusive one.

---

## 6. Writing a container costs as much as the whole application

Through Rotyl's own build, so the answer is what this bundler's tree shaking
actually produces. `node tools/video-bench/bundle-size.mjs`:

| what the module does                  | raw      | gzip    |
| ------------------------------------- | -------- | ------- |
| read MP4                              | 144.8 KB | 35.2 KB |
| read MP4 and QuickTime                | 145.1 KB | 35.2 KB |
| read MP4, QuickTime and Matroska      | 211.2 KB | 49.4 KB |
| write MP4, from packets               | 129.3 KB | 30.5 KB |
| write MP4, encoding as well           | 206.5 KB | 48.5 KB |
| write MP4 and QuickTime               | 206.5 KB | 48.5 KB |
| write MP4 and Matroska                | 243.6 KB | 56.9 KB |
| read MP4 and QuickTime, and write MP4 | 330.1 KB | 76.8 KB |

The three numbers that decide the design:

- **Writing costs 41.6 KB gzipped on top of a chunk that already reads**, which
  is the size of the entire application bundle to the tenth of a kilobyte. So
  the writer is its own dynamic import, fetched by an export and by nothing
  else, the same treatment the demuxer and the model get.
- **A second container to write costs 12 bytes.** QuickTime is the same muxer
  with a different brand list, exactly as it is on the read side. Matroska costs
  8.4 KB, because it is not.
- **The encoder wrapper is 18.0 KB of the 48.5.** Driving `VideoEncoder`
  directly and piping packets in would save that and cost 5% a frame. Inside a
  chunk only a clip export fetches, 18 KB does not buy back codec-string
  construction, backpressure, flush ordering and getting the decoder config into
  the muxer's first packet.

These are oxc-minified where the earlier demux figures in this file were
esbuild-minified, which is why reading MP4 now measures 35.2 KB where it
measured 38.1. Same code, different minifier, and it is the comparisons within
the table that the design turns on rather than the absolute numbers.

### What the real build does with it, which is not what the table says

The table above measures each module alone. Shipped, there are two consumers of
one library, and the bundler puts what they share in a chunk of its own.
Gzipped, before this chapter and after:

| chunk            | before  | after   |
| ---------------- | ------- | ------- |
| the application  | 41.6 KB | 42.5 KB |
| opening a video  | 33.2 KB | 42.0 KB |
| exporting a clip | none    | 32.0 KB |

**Opening a video got 8.8 KB more expensive for somebody who never exports one**,
and that is worth stating rather than burying. Chunks are assigned per module,
not per symbol, so a module both halves use lands in the shared chunk carrying
the exports only the writer needs. The alternative arrangements are worse: one
mediabunny chunk makes every video session pay 76.8 KB, and no split at all puts
it in the application.

## 7. The encoder is not what moves colour

Measurement 4 asked what happens on the way in. The way out had never been
tested, and it is the direction a clip export depends on: pixels leave through a
canvas, become a `VideoFrame`, are converted to YCbCr by the encoder, and come
back through the browser's own conversion.

The same sixteen patches, put through the real composite at zero coverage, which
is `mix(source, styled, 0)` and therefore the source byte for byte, then written
out as an MP4 and decoded back.

| the same patches, round tripped | worst error | median |
| ------------------------------- | ----------- | ------ |
| through Rotyl's encoder         | 11          | 2      |
| through ffmpeg, same decode     | 11          | 2      |

**All sixteen patches come back bit-identical to ffmpeg's**, not merely close.
The error is entirely the +11 in the midtones that measurement 4 already
attributed to Chrome's BT.709 conversion on the NV12 decode path. Saturated
primaries survive exactly: 255,0,0 goes out and 255,0,0 comes back.

The container is tagged correctly too, which matters for every player that is
not this one: `bt709` primaries, transfer and matrix, limited range. The encoder
is handed full-range sRGB and writes limited-range BT.709, which is what an
H.264 file is supposed to say.

**So there is no export colour path either.** There is the colour path, and this
is one more thing that already sits in it.

---

## What follows

1. **Decode is free and seeking is not.** Scrubbing is a decoder kept alive and
   fed forward, with a re-seek only for backward or distant jumps.
2. **Tracking is a background job.** 9 to 11 frames per second against 30. It
   cannot live in the render loop and the interface should not pretend it does.
3. **The frame-tensor readback stays where it is for images** and can be removed
   for video by building the tensor on the runtime's own device, which will take
   a `GPUBuffer` input and gives back the same answer bit for bit.
4. **Colour needs nothing, in either direction.** Upload the frame into the
   source texture the way an image is uploaded, write it back out through the
   canvas the composite already renders into, and stop.
5. **A clip export is encoder-bound and several times real time** for a style
   that fits in a frame, and several times slower than real time for one that
   does not. Both need the same interface: progress, and a way to stop.
6. **Capture the canvas.** The alternative costs a millisecond a frame at 1080p
   and a de-padding loop, and buys nothing.
7. **The container writer is bigger than the application.** It gets its own
   dynamic import, and a second container inside it costs twelve bytes.
