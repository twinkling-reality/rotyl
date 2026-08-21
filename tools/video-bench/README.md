# video-bench

The measurements video was waiting on, and the harness that took them.

**Nothing in Rotyl uses this.** It exists for the same reason `edgetam-export`
does: it answered questions that decide an architecture, and a number nobody can
reproduce is worth about as much as a guess. Everything below was capable of
forcing a different design when it was asked, and every one of them now has an
answer that can be re-taken on other hardware in one command.

## Running it

```bash
./tools/video-bench/make-clips.sh          # ffmpeg + node, writes clips/
pnpm dev --port 5180                       # in another shell
node tools/video-bench/run.mjs all         # real Chrome, headed
```

`run.mjs all` takes the seven that need a GPU and a clip, and it takes any
subset of them: `readback`, `ort-device`, `attention`, `bank-rampup`,
`half-precision`, `decode`, `colour`, `shared-device`. `run.mjs export` takes
the two that put a style chain under an encoder, `encode` and `encode-colour`,
and writes `results-export.json`. They are apart because the export ladder is
the only thing in here whose answer depends on what a STYLE costs, so a change
to a style makes it stale and makes nothing else stale: taken together, the run
that re-timed a comic chain also re-timed an ONNX session and a readback ladder
that had not moved, and the diff was forty numbers of noise around the one that
had changed. Seven more measurements sit outside both runs and write their own
files, because they share nothing with either and re-taking one of them should
not re-date every figure it would otherwise have landed beside. The bundle sizes
need a build and no browser: `node tools/video-bench/bundle-size.mjs`. The
command log needs neither, since it is arithmetic over a data structure:
`node tools/video-bench/run.mjs log`. What the same log costs once it has to
become a file needs neither either, and has a command of its own so that
re-taking one of the two does not re-date the other:
`node tools/video-bench/run.mjs document`. What ONE MORE optional field on a
command costs is a third of the same kind, kept apart from the second in
particular: `node tools/video-bench/run.mjs occlusion`. A tracked frame needs a dev server
started with `VITE_TRACKING_HOST` pointing at the two graphs, which most
machines will not have: `node tools/video-bench/run.mjs tracked-frame`. And how
long a clip export can be takes twenty minutes and ends by running the tab out
of memory, which is the measurement rather than a hazard of it:
`node tools/video-bench/run.mjs long-clip`. And where the sound goes in a file
needs no GPU at all, answering a question about byte layout that shares nothing
with a timing: `node tools/video-bench/run.mjs interleave`. The clips are
gitignored, `results.json`, `results-export.json`, `results-bundle.json`,
`results-log.json`, `results-document.json`, `results-tracked-frame.json`,
`results-long-clip.json`, `results-occlusion.json` and `results-interleave.json` are not, and the graphs come from
`tools/edgetam-export`. `export.py` for the pair, then `half_precision.py`.

**Nothing under `src/` may be edited while a run is going.** The dev server
hot-reloads the page underneath it, which arrives as "the execution context was
destroyed" and reads exactly like the out-of-memory crash `long-clip` is looking
for. Two runs of that measurement were lost that way before it was written down.

Real Chrome and headed, for the reason `playwright.config.ts` gives: bundled
Chromium falls back to SwiftShader, which reports success while producing
different pixels and entirely different timings.

**Every GPU number below is fenced with `queue.onSubmittedWorkDone()` on the
device that did the work**, and `mapAsync` is awaited. `requestAnimationFrame`
appears nowhere: it throttles when the pane is hidden, which silently turns a
3 ms number into a 16 ms one. Medians of 15 to 30 runs after warm-up, on an
Apple M3 Pro (Mac15,7, 18 GB) under Chrome 151, adapter `apple / metal-3`.

**Fourteen findings, each with the command that re-takes it:**

