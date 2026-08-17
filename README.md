# Rotyl

Select part of an image and transform only that part. Everything else stays byte-identical.

Runs on your machine. Your image is never uploaded — the only thing that crosses
the network is the object model, once, coming to you.

## Running it

```bash
pnpm install
pnpm dev
```

Needs a browser with WebGPU (Chrome/Edge 113+, Safari 26+, recent Firefox).

```bash
pnpm verify   # typecheck, lint, format, unit tests, production build
pnpm e2e      # Playwright, real Chrome
```

## How it is put together

```
src/core/      the engine — no DOM, no framework
src/platform/  browser adapters: decode, texture upload, encode, inference
src/app/       Preact UI
```

`core` never imports from `platform` or `app`. That is enforced by
`tsconfig.core.json`, which compiles `src/core` with `"lib": ["es2023"]` and no
`dom` — so a stray `window` or `HTMLElement` fails the build rather than being
caught in review. The payoff is concrete: every shader is unit-tested by running
it for real through Dawn in Node, with no browser and no mocks.

### The render path

```
source ──┬──────────────────────────────────┐
         │                                  │
         └─► style chain ──► styled ──┐     │
                                      ▼     ▼
                        composite: mix(source, styled, mask)
                                      ▼
                               ┌──────┴──────┐
                          export file   display pass
                                        (view + overlay)
```

Three things follow from this shape:

**Unselected pixels are untouched.** The composite is the only pass that reads
the mask, and `mix(source, styled, 0)` returns the source value exactly. Source
textures are sampled through an sRGB view and the composite writes through one,
so the hardware does the decode and encode and the byte round trip is exact.

**Export is not a second code path.** It is the same renderer with the same
parameters, stopping at the same pass. The selection overlay lives in the
display pass, which export never reaches, so a UI affordance cannot leak into a
saved file.

**Boundaries have no seam.** Every stage before the composite runs over the
whole image. Masking earlier would be cheaper but wrong: a style's kernels
sample well outside their own pixel, so pixels just inside the selection would
be computed from zeroed neighbours and draw a halo.

### A style is a texture and a mix

Nothing outside `src/core/style` knows what a style does. One declares its
controls as named values in 0..1 and turns the source into a styled texture at
output resolution; the compositor blends it through the mask and knows nothing
else. The UI builds its sliders from the declaration, so a style is a directory
and a line in `styles.ts` — the engine, the export path, the composite and the
panel are untouched.

**Comic** flattens with an anisotropic Kuwahara filter, finds contours with a
flow-based difference of Gaussians along the structure tensor, then quantises to
cel bands and multiplies the ink over them. Nineteen passes over three
differently-sized buffers.

**Print** separates the image into four ink densities and screens each one at
its own angle, over warm paper, slightly misregistered. Three passes, only the
last at output resolution.

They share the colour maths, a box downsample and the shape of a fullscreen
pass, and nothing else. That is the test: the second style landed without a line
changing in the compositor, and both are held to the same contract by the same
harness in `test/style-harness.ts`.

### Resolution is derived, not configured

Both styles have a characteristic length — a Kuwahara radius, a screen pitch.
Written the obvious way that length is a pixel count which must grow with
resolution to keep the look constant, and cost then grows with the _fourth_
power of resolution.

So it is inverted. Each stage declares the apparent scale it wants as a fraction
of the image, and its buffer resolution is _derived_ to hold that scale. Cost
becomes linear in pixels, "more detail" buys resolution rather than kernel
width, and a coarser halftone costs less rather than more — a screen carries no
detail below its own cell, so the buffer feeding it shrinks as the dots grow.

Because every length is a fraction of the image and never of the output buffer,
preview and export compose identically. That is a property of the two parameter
modules alone, and it is tested in each of them exactly, across every output
size and quality tier.

### The selection is a command log

Strokes, not pixels, are the source of truth. Replaying the log rebuilds the
mask, which makes undo, redo, and export-at-a-different-resolution the same
operation, and means no edit ever costs a full-resolution snapshot. Stroke
coordinates and radii are in source pixels, so a brush edge exported at 6000 px
is the shape that was drawn rather than a magnified approximation.

