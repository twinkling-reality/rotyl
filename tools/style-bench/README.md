# style-bench

What the styles cost, whether they hold still on video, and what they look like.

**Nothing in Rotyl uses this.** It exists for the reason `video-bench` and
`edgetam-export` do: it answered questions that decide a design, and a number
nobody can reproduce is worth about as much as a guess. Three things were
unknown when it was written, and one of the three turned out to be the opposite
of what everyone assumed.

Unlike its neighbours it also writes PNGs, because a style bench that reports
only milliseconds and difference metrics can tell you a chain got faster and
steadier while it got worse to look at.

## Running it

```bash
./tools/style-bench/make-clips.sh          # ffmpeg + node, writes clips/
pnpm dev --port 5180                       # in another shell
node tools/style-bench/run.mjs all         # real Chrome, headed
```

`run.mjs` takes any subset: `chain`, `perturbation`, `clips`, `stills`, `sweep`.
The inputs are gitignored, `results.json` is not, and the pictures land in
`out/`.

Real Chrome and headed, for the reason `playwright.config.ts` gives: bundled
Chromium falls back to SwiftShader, which reports success while producing
different pixels and entirely different timings.

**Every GPU number below is fenced with `queue.onSubmittedWorkDone()`**, medians
of 11 runs after 3 warm-up runs, on an Apple M3 Pro (Mac15,7, 18 GB) under
Chrome 151, adapter `apple / metal-3`. What is timed is the STYLE CHAIN ALONE.
the composite is one pass that re-runs on every brush movement and is timed on
the research site's editor page instead.

**Run it on a quiet machine, and check that it was one.** Taken while the Dawn
unit suite was running, the same chain measured 211 ms where it measures 140,
and the largest case moved by a factor of three. Contention does not add a
constant. `results.json` keeps the min alongside the median for exactly this
reason: on a clean run the two sit within about 5% of each other, and a min far
below the median is the signature of a machine that was busy rather than of a
style that is fast.

## The picture

`make-scene.mjs` draws it, deterministically, with no dependencies. A photograph
cannot be checked in, licensing aside, a benchmark whose input nobody else has
is a benchmark nobody else can repeat, so the scene is synthesised to have the
statistics the chain is sensitive to rather than to look like art: a hazy
desaturated distance, large near-flat regions, hard architectural edges, fine
foliage texture, thin road markings, a few saturated accents, and film grain at
about two codes.

It is deliberately the case the palette exists for. Its lightness has a standard
deviation of 0.136 against 0.23 to 0.29 for every palette in `palette.ts`, which
is the measurement that produced the levels stage; see below.

**What it is not is a photograph.** Real footage has texture statistics no
procedure here reproduces, and the anisotropic Kuwahara's cost in particular
depends on content: its sample bound grows with local anisotropy, so a frame of
architecture costs more than a frame of foliage. Treat the comic figures as a
hard case rather than a typical one.

`make-clips.sh` encodes three clips from it. The one that matters is
`static-720p`: fixed camera, fixed scene, so everything that differs between two
consecutive frames is grain and the encoder's own noise.

---

## 1. Print is not "probably cheaper". It is 200 times cheaper

An earlier version of this project timed the comic chain and said plainly that
the print chain never had been, three passes against nineteen, only one at output resolution,
so it _should_ be cheaper, but that was an argument rather than a measurement.

Median milliseconds, full quality tier, default controls:

| style  | 720p    | 2 MP    | 12 MP | 24 MP |
| ------ | ------- | ------- | ----- | ----- |
| comic  | 140.2   | 116.7   | 121.9 | 124.0 |
| poster | **1.3** | **1.4** | 4.9   | 25.1  |
| print  | **0.5** | **0.6** | 2.0   | 13.0  |

The 24 MP column is the only place the ordering stops being 20:1. Both cheap
styles do all of their deciding in one pass at output resolution, so past about
12 megapixels they are paying for pixels rather than for thinking, and the cost
goes superlinear as the working set stops fitting anything. The comic chain is
flat there for the same reason in reverse: its expensive stage runs on a buffer
whose size is derived from an apparent scale and never grows.

Two things follow, and the second one is the whole reason a third style exists.