1. [The 12 MB readback does not bind](#1-the-12-mb-readback-does-not-bind-and-it-is-avoidable-anyway)
2. [Memory attention is 60 ms](#2-memory-attention-is-60-ms-and-38-at-half-precision)
3. [Decode is 71× real time](#3-decode-is-71-real-time-the-only-cost-is-seeking)
4. [A decoded frame needs no colour path](#4-a-decoded-frame-lands-in-the-existing-colour-contract-unchanged)
5. [The export pipeline is 5 ms a frame](#5-the-whole-export-pipeline-is-5-ms-a-frame-and-almost-all-of-it-is-the-encoder)
6. [Writing a container costs nearly as much as the application](#6-writing-a-container-costs-nearly-as-much-as-the-whole-application)
7. [The encoder is not what moves colour](#7-the-encoder-is-not-what-moves-colour)
8. [A tracked clip does not fit in the command log](#8-a-tracked-clip-does-not-fit-in-the-command-log-and-the-fold-is-not-why)
9. [A tracked frame is 135 ms, and the sum said 90](#9-a-tracked-frame-is-135-ms-and-the-sum-said-90)
10. [Ten minutes was never the problem, and twenty was](#10-ten-minutes-was-never-the-problem-and-twenty-was)
11. [Sound in one run is not a file anybody can stream](#11-sound-in-one-run-is-not-a-file-anybody-can-stream)
12. [Ten minutes of tracking is a 65 MB file that writes in eleven milliseconds](#12-ten-minutes-of-tracking-is-a-65-mb-file-that-writes-in-eleven-milliseconds)
13. [One more optional field on a command is 14 bytes](#14-one-more-optional-field-on-a-command-is-14-bytes-where-it-is-true)

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

## 2. Memory attention is 60 ms, and 38 at half precision

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
either precision, so the size buys the download rather than the startup.

**And deduplicating the rotary tables is the larger win, as predicted.** The
same graph with the tracer's duplicated tables shared is 24.0 MB, and 12.0 MB
with half precision as well. It runs in 58.0 ms against 57.7 for the graph it
came from and produces identical outputs, so a tensor read from six places
costs this backend nothing. `tools/edgetam-export/shrink.py` does it and says
why the obvious version of it finds nothing to share.

### What a tracked frame costs

Summed from parts measured separately on this machine:

| vision encoder | memory attention | mask decoder | memory encoder | total      |
| -------------- | ---------------- | ------------ | -------------- | ---------- |
| ~20 ms¹        | 60 ms            | ~13 ms¹      | 19 ms          | **112 ms** |
| ~20 ms         | 38 ms (fp16)     | ~13 ms       | 19 ms          | **90 ms**  |

¹ from the research site's object-selection figures; the encoder always works at
1024² so it is nearly flat in frame size.

**That is 9 to 11 tracked frames per second against 30 for playback.** Tracking
cannot be a render-loop activity, and no amount of tidying makes it one. It runs
behind the playhead, or ahead of it, and the interface has to be honest that a
mask arrives after the frame does.

**The end to end exists now and it is 135 ms rather than 90**, which is
[measurement 9](#9-a-tracked-frame-is-135-ms-and-the-sum-said-90). The
conclusion in the paragraph above survives and gets firmer; the arithmetic in
the table above is what was incomplete, because summing four graphs counts only
the four graphs.

---

## 3. Decode is 71× real time; the only cost is seeking

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

The current application bundle is 51.9 KB gzipped, so this is not
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
| decode the frame and upload it           | 1.2     | 1.4     |
| + the style chain and the composite      | 2.7     | 3.1     |
| + capture the canvas as a frame          | 2.3     | 3.0     |
| + our own `VideoEncoder`, packets binned | 2.7     | 4.8     |
| + write them into an MP4                 | **2.7** | **5.0** |
| the library driving the encoder as well  | 2.8     | 5.3     |

**The encoder is the pipeline.** The encoder handed the same picture with the
GPU taken out of the loop entirely measures 4.7 ms a frame at 1080p, against
5.0 for everything, and 2.6 at 720p against 2.7. Every rung below it runs on threads the encoder is not
using, so the ladder does not add up, and that is the finding rather than an
artefact: at 1080p with a cheap style there is no point optimising anything
except the encoder.

Which makes a clip export **6.7 times real time at 1080p and 12 at 720p**, per
style:

| end to end, export tier | 720p             | 1080p            |
| ----------------------- | ---------------- | ---------------- |
| poster                  | 2.7 ms (375 fps) | 5.0 ms (202 fps) |
| print                   | 2.7 ms (367 fps) | 5.1 ms (198 fps) |
| comic                   | 36 ms (28 fps)   | 143 ms (7 fps)   |

The comic chain is the style-cost table again with an encoder underneath it that
it never has to wait for. A minute of 1080p through it is a little over two
minutes of work, which is why an export still has to be stoppable and has to say
how far it has got. That row was 117 ms and 339 until the comic style's flatten
was bounded a root two below the picture, which is a change made for temporal
stability and paid for the cost table as well; see `tools/style-bench`
measurement 6.

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
bitrate the two produce byte-identical file sizes and differ by 5%. The figure
is 0.29 ms on the run above.

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

| what was asked for        | ms/frame | file    | rate        |
| ------------------------- | -------- | ------- | ----------- |
| `high`, as a quantizer    | 5.3      | 8.77 MB | 23.4 Mbit/s |
| `high`, as a bitrate      | 5.3      | 2.33 MB | 6.2 Mbit/s  |
| `very-high`, as a bitrate | 5.2      | 4.41 MB | 11.8 Mbit/s |
| 12 Mbit/s, stated         | 5.2      | 4.57 MB | 12.2 Mbit/s |

**Nearly four times the file for no time at all.** The default is the quantizer,
so a clip export that says nothing about rate control ships the first row. Rotyl
asks for `very-high` as a bitrate, which is the third. The first row is the one
figure here that is not repeatable to the tenth: a quantizer is constant QUALITY
and what that costs in bits is the picture's, so the same three seconds came
back at 30.0 Mbit/s on one run and 23.4 on another. The three bitrate rows agree
to a hundredth of a megabyte between runs, which is the point of them.

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

## 6. Writing a container costs nearly as much as the whole application

Through Rotyl's own build, so the answer is what this bundler's tree shaking
actually produces. `node tools/video-bench/bundle-size.mjs`:

| what the module does                  | raw      | gzip    |
| ------------------------------------- | -------- | ------- |
| read MP4                              | 144.8 KB | 35.2 KB |
| read MP4 and QuickTime                | 145.1 KB | 35.2 KB |
| read MP4, QuickTime and Matroska      | 211.2 KB | 49.4 KB |
| write MP4, from packets               | 134.6 KB | 31.8 KB |
| write MP4, encoding as well           | 211.8 KB | 49.8 KB |
| write MP4, and copy a soundtrack in   | 212.5 KB | 49.9 KB |
| write MP4 and QuickTime               | 211.9 KB | 49.8 KB |
| write MP4 and Matroska                | 248.9 KB | 58.3 KB |
| read MP4 and QuickTime, and write MP4 | 335.1 KB | 78.0 KB |

The three numbers that decide the design:

- **Writing costs 42.8 KB gzipped on top of a chunk that already reads**, which
  is nine tenths of the entire application bundle, and was all of it until the
  chapter that let a selection be saved. So
  the writer is its own dynamic import, fetched by an export and by nothing
  else, the same treatment the demuxer and the model get.
- **A second container to write costs 11 bytes.** QuickTime is the same muxer
  with a different brand list, exactly as it is on the read side. Matroska costs
  8.5 KB, because it is not.
- **And a soundtrack copied across costs 146 bytes**, which is one more source
  and one more track on a muxer already paid for. The real build agrees: the
  export chunk went from 33.32 KB gzipped to 33.47 when audio was carried
  through, and what this chapter cost the application bundle, which is the range
  and the interface around it rather than anything to do with the container, is
  1.1 KB.
- **The encoder wrapper is 18.0 KB of the 49.8.** Driving `VideoEncoder`
  directly and piping packets in would save that and cost 5% a frame. Inside a
  chunk only a clip export fetches, 18 KB does not buy back codec-string
  construction, backpressure, flush ordering and getting the decoder config into
  the muxer's first packet.

**Both write rows carry both targets**, which they did not when this table was
first taken, and that is why the write half of it is 1.2 KB larger than it was.
A clip export writes into a file handle where the browser can give one and into
a buffer where it cannot, so a measurement of the writer that carried only one
of them would be a measurement of a chunk nobody ships. The packets-only row
carries both as well, so the encoder wrapper is still the difference between the
two and only that.

These are oxc-minified where the earlier demux figures in this file were
esbuild-minified, which is why reading MP4 now measures 35.2 KB where it
measured 38.1. Same code, different minifier, and it is the comparisons within
the table that the design turns on rather than the absolute numbers.

### What the real build does with it, which is not what the table says

The table above measures each module alone. Shipped, there are two consumers of
one library, and the bundler puts what they share in a chunk of its own.
Gzipped, before the export chunk existed, at the split that made it, and today:

| chunk            | before writing | at the split | today   |
| ---------------- | -------------- | ------------ | ------- |
| the application  | 41.6 KB        | 42.5 KB      | 51.9 KB |
| opening a video  | 33.2 KB        | 42.0 KB      | 42.2 KB |
| exporting a clip | none           | 32.0 KB      | 33.5 KB |

**Opening a video got 8.8 KB more expensive for somebody who never exports one**,
and that is worth stating rather than burying. Chunks are assigned per module,
not per symbol, so a module both halves use lands in the shared chunk carrying
the exports only the writer needs. The alternative arrangements are worse: one
mediabunny chunk makes every video session pay 76.8 KB, and no split at all puts
it in the application.

**The third column is chapters of work since**, not drift: what carrying a
soundtrack cost the export chunk is 0.15 KB, which agrees with the 146 bytes the
table above measures in isolation, and what it cost anyone opening a video is
0.2 KB for the packet cursor. The application's 8.9 KB is everything else those
chapters added, of which 4.8 KB is saving a selection and writing it down as it
is made, 1.1 KB is the export range and the interface around it, and 0.60 KB is
carrying the tracker's occlusion verdict as far as the timeline and the line
that says what a run found. That last figure is split the same way, by building
it twice: 0.38 KB for the fact itself, through the command, the file and the
projection the marks layer is drawn from, and 0.22 KB for saying what a run
found when it is over, which is nearly all sentence.

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

## 8. A tracked clip does not fit in the command log, and the fold is not why

Tracking contributes one `applyMask` command per frame it has followed the
object to. That needs no new command type, which is the point of the log, and it
was worth asking what it costs before building on it.

**The fold is not the problem.** `commandsForFrame` filters and sorts the whole
log on every frame, which is free at ten commands and could plausibly have been
a per-frame cost at ten thousand. Measured: 0.3 ms for eighteen thousand
commands, against a 33 ms frame. That objection is dead.

**The bytes were.** A mask at the engine's own 256 px square is 64 KB held
plainly, so ten seconds was 20 MB and ten minutes 1.2 GB. That is the wall a
clip export already meets, arriving sooner.

**Coverage is nearly binary and packs like it.** So the log stays the source of
truth and the mask changed shape, which is a change to one interface rather than
to the document model. Ten minutes is 62 MB.

| a mask 256 px square      | packed  | against 64 KB |
| ------------------------- | ------- | ------------- |
| a smooth silhouette       | 2.7 KB  | 23.7×         |
| a ragged one              | 4.2 KB  | 15.4×         |
| a boundary 6 texels wide  | 5.4 KB  | 11.8×         |
| a boundary 16 texels wide | 10.0 KB | 6.4×          |

**What costs it is a wide boundary, not a ragged one**, and that is the sweep
worth having rather than the one this file started with. The cost is the
perimeter and not the area, so a coastline is barely dearer than a circle. A
SOFT perimeter is a wider one, and `edgetam-engine.ts` maps its decision
boundary to clearly-decided across the whole range on purpose, so a confident
edge crosses it inside a texel and a region the model is unsure about never
leaves it.

**Which is what decided the encoding.** PackBits, a control byte and then either
a repeat or a run of literals, against the obvious alternative of pairs of a
value and a length. On a crisp boundary the two are the same size to within a
tenth of a per cent, so the realistic case does not choose between them. The
soft one does, 11.8 times against 9.2, and so does the bad case: pairs double a
mask that alternates every pixel where PackBits cannot add more than one byte in 128. An unbounded bad case is a poor thing to put in the one structure the
document cannot rebuild.

**And packing has a price on the way out, which is where the second change came
from.** A replay unpacks every mask the frame folded to, and 10.5 ms of a 33 ms
frame goes on three hundred of them before any reaches the GPU. So the fold now
cuts at the last command that decides the frame by itself, a clear or a mask
applied with `replace`, since everything before one of those is discarded by it.
A tracked run writes `replace` on every frame it reached, so three hundred
commands fold to one, and so do eighteen thousand.

The cheap alternative to all of it, one command a second with the hold-forward
rule covering the gap, is 2.1 MB packed and is still the wrong trade: the gap it
leaves held is exactly the drift tracking exists to remove.

The numbers are on `/research/tracking.html`, out of `results-log.json`. What
the OTHER projection over the same log costs, which is the one the timeline is
drawn from, is [measurement 14](#14-one-more-optional-field-on-a-command-is-14-bytes-where-it-is-true):
it is kept there rather than here because measuring it here re-took, and moved,
the compression figures above.

---

## 9. A tracked frame is 135 ms, and the sum said 90

Measurement 2 added four graphs together and said plainly that nothing had been
run end to end, because there was nothing to run. There is now, so this drives
the product's own code: `loadEdgeTamEngine`, `loadEdgeTamTracker`, `VideoScene`
over a real `FrameProvider`, and `runTracking` writing into a real
`SelectionDocument`. Nothing in it is reimplemented here, which is the point.

Medians of 23 tracked frames, one seed unless the row says two:

| a tracked frame          | 720p      | 1080p     |
| ------------------------ | --------- | --------- |
| one object               | **134.5** | **134.7** |
| two objects              | 225.4     | 225.7     |
| a second object, derived | 90.9      | 91.0      |
| reading the frame        | 43.6      | 43.7      |

**Seven tracked frames a second, not nine to eleven.** Which changes nothing
about the design and settles it harder: playback is 30 and this is 7, so
tracking is a job, and no amount of tidying makes it a render-loop activity.
Frame size does not enter into it, as predicted: the vision encoder always works
at 1024 square, and 720p and 1080p differ by two tenths of a millisecond.

**The split is derived rather than timed, and that is not fussiness.** A run has
two seams and both are easy to put a stopwatch on, and the two numbers that come
back do not add up to a frame: the segmentation engine asks for `gpu-buffer`
outputs, so its `run` returns before the GPU has finished and reading a frame
measures 7 ms, with the rest of the encoder's cost landing in the next thing
that asks for those outputs. A second tracked object is exactly one more advance
and not one more read, so the difference between one object and two IS an
advance and what is left over IS the read. Both are fenced by construction.

**So a second object costs 91 ms and the frame it shares costs 44.** The claim
that reading the frame is the expensive half and does not scale with objects is
right about the mechanism and wrong about the half: reading is a third of a
frame and advancing is two thirds. Sharing it saves 44 ms per frame per extra
object, which is 20% rather than the 50% "the expensive half" implies.

### Where the missing 45 milliseconds are, and it is not a graph

| the arithmetic between the graphs | per call | per frame |
| --------------------------------- | -------- | --------- |
| `toChannelMajor`                  | 5.5 ms   | ×2        |
| `toTokenMajor`                    | 2.5 ms   | ×1        |
| `atMemoryResolution`              | 2.8 ms   | ×1        |
| `maskForMemory`                   | 1.6 ms   | ×1        |
| **total, per tracked object**     |          | **17.9**  |

Five passes over a million elements of JavaScript each, none of which is a model
and none of which was in the sum. With the three graphs an advance runs at
38 + 19 + 13 = 70, plus 18 of arithmetic and a 4 MB readback of the conditioned
map, which is 91 to within the noise. **The sum was not wrong about the graphs.
It was a sum of graphs, in a frame that is a third something else.**

`toChannelMajor` runs twice because attention answers token-major and both the
memory encoder and the mask decoder want the other way round. One of those two
is avoidable: the memory encoder's input is the encoder's own layout with the
no-memory embedding off, which is an elementwise subtract rather than a
transpose, and it is being reconstructed from a transpose of itself. It is 5.5
ms of 135, so it is written down here rather than done.

**`visionPositionEncoding` is 4.8 ms and runs once a session**, not once a
frame. That is the whole of what computing four megabytes rather than shipping
them costs, against a third of the shared attention graph's download.

```bash
VITE_TRACKING_HOST=... pnpm dev --port 5180
node tools/video-bench/run.mjs tracked-frame
```

It needs a tracking host, which is why it is out of `all` and writes its own
file: the two graphs are in no published release, so most machines have nowhere
to fetch them from and would leave an error where every other number is.

---

## 10. Ten minutes was never the problem, and twenty was

`docs/limits.md` said a clip export was built in memory and that "a ten-minute
one would be closer to a gigabyte, and this has no answer for that beyond
failing". The consequence was right and the number was a guess, and a guess is
what this measurement went to replace: a tab that dies is a different problem
from one that swaps for four minutes and finishes, and the two want different
answers.

It drives the product's own loop, `runExport` with the shipping `clipSink`, over
a source that hands the same ten-second clip round again with monotonically
increasing timestamps. The pixels repeat and the packets do not: the encoder is
given real frames at the export's own bitrate, so the bytes that pile up are the
bytes an export of that length piles up. One thing here is not the product's
code, and it is the thing being compared against: the sink that shipped BEFORE
this chapter, which held every encoded packet until the end. It no longer exists
to import, so it is reproduced in `long-clip.ts`.

```bash
node tools/video-bench/run.mjs long-clip
```

Twenty minutes, its own results file, and out of `all`: the ladder ends by
running the tab out of memory, which is not a thing to do in the middle of a run
with nine other measurements left to take.

### The ladder, and where it stops

1080p30, poster, export tier, against the sink that shipped before this chapter.
Every rung is a complete export of that many minutes of footage.

| minutes | file    | heap while writing | peak heap | peak ÷ file | finalize |
| ------- | ------- | ------------------ | --------- | ----------- | -------- |
| 5       | 414 MB  | 464 MB             | 1382 MB   | 3.3         | 0.2 s    |
| 10      | 828 MB  | 885 MB             | 2193 MB   | 2.6         | 1.1 s    |
| 15      | 1242 MB | 1305 MB            | 3535 MB   | 2.8         | 2.1 s    |
| 20      | 1656 MB | 1752 MB            | 4361 MB   | 2.6         | 3.4 s    |
| 25      | none    | 2211 MB            | 2211 MB   | none        | failed   |

**Ten minutes works, and the note that said it would not was wrong.** It is
828 MB and it peaks at 2.2 GB against a 4.19 GB heap limit. What fails is
twenty-five minutes, and it fails at finalize, with
`RangeError: Array buffer allocation failed`. Not a dead tab: a catchable error
three and a half minutes into an export, which is the worst possible moment for
one and still better than the alternative.

Three things in that table are the whole design.

**The heap tracks the file, one for one.** Fitted across every rung, the sink
that shipped held 47 MB more per thousand frames written, and a thousand frames
at this bitrate is 46 MB of file. So the ceiling is arithmetic rather than luck:
it is the heap limit divided by what a finished file costs, which is between two
and three times its own size at the moment it is assembled.

**Twenty minutes peaks at 4361 MB against a limit that reads 4192.** So
`jsHeapSizeLimit` is not a wall that external array buffers hit exactly, which
is worth knowing before treating it as one.

**And the finalize column is not the muxer.** With the encoder taken out of it
entirely and 790 MB of synthetic packets pushed straight in, finalizing costs
0.17 s held in memory and 0.07 s with the index reserved. What the last column
measures is a tab with two gigabytes in it being asked for another one, which is
why the same five rungs came back at 0.9, 2.7, 3.6, 18.3 and failed on the run
before this one. The shape is the same and the seconds are not, and neither of
those is a number to design against.

### Into a file, nothing is held

The same loop, the same sink, with a `FileSystemFileHandle` behind it:

| where it went      | minutes | file    | peak heap | peak ÷ file | heap per 1000 frames |
| ------------------ | ------- | ------- | --------- | ----------- | -------------------- |
| a file             | 25      | 2071 MB | 113 MB    | 0.06        | 0.5 MB               |
| a file, with sound | 25      | 2096 MB | 121 MB    | 0.06        | 0.2 MB               |
| a file             | 10      | 829 MB  | 110 MB    | 0.13        | −0.3 MB              |
| memory             | 10      | 829 MB  | 1992 MB   | 2.40        | 68.2 MB              |

**The last column is the finding.** Writing into a file grows the heap by a
fraction of a megabyte per thousand frames, which is the noise of a decode loop
rather than a trend, and one rung fits a NEGATIVE slope, which is the same
statement said more bluntly. There is no ceiling to quote because there is
nothing accumulating to hit one.

**And it costs nothing per frame.** 5.0 ms a frame at 1080p into a file, which
is the 5.0 the encode ladder committed to and is the encoder's own cost with
everything else disappearing into the threads it is not using. An earlier take
of this row read 4.8; re-taken it reads 4.97 and 4.99, so the two figures agree
to a hundredth of a millisecond and the earlier gap was the machine.

**A soundtrack changes neither, which is the row this measurement gained.** The
first two rows are the same twenty-five minutes with and without one: 4.99 ms a
frame against 5.00, and 121 MB of peak heap against 113 on a file that is 25 MB
larger. The eight megabytes are the second track's sample table in the reserved
index, which is a fact about the index rather than about the length, and the
slope stays at noise. 70,349 packets went in, counted at the sink.

**That count is there because the first run of this rung wrote none.** The
wrapper this measurement puts around the sink to watch the heap was written
before `acceptAudio` existed and forwarded `open`, `accept`, `finish` and
`cancel` and nothing else. The export loop reads `sink.acceptAudio` to decide
whether sound can be written at all, so the rung asked for a soundtrack, was
told the sink could not take one, and produced a file identical to the row above
it to the megabyte. That is exactly the failure the chapter it was added for
exists to stop, committed by the harness measuring it. So the field is an
observation rather than the prediction it used to be, and a rung asked for sound
that writes none now throws rather than reporting a number.

The twenty-five minute row counted its bytes and threw them away rather than
keeping them, and that is the harness's limit rather than the export's. The
origin private file system is what stands in for a save dialog here, since
Playwright cannot drive a native one, and it has a quota a real disk does not:
`estimate()` reports three gigabytes and a write fails just past one, with and
without `mode: 'exclusive'` and with durable storage granted over CDP. So the
long rung isolates the export from the disk and the ten-minute rung writes a
real file and reads it back. Neither answers the other's question and both say
which one they are answering.

**Read back, the ten-minute file is a clip.** 18,000 frames, 599.99 seconds, 600
keyframes, first and last decoded through the product's own `FrameProvider`, and
its boxes are `ftyp`, `moov`, `free`, `mdat` in that order. The index is at the
front, which a stream target does not do by default and which is why the room
for it is reserved before the first frame and seeked back to at the end. The
`free` box is what the reservation over-estimated by, and it is under a megabyte
on an 829 MB file.

### What a download can be handed, which is not unbounded either

A browser with nowhere to write ends by handing the browser a blob. Asked for
one byte back, in a clean tab, one size at a time with the buffer dropped and
the heap collected first:

| blob    | made | one byte read back |
| ------- | ---- | ------------------ |
| 128 MB  | yes  | yes                |
| 256 MB  | yes  | yes                |
| 512 MB  | yes  | yes                |
| 768 MB  | yes  | yes                |
| 1024 MB | yes  | yes                |
| 1536 MB | yes  | yes                |
| 2048 MB | no   | `RangeError`       |

**In a clean tab that is fine, and it is not the state a finished export leaves
the tab in.** Holding the buffer the file was assembled in AND the blob made
from it, which is exactly what the sink does at the moment it hands one over, a
790 MB blob comes back `NotReadableError` on every attempt. As a download that
is a file that never arrives and no word about why, which is why the download
path asks for one byte before handing the blob to an anchor: the answer can then
be a sentence.

### So the in-memory path stops at a budget

Four times the file is what has to fit at the moment it is finished: up to twice
in the buffer it is assembled in, since that buffer grows by doubling, once more
for the copy sliced out of it, and once more for the blob. So the budget is the
heap limit over four, which is 1048 MB here.

Asked for thirty minutes with nowhere to write it, the export stops at 12.6
minutes and 1049 MB, peaks at 3182 MB, and produces `ftyp`, `moov`, `free`,
`mdat`: a valid clip of the part that was rendered, which is the same thing
pressing Stop produces and for the same reason.

**It is not a guarantee and nothing can make it one.** How much a tab can hold
depends on what else the machine is doing: the blob table above was taken twice
an hour apart and read a gigabyte and a half the first time and refused half of
that the second, with a browser that had been running exports in between. What
the budget buys is that the common case ends in a file rather than in a dead
tab.

---

---

## 11. Sound in one run is not a file anybody can stream

A clip that arrived with a soundtrack left without one, and `docs/limits.md`
argued the principle and then described the opposite of what happened: "a clip
that silently dropped a soundtrack it had been given would be worse than one
that never had it". It was given one, and it dropped it, silently.

**What audio passthrough costs was never the question worth measuring.** Copying
packets that are already encoded costs nothing and everybody knows it. What
nobody here had measured is INTERLEAVING, and it decides whether
[measurement 10](#10-ten-minutes-was-never-the-problem-and-twenty-was)'s central
commitment was real. The index goes at the front so a file starts playing before
it has finished arriving, and a file whose video is one contiguous run and whose
audio is another satisfies that on paper and violates it completely in practice:
a player has to hold the whole video to reach the first audio sample.

```bash
./tools/video-bench/make-clips.sh          # 1080p30-aac.mp4 and 1080p30-ulaw.mov
node tools/video-bench/run.mjs interleave
```

It writes the same clip three ways and asks, for every whole second of it, how
far away in the file the sound that plays with that second is. Both tracks are
passed through as encoded packets with no encoder anywhere in it, which is what
a clip export does with audio and is also what isolates this from
[measurement 5](#5-the-whole-export-pipeline-is-5-ms-a-frame-and-almost-all-of-it-is-the-encoder):
what is being laid out here is the muxer's arrangement of bytes.

### The cheapest arrangement does not produce a file at all

Adding every video packet and then every audio packet fails, at every length,
before a byte is written. With `fastStart: 'reserve'` the muxer cannot size the
movie box until it has seen a packet from EVERY track it was told about, so a run
of video with the audio behind it queues every frame in memory, and on a track
carrying B-frames the tentative movie box it builds at that moment asserts
rather than being built. One audio packet in front of the video is what makes
that arrangement exist at all.

**And once it exists, it is not progressive.** The table is on
`/research/sound.html`; the shape of it is that the reach grows one for one with
the file when the audio is gathered at one end, and is a constant when it is
not. Interleaving costs one comparison per frame and the export loop already had
a frame to hang it on.

### Counting the sound before the first frame

`reserve` needs a `maximumPacketCount` on every track, so the number of audio
packets has to be known before anything is rendered. That is a metadata-only
walk of the whole audio track, which reads the sample tables and none of the
payload, and it is about a microsecond a packet: 50 ms for the 56,280 packets in
twenty minutes of 48 kHz audio, linear, paid once, before anything slow.

### The one thing this cannot do, and when it says so

`Mp4OutputFormat` holds eighteen audio codecs and QuickTime holds more, so a
`.mov` with mu-law audio is an ordinary file whose sound has nowhere to go.
Deciding that costs a list lookup on a track that is already open, which is why
it is said while the file is merely open rather than after the encoding. That is
what `1080p30-ulaw.mov` exists for: without a file that provokes it, the branch
that refuses is code nobody has ever run.

### Two things this does not measure, said rather than left out

**Memory does not separate the arrangements.** Both stream, because the muxer
writes each chunk as it closes either way, and what grows is the sample table
`reserve` keeps per track, which both need in equal measure. A heap figure taken
across these rungs reads the packet list the harness built rather than anything
the arrangement decided, so it is left out and this paragraph is why.

**A range does not cut the sound where it cuts the picture.** The packet holding
the in point began before it, and MP4 has no way to say "before zero" except an
edit list this muxer only writes for positive offsets. So the straddling packet
is dropped, which costs at most one packet at the head, 21 ms at 48 kHz against
a 33 ms frame, and leaves every remaining packet at exactly the moment it was at
in the source. An AAC track's own priming packet, which sits at a negative
timestamp and whose samples a decoder throws away, goes the same way and for the
same reason.

---

## 12. Ten minutes of tracking is a 65 MB file that writes in eleven milliseconds

The command log has been the source of truth since the first chapter and had
never been allowed to outlive a tab. What a brush stroke costs to write down is
nothing and everybody knows it. What decides whether saving is a file format or
a paragraph in known limits is what a TRACKED RUN costs, and
[measurement 8](#8-a-tracked-clip-does-not-fit-in-the-command-log-and-the-fold-is-not-why)
put that at 3.4 KB a packed mask and 62 MB held for ten minutes.

```bash
node tools/video-bench/run.mjs document
```

Its own command and its own file, for the ordinary reason: no GPU, no clips,
nothing to fetch, and what a tracked run costs to HOLD and what it costs to
WRITE are two findings answered in two chapters. One file would re-date the
first every time the second moved.

It drives the product's own writer and reader rather than a sketch of them, and
it asserts the round trip before reporting a number: a document that lost a mask
or shortened one would measure beautifully.

### The bytes survive the trip, and so does the time

| a saved selection | commands | the file | building it | assembling the bytes | reading it back |
| ----------------- | -------- | -------- | ----------- | -------------------- | --------------- |
| one stroke        | 1        | 2.3 KB   | under 0.1   | 0.1 ms               | under 0.1       |
| a 300-frame run   | 301      | 1.09 MB  | 0.2 ms      | 0.9 ms               | 0.2 ms          |
| ten minutes       | 18,001   | 65.45 MB | 11.2 ms     | 45.7 ms              | 12.1 ms         |

**65.45 MB against 62.1 MB held, and the difference is the header.** The masks
are the log's own arrays handed to the writer rather than copied into it, so a
save touches every byte once. "Building it" is the header and the chunk list;
"assembling the bytes" is the one pass over all of them through a real `Blob`,
which is what a browser with nowhere to write the file does. Given a file handle
each chunk goes straight into the stream and that column is the disk.

Reading is the whole file back to a command log: the header parsed and every
mask handed back as a `subarray` of the buffer it was read into. No copy
anywhere in it, which is why 65 MB reads in 12 ms.

**None of it is slow enough to need an indicator**, which is the finding that
made everything after it simple. Saving can be an ordinary thing somebody
presses rather than an operation with a progress bar on it.

### The obvious format is a third larger and a hundred times slower

JSON with each packed mask base64 encoded needs no format and no reader at all.
The argument against it was arithmetic, four bytes for every three, which is the
half that decides nothing on its own.

| ten minutes of tracking     | the file | writing | reading |
| --------------------------- | -------- | ------- | ------- |
| a container, masks as bytes | 65.45 MB | 11.2 ms | 12.1 ms |
| JSON, masks base64 encoded  | 85.91 MB | 1090 ms | 160 ms  |

**Ninety seven times slower to write and thirteen times slower to read**, because
every mask has to be built into a string on the way out and taken apart on the
way back. A second of work to press Save is a different product from eleven
milliseconds. So the header is JSON and the payload is not, which is the shape
every honest container has and needs no library either. The alternative is
written out in `document.ts` rather than shipped, which is the rule
[measurement 10](#10-ten-minutes-was-never-the-problem-and-twenty-was) follows
for the sink it compares against.

A third larger is 31.2% here rather than 33%, because the header is the same in
both. On a photograph the JSON is marginally the SMALLER of the two, 2301 bytes
against 2313, since there are no masks at all and a container still pays twelve
bytes of prefix.

### Opening one is a fold and one upload, so the file can be dumb

This is the measurement that decided the SHAPE of the file rather than its
encoding. A document that read quickly and then took a second to become a
picture would have to carry something a replay cannot recompute, which is a
cached mask, which is a second source of truth in the one structure the document
model exists to have exactly one of.

| after loading   | commands | folded to | fold and unpack |
| --------------- | -------- | --------- | --------------- |
| one stroke      | 1        | 1         | under 0.1 ms    |
| a 300-frame run | 301      | 1         | under 0.1 ms    |
| ten minutes     | 18,001   | 1         | 0.3 ms          |

The fold cuts at the last command that decides a frame by itself, and a tracked
run writes `replace` on every frame it reached, so eighteen thousand commands
fold to one. **0.3 ms**, and everything after it is the texture upload the
renderer does on every frame anyway. So the document carries the log and nothing
derived from it.

The fold here runs over the log that came back OUT of the file rather than the
one that went in. A reader that produced commands in a different order, or lost
the frame numbers, would fold to something else and be caught here.

### The whole file cannot be digested, and does not need to be

A browser has no paths, so a document names media it cannot address and somebody
supplies the file again. Whether it is the same file is the only question left,
and a selection replayed over the wrong clip is a wrong answer that looks like a
right one.

| identifying the media       | 2 MB   | 64 MB   | 1 GB   |
| --------------------------- | ------ | ------- | ------ |
| the whole file              | 0.8 ms | 29.2 ms | 516 ms |
| the first and last megabyte | 1.7 ms | 1.7 ms  | 1.9 ms |

**The first row is not available on a real clip, and that is the platform rather
than a budget.** `crypto.subtle.digest` takes a `BufferSource` and there is no
streaming form of it anywhere, so digesting two gigabytes means holding two
gigabytes, which is the exact thing
[measurement 10](#10-ten-minutes-was-never-the-problem-and-twenty-was) rebuilt
the clip sink to stop doing. Where it fits it is linear at 2192 to 2500 MB a
second across every rung from 1 MB to 1 GB, so on a two gigabyte clip it would
be a second of work on top of the whole file in the heap.

**The second row is flat**, which is the finding: two slices and eight bytes of
length whatever the file is. The 2 MB cell for the whole file is the 1 MB figure
doubled rather than a rung of its own; below two megabytes the two slices of the
bounded probe meet and the whole file is digested anyway, which is the strong
answer arriving free on the files small enough to give it away.

What the comparison decides is what happens on a mismatch, and that is two
answers rather than one. The SHAPE, which the loader read anyway, decides
refusal: a file of different dimensions or a different frame count cannot replay
the log at all. The BYTES decide a sentence: a file of the same shape replays
perfectly and may be a re-encode of the same clip, so it opens and says so.
What neither can see is a file agreeing at both ends and in length and differing
in the middle. That is in `docs/limits.md` rather than left implied.

## 14. One more optional field on a command is 14 bytes where it is true

Thirteen is `recovery.ts`, which has no numbered section here and is cited as
measurement 13 from the trials ledger. Taking its number would have made two
pointers resolve to the wrong finding, which is the failure this whole file is
arranged to prevent.

A tracker asks the model, on every frame, whether the object is in it at all,
and a frame it is not in gets an empty mask. That is the reference's own
behaviour and it is right; what it costs is that an empty mask is also what a
selection erased down to nothing looks like, so nothing downstream of the log
could tell a tracker that gave up from a tracker that was asked and answered.
The verdict is a field on the command now.

The fair objection to that is arithmetic, so it is answered with arithmetic. A
document is a JSON object per command with the packed masks in a region behind
it, so a field added to a command is added as many times as there are commands,
and ten minutes of tracking is eighteen thousand of them.

| ten minutes of tracking, as a file | bytes    |
| ---------------------------------- | -------- |
| nothing hidden                     | 65.45 MB |
| hidden 300 frames, not said        | 64.72 MB |
| hidden 300 frames, said            | 64.73 MB |

**The field is the difference between the last two rows and nothing else**: the
same log written twice, one field apart. 300 of the eighteen thousand commands
carry it, at 14 bytes each, 4.1 KB and six thousandths of a per cent of the
file. It is written only where it is true, which is why it is absent rather than
false.

**And it has to be measured that way rather than read off two file sizes**,
because the frames it lands on differ from ordinary tracked frames in a second
way at the same time and in the opposite direction. An occluded frame's mask is
empty, and an empty mask packs to a kilobyte against a silhouette's three and a
half, so the run WITH occlusions in it is the smaller document by 0.72 MB. The
first and last rows compared alone would price the field at better than free.

**A mask of nothing costing a kilobyte is the part that had to be run rather
than reasoned about.** It was written down as three bytes first, on the grounds
that a run length and a value is all an empty picture needs. PackBits caps a
repeat at 128, so sixty-five thousand zeroes are five hundred and twelve repeats
rather than one, and the guess was out by three hundred times. It is still under
a third of what a silhouette costs, which is the claim this makes; it is not
nothing, which is the claim the guess would have made.

### The other projection over the same log, which nobody had priced either

The fold is what the RENDERER asks of the log. The timeline asks something else,
and until this chapter what it asked for was the frame numbers an edit was made
on and nothing else. That is exactly right for a stroke and says the opposite of
what happened for a run: a run is one gesture, `group` has recorded that since
the day tracking landed so that undo could take it back in one press, and the
projection discarded it. It also produced one absolutely positioned element per
entry, so a ten-minute run put eighteen thousand of them on a track six hundred
pixels wide, every one of them saying the same thing.

| a run                       | commands | marks, as it was | joined | the projection |
| --------------------------- | -------- | ---------------- | ------ | -------------- |
| 10 seconds, hidden once     | 300      | 300              | 4      | 0.0 ms         |
| 100 seconds, hidden 3 times | 3000     | 3000             | 8      | 0.1 ms         |
| 10 minutes, hidden 3 times  | 18000    | 18000            | 8      | 1.1 ms         |

Joined along the group a run of any length is two elements, the user's own
command on the anchor frame and the run itself, and each occlusion adds two: the
faint stretch, and the rest of the run after it. So the projection that carries
MORE information draws FEWER things, which is the only reason it needed no
argument about cost. It runs on every render of the editor, which is why it is
timed at all: 1.1 ms at ten minutes of tracking, against the 33 ms frame the
same log is folded inside.

Each occlusion here is two seconds, and how many of them fit is a property of
the clip rather than a setting, which is why the short row carries one rather
than three: three two-second occlusions in a ten-second run is a subject hidden
for most of it, and that is a different measurement wearing this one's clothes.

### Its own command, which is this file's own rule arriving at its own door

`node tools/video-bench/run.mjs occlusion`, and its own results file, for both
halves above. Either would have fitted somewhere else. The file cost is the same
class of question as measurement 12 and shares that measurement's helpers; the
projection is a projection over the command log, which is measurement 8. Both
were written there first and both had to move.

Three documents quote "eleven milliseconds to write and twelve to read" from
`results-document.json`, and taken as a row inside measurement 12 this moved
both of them, to ten and ten, by noise, on a code path nothing in this chapter
touches. Measurement 8's unpacking figure, which three more documents quote,
moved from 10.5 ms to 11.0 the same way. A number nobody changed should not move
because somebody asked a neighbouring question, and topical fit is the argument
FOR folding two measurements together, which makes it exactly the wrong one.

The rest of what it cost, and the argument for where a fact like this belongs at
all, is on `/research/the-occlusion.html`.

## What follows

1. **Decode is free and seeking is not.** Scrubbing is a decoder kept alive and
   fed forward, with a re-seek only for backward or distant jumps.
2. **Tracking is a background job.** Seven frames a second against 30, measured
   end to end rather than summed. It cannot live in the render loop and the
   interface should not pretend it does.
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
   dynamic import, and a second container inside it costs eleven bytes.
8. **A tracked mask has to be compressed, and the log does not have to change.**
   Folding eighteen thousand commands costs 0.3 ms; holding eighteen thousand
   masks costs 1.2 GB, and a run-length encoding of one is a sixteenth of it.
9. **A clip export needs somewhere to put the bytes.** Given a file handle the
   heap does not grow with the length of the clip and there is no ceiling to
   quote; given none it grows one for one with the file and stops at twenty
   minutes of 1080p on this machine. Which browser somebody is in decides which
   of those they get, so it is asked at the click rather than discovered at the
   end.
10. **Carrying sound across is free and putting it in the right place is not.**
    A second track added in one run after the first is either no file at all or
    a file whose sound sits most of the file away from its picture and grows
    with the clip. Interleaved it is a constant, and it costs one comparison per
    frame inside a loop that was already there.
11. **The log fits in a file with room to spare, and the file can be dumb.**
    Ten minutes of tracking is 65 MB, eleven milliseconds to write and twelve to
    read, and folding it after a load is 0.3 ms, so nothing derived has to be
    stored in it. The obvious format, JSON with base64 masks, is a third larger
    and a hundred times slower. The media it names cannot be hashed whole here,
    so a document recognises a file by its shape and by its two ends, and the
    two failures want opposite treatment: a different shape is refused, and
    different bytes at the same shape open with a sentence.
12. **A projection is a decision about what can be drawn, whatever the drawing
    does afterwards.** The timeline was handed the frame numbers an edit was
    made on, so a run of three hundred frames could only ever be three hundred
    separate marks however the marks were styled. Joined along the group it is
    one element and two more per occlusion, at 1.1 ms over eighteen thousand
    commands: more information, fewer things drawn.
13. **One optional field on a command is 14 bytes where it is true.** Written
    only on the frames the model said the object was not in, that is 4.1 KB and
    six thousandths of a per cent of a 64 MB ten-minute document. It has to be
    priced against the same log written without it rather than against a run
    with no occlusions in it, because an occluded frame's mask is empty and an
    empty mask packs to a kilobyte: the second comparison makes the field look
    better than free.
14. **A measurement that shares helpers with another needs its own file more
    than one that shares nothing.** Topical fit is the argument for folding two
    together and it is the wrong one. Adding this row inside measurement 12
    moved that measurement's ten-minute write and read, which three documents
    quote, by noise, on a code path it does not touch.