`applyMask` is the one route by which a mask produced outside the brush can
reach the renderer, and it is how object selection connects — deliberately, and
undoably.

It is also what makes a lost graphics device survivable. Everything the renderer
owns belongs to one `GPUDevice` and dies with it; the log belongs to the work
and does not, so the document is created outside the engine and handed to each
one in turn. A loss costs the decoded pixels, which are read from the file
again, and nothing else: a new device, a new engine around the same log, the
image re-uploaded, and the view carried across so the canvas comes back where it
was. Three rebuilds inside a minute is a driver that will keep doing it, and
that is the point at which it says so rather than looping.

## Selecting an object

Click one with the Object tool and the whole thing is selected. Shift-click adds
another region to the same object; Alt-click carves one away. Dragging pans, so
there is no modifier to learn for the common case.

Or draw around it with the Box tool. A box says something a click cannot — where
the thing _ends_ — which makes it the better prompt for anything without an
unambiguous middle. It composes with clicks rather than replacing them: draw a
box, switch back to the Object tool, and Alt-click whatever it caught by
mistake. Drag is the box, so Shift-drag pans there, as it does in the brushes.

A segmentation model (EdgeTAM) runs on your machine, in the browser. The first
use downloads it, about 16 MB compressed for the runtime and 20 MB for the
weights, and caches both; after that it is offline. Your image is never sent
anywhere — the only thing that crosses the network is the model coming to you.

Three things about the shape of this are load-bearing.

**What the system understands is not what it draws.** Reading the frame is
expensive and happens once; answering "which object is under this point" is
cheap and happens per click. Each prompt returns three candidates — usually the
same click read as a part, a whole and a group — and `PerceptionStore` keeps all
of them while the renderer is told about exactly one, through an ordinary
undoable command. Nothing in the perception layer can touch a mask texture.

**The click was ambiguous, so the answer is a choice.** A point on a sleeve is a
cuff, a shirt and a person, and the model says so. The alternatives appear under
the prompt as their own silhouettes — the arrow keys reach them too — and taking
one _replaces_ the command rather than stacking another, so changing your mind
about which object you meant costs one undo rather than two.

They are offered smallest first, which is the axis a person chooses along;
confidence decides only which is drawn first, because nobody can see it. Two
readings that agree to within a tenth are one reading, and are shown as one:
three buttons that do the same thing imply a choice that is not there. And the
thumbnails share a single crop rather than each framing itself, since three
silhouettes at three magnifications would destroy the one comparison being
offered.

**A 256 px mask is not a boundary.** The model answers at 256 px square whatever
the photograph is, so on a 4000 px image its edge is wrong by a dozen pixels
before anything else happens, and magnifying it cannot help: a nearest tap
staircases and a bilinear tap gives a sixteen-pixel ramp following the mask's
own grid. So the boundary is _reconstructed_ from the image with a guided filter
(He, Sun and Tang) whose guide is the photograph in Oklab — three channels, not
luminance, because two regions of equal lightness and different hue are exactly
the case a scalar guide cannot see. Measured on a synthetic edge, in image
pixels:

| engine error | 1 texel | 2    | 3    | 4    | 6    |
| ------------ | ------- | ---- | ---- | ---- | ---- |
| magnified    | 3.5     | 7.5  | 11.5 | 15.5 | 23.5 |
| refined      | −0.5    | −0.4 | 4.6  | 11.0 | 21.8 |

The window spans about six engine texels, which is what sets where that gives
out. The filter runs during replay rather than once, so the command log holds
the model's own 256 px answer, 64 KB, and export reconstructs the
boundary against the full-resolution image rather than magnifying a preview's.

## Video, so far

Open an MP4 or a MOV and the timeline appears. Scrub it and every frame goes
through the same renderer a photograph does: the same style chain, the same
composite, the same selection. Tracking does not exist yet, so a selection
belongs to the frame it was made on.