**The comic chain is the Kuwahara and nothing else.** Its cost tracks the
flatten buffer's pixel count almost exactly and is nearly flat in output
resolution: 720p costs _more_ than 2 MP, because a 16:9 flatten buffer holding
the same apparent radius is 19% larger than a 3:2 one. Everything at output
resolution, the cel step, the ink threshold, the composite, is single digits.

**A style does not have to be expensive to be flat.** The comic chain spends
120 ms deciding what to smooth. The print chain spends half a millisecond and
reads as more deliberately designed than the comic chain does, because what
makes it look chosen is the four inks and the paper, not the amount of work.

The detail control is where the surprising figures live: higher detail is
CHEAPER when a clamp binds, because the
Kuwahara radius falls, and the quality tiers COLLAPSE when a stage clamps to the
output's short edge. Both reproduce here.

| comic, full tier | 720p  | 2 MP  | 12 MP | 24 MP |
| ---------------- | ----- | ----- | ----- | ----- |
| detail 0         | 48.5  | 46.3  | 46.5  | 48.3  |
| detail 0.5       | 140.2 | 116.7 | 121.9 | 124.0 |
| detail 1         | 55.9  | 229.9 | 397.3 | 400.8 |

At 720p and detail 1 the flatten buffer clamps to 720 and the radius falls to
4.25, so draft, full and export are the same render. 56.9, 55.9, 55.6. At 2 MP
nothing clamps and the same setting costs four times as much.

**The poster chain is a per-frame budget.** 1.3 ms at 720p against a 33 ms
frame. Video playback stops being limited by the style.

## 2. Temporal stability: the assumption was backwards

The worry was that the winner-take-all stages, an anisotropic Kuwahara picking
its most homogeneous sector, a flow-based DoG thresholding a response, would
flip on a pixel one code different between two frames, and that stylised footage
would boil however good a single frame was.

Measured on consecutive frames of a fixed camera, in output codes. `p99` is the
99th percentile per-pixel change and `flicker` the percentage of pixels moving
more than 8 codes, which is plainly visible. **The mean is the least useful
number here**. Boiling is a small proportion of pixels moving a long way.

| static camera | mean | p99      | flicker   |
| ------------- | ---- | -------- | --------- |
| the source    | 2.43 | 9.5      | 3.05%     |
| comic         | 0.92 | **3.2**  | **0.10%** |
| poster        | 0.55 | **4.5**  | **0.52%** |
| print         | 1.39 | **12.6** | **3.01%** |

**No style amplifies its input; every one attenuates it.** The comic chain is a
heavy smoothing filter with a soft cel step, and it removes more grain than its
decisions reintroduce. It makes footage steadier than the footage is. The
hypothesis was wrong, and the reason it was wrong is worth keeping: the Kuwahara
does not decide between two nearly equal sectors on one pixel's noise, it
decides on the variance of two hundred samples.

The same result, isolated from the codec, by rendering one frame twice with
grain of a known size added the second time:

| perturbation | input p99 | comic | poster | print |
| ------------ | --------- | ----- | ------ | ----- |
| sigma 0.5    | 1         | 1     | 1      | 2     |
| sigma 2      | 6         | 3     | 2      | 5     |

**Print is the one that boils**, and predictably: a halftone dot appears or
disappears when the density crosses the spot function, which is a hard threshold
against a fixed screen. 3% of pixels moving more than 8 codes per frame is the
dots twinkling. Nothing here fixes that, and it may not want fixing. A print is
allowed to look like a print.

### What this measurement bought: the floor under a soft transition

Poster's first version quantised hard, antialiased only against `fwidth`. It
measured **p99 23 and 1.7% flicker with no palette, p99 44 with one**, five to
ten times worse than the comic chain, on a still camera.

The cause is exact. Softening a step across one pixel is right for an edge and
useless for a gradient: where the field is nearly flat `fwidth` is nearly zero,
so a band boundary is a step of a whole level driven by a hundredth of one, and
one frame of grain moves it. Putting a floor under the transition width, in
VALUE units, a fixed fraction of a band, rather than in pixels, caps the gain
from input to output at about four, which is what the comic style's cel step has
always had.