**There is no such thing as decoding frame N.** There is decoding from the
keyframe at or before N and discarding what comes between, so what a scrub costs
is set by keyframe spacing and by nothing else. Measured on 1080p30: the next
frame costs 0.46 ms, a seek costs 12 ms on a clip with one-second keyframes and
88 ms on the same content with a single keyframe. That one fact is the whole
design of the frame provider — one decoder is held open and fed forward, and it
re-seeks only when the target is behind the playhead or when a keyframe lies
between the two, which is exactly when starting again is cheaper than
continuing.

Frames are addressed by index, and the index is built by walking the container
rather than by dividing a duration by a frame rate. A variable frame rate, or
the two-frame offset an edit list introduces on an ordinary file with B-frames,
would both make "frame 1043" mean something different to the decoder than to the
person who selected it — and eventually to the command log, which is what a
frame index has to be exact for.

**A decoded frame needs no colour path of its own.** It arrives as YCbCr, and
what lands in the source texture is the same sRGB-encoded byte an image decodes
to, within one code on a losslessly encoded probe. The sRGB view downstream then
does the decode in hardware, exactly as it does for a photograph. Writing it
through an sRGB view instead encodes it twice and is wrong by 73 codes at mid
grey, which is the kind of thing that is obvious in a measurement and invisible
in a review.

The demuxer is mediabunny, reached through a dynamic import, so a session that
never opens a video never fetches it. MP4 and QuickTime only: they share one
demuxer, so accepting `.mov` costs 64 bytes, where Matroska is a second demuxer
at 15 KB carrying codecs whose decode has not been measured here.

What decided all of this, and what it cost to find out, is in
`tools/video-bench` — including the two numbers that say tracking cannot live in
the render loop.

## Measured

Apple M3 Pro, Chrome. Medians over repeated runs, GPU-fenced.

|                          | 2 MP   | 12 MP  | 24 MP  |
| ------------------------ | ------ | ------ | ------ |
| brush stroke (composite) | 1.0 ms | 2.0 ms | 3.1 ms |
| brush stamp into mask    | 1.0 ms | 0.9 ms | 1.1 ms |
| full style chain         | 88 ms  | 79 ms  | 119 ms |

The style chain only re-runs when a style control changes, never while brushing
— which is why the numbers that matter for feel are the first two rows. During a
slider drag the chain drops to a draft tier: 8.9 ms at default detail on a 12 MP
image, 27 ms at maximum detail.

Those three rows are the comic style. The print chain has not been timed the
same way; it is three passes against nineteen, and only one of them runs at
output resolution, so it should be well under the comic figures — but that is an
argument, not a measurement.

Object selection, once the model is loaded:

|                                | 1 MP  | 24 MP |
| ------------------------------ | ----- | ----- |
| reading the frame (once)       | 19 ms | 43 ms |
| a click (model plus composite) | 12 ms | 13 ms |

A click is flat because the model always works at 1024 px square; only building
that input scales with the photograph. Refinement adds 2 ms per engine mask to a
mask rebuild at 24 MP, and a rebuild happens once per edit, not per frame.

Video, on an ordinary 1080p30 clip:

|                                  | 1 s keyframes | one keyframe |
| -------------------------------- | ------------- | ------------ |
| walk the container's index       | 1.8 ms        | 1.6 ms       |
| decode the next frame            | 0.46 ms       | 0.46 ms      |
| seek to an arbitrary frame       | 12 ms         | 88 ms        |
| frame onto the GPU               | 0.9 ms        | 0.9 ms       |
| render one new frame, draft tier | 16 ms         | 16 ms        |

The last row is the whole renderer — style chain, composite and display — re-run
because the source pixels changed, which is what every scrubbed frame is. It is
also where the next work is: with nothing selected the styled layer is
multiplied by a zero mask and thrown away, so most of those 16 ms buys nothing.

Bundle: 141 KB of JavaScript (47 KB gzipped), plus 31 KB of subset fonts. Three
runtime dependencies, and two of them are code-split: 36 KB gzipped of inference
runtime that only the Object tool fetches, and 33 KB of demuxer that only a
video fetches.

## Type and fonts

Geist and Geist Mono, SIL OFL 1.1 (see `public/fonts/LICENSE.txt`). Subset to
latin and clamped to the weights actually used — 23.2 KB and 8.1 KB. Regenerate
from the `geist` npm package with:

```bash
fonttools varLib.instancer Geist[wght].ttf wght=300:500 -o _geist.ttf
pyftsubset _geist.ttf --output-file=public/fonts/geist-latin-300-500.woff2 \
  --flavor=woff2 --unicodes="U+0000-00FF,U+2000-206F,U+2122,U+2212" \
  --layout-features="kern,liga,tnum,case,frac,ss03" --no-hinting --desubroutinize
```

Icons are eight Lucide paths inlined into `src/app/icons.tsx` (ISC). A kilobyte
of geometry did not justify a dependency.

## Known limits

- Video can be opened and scrubbed, and nothing else. The command log has no
  frame index, so a selection is not attached to the frame it was made on: scrub
  away and it stays where it was drawn. Tracking does not exist. What is known
  about building it is measured — `tools/video-bench` puts memory attention at
  59 ms a frame on WebGPU and 38 at half precision, which with the encoder and
  the decoder makes a tracked frame around 90 ms, so tracking runs behind the
  playhead rather than in the render loop. The graphs it needs are produced by
  `tools/edgetam-export`, which also demonstrates them holding a mask across ten
  frames, mask-for-mask identical to the PyTorch tracker.
- Video cannot be exported. Export renders one frame, which is the still it
  always was.
- WebM and Matroska are refused, by signature, with a message that says so.
  They are a second demuxer at 15 KB and mostly carry codecs whose decode has
  not been measured here.
- Only one file per session: opening a second means reloading the page. That
  predates video and is more obvious with it.
- The print screen's pitch is a fraction of the image, not a distance in pixels,
  because that is what makes the preview and the export the same picture. At
  100% zoom on a very large photograph the dots are correspondingly large.
- Object selection needs the network once, to fetch the model, and around 36 MB
  of it. The image never leaves the machine; the model has to arrive on it.
- Object selection only ever adds. Alt-click is a negative point — a statement
  about the object, answered by the model — not a subtraction from the mask, so
  removing a region that is already selected is still the eraser's job.
- Object selection runs on the inference runtime's own WebGPU device, not
  Rotyl's: it declines to accept an external one, and asked again against
  1.27.0 it still does — the execution provider's `device` option fails session
  creation whether or not the device is built with the features the runtime
  asks for. The consequence is that the model's input crosses back through
  system memory, 12 MB per image, which is 2.4 ms and not the bottleneck it
  looked like. Its 17 MB of embeddings do not cross, which is the number that
  would have mattered. For video the crossing is avoidable entirely: a
  VideoFrame belongs to no device, so the tensor can be built on the runtime's
  own device, which does take a GPU buffer as an input and returns the same
  answer bit for bit.
- The mask decoder is silently wrong on that runtime's older JSEP backend —
  no error, an all-zero confidence, and a mask of the wrong object — so the
  build is pinned. See `edgetam-engine.ts`.
- Preview is capped at 4096 px on the long edge to bound memory. Export always
  renders at full resolution, so for larger images the preview is a downscale of
  the export rather than identical to it.
- A lost GPU device is rebuilt around, but object selection pays for it: the
  inference runtime's own device goes with ours, so the model is loaded again on
  the next click. Its weights are in Cache Storage, so nothing is re-downloaded.
- Erasing away an entire selection without pressing Clear leaves the selection
  overlay on, because coverage is inferred from the command log rather than read
  back from the GPU.
- Export flattens transparency, matching the preview canvas, which is opaque.
- HEIC is rejected by signature with a specific message, in every browser.
- The unit suite runs shaders through Dawn's Node bindings, which do not survive
  running the full style chain more than once per process, and abort
  intermittently when GPU work is spread across separate cases in one file. The
  GPU tests are scoped accordingly — each such file renders once and asserts
  many times — and browsers have no such limit. Roughly one run in eight still
  aborts under load, with and without those tests.
- The end-to-end suite covers the object tool's interaction but not the model:
  36 MB over the network is the wrong thing to put in a loop that has to be
  reliable. The model path is verified by hand in a browser.