| poster, static camera        | p99  | flicker |
| ---------------------------- | ---- | ------- |
| hard, `fwidth` only          | 23.3 | 1.67%   |
| floored lightness and margin | 14.6 | 1.23%   |
| chroma floored as well       | 4.5  | 0.52%   |

Chroma was the larger half. Colour steps are as discontinuous as lightness ones
and there are more of them, because chroma is small everywhere in a hazy picture
and its steps are correspondingly close together.

The cost of the fix is nothing measurable and nothing visible: the transition
only widens where the picture has no edge to sharpen.

### The moving camera says almost nothing

| moving camera | mean  | p99   | flicker |
| ------------- | ----- | ----- | ------- |
| the source    | 10.22 | 62.5  | 33.5%   |
| comic         | 7.88  | 100.5 | 17.4%   |
| poster        | 9.80  | 104.9 | 13.5%   |
| print         | 8.64  | 127.3 | 18.7%   |

When everything in the frame moves, everything in the styled frame moves, and
the ratio hovers around one for all three. This is the control, not the
experiment: it says the measurement is reading real change rather than a
constant, and it is the fixed camera that isolates what a style adds.

## 3. What a flat style costs, and what makes it look chosen

The remaining gap to the reference was flatness. Fewer and larger areas,
outlines only where they matter. Three candidates were on the table: a k-means
or median-cut palette in Oklab, a bilateral or guided flatten instead of the
Kuwahara, and region merging.

The costed answer is the first two together, and neither is expensive:

- **A separable bilateral, iterated three times, is O(radius) where the Kuwahara
  is O(radius squared)**, six passes over a buffer a few hundred pixels across.
  Three narrow passes flatten where one wide pass would only blur, because each
  pulls a region toward its own mean.
- **The outline is a region boundary, not an edge detection.** Comparing the
  quantised colour here against the quantised colour a line's width away costs
  five taps and has one threshold whose units are "how different do two areas
  have to be". A difference of Gaussians has no such opinion: it responds to
  contrast, so it inks smog and sensor noise, and the threshold that stops it
  also stops it drawing the faint boundary that matters.

Whole chain, nine passes, one at output resolution: **1.3 ms at 720p** against
the comic chain's 140.

### The measurement that mattered most

A palette is a claim about where a picture's lightness lives, and a photograph
does not agree:

| lightness     | p1   | p50  | p99  | mean | spread |
| ------------- | ---- | ---- | ---- | ---- | ------ |
| the scene     | 0.35 | 0.64 | 0.84 | 0.60 | 0.136  |
| Mural palette |      |      |      | 0.64 | 0.234  |
| Riso palette  |      |      |      | 0.57 | 0.249  |
| Noir palette  |      |      |      | 0.54 | 0.288  |

A hazy photograph occupies about half the range every palette assumes, so a
palette applied literally is read through two and a half of its five stops and
the whole frame comes out in one colour. That is not a palette looking wrong; it
is a palette barely being used.

The fix is one more pass, `wgsl/levels.wgsl`, a single invocation taking a
fixed 32x32 grid of taps onto a 1x1 target, and one affine map: centre the
picture on the palette's centre and scale it to the palette's spread. It is
shared, so the comic style's gradient map got it too, and the change to a hazy
frame is larger than any other single thing measured in this chapter.

**A fixed grid is what makes it safe on video.** The sample points do not move
between frames and each tap is a local average of an already smoothed buffer, so
the statistics follow the scene rather than the grain, and the stability table
above, which includes the fitted palettes, is the check on that claim rather
than the argument for it.

---

## What follows

1. **Style cost is a choice, not a constraint.** Two of the three styles run in
   under 2 ms at 720p. The one that costs 140 ms spends all of it in a single
   stage whose look, on this scene, the cheap one matches or beats.
2. **Per-frame independence is not the problem it was assumed to be** for
   smoothing-dominated chains. It is a real problem for hard thresholds against
   a fixed field, which is what a halftone is.
3. **Every hard decision in a style needs a floor under its transition width,
   expressed in the units of the thing being decided.** That single rule is
   worth more to video than any amount of temporal filtering, and it costs
   nothing.
4. **Fit the palette to the picture.** Imposing colour is what makes a result
   look chosen; imposing it on a range the picture does not occupy makes it look
   like one colour.
