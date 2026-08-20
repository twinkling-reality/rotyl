# style-bench

What the styles cost, whether they hold still on video, and what they look like.

**Nothing in Rotyl uses this.** It exists for the reason `video-bench` and
`edgetam-export` do: it answered questions that decide a design, and a number
nobody can reproduce is worth about as much as a guess. Three things were
unknown when it was written, one of the three turned out to be the opposite of
what everyone assumed, and two of the measurements since exist to stop a fourth
being built on a guess.

Unlike its neighbours it also writes PNGs, because a style bench that reports
only milliseconds and difference metrics can tell you a chain got faster and
steadier while it got worse to look at.

## Running it

```bash
./tools/style-bench/make-clips.sh          # ffmpeg + node, writes clips/
./tools/style-bench/fetch-real.sh          # curl + ffmpeg, writes real/
pnpm dev --port 5180                       # in another shell
node tools/style-bench/run.mjs all         # real Chrome, headed
node tools/style-bench/run.mjs real        # the same three, on photographs
```

`run.mjs` takes any subset: `chain`, `perturbation`, `clips`, `stills`, `sweep`,
`figures`, the five that need `fetch-real.sh` to have run: `real-chain`,
`real-perturbation`, `real-clips`, `real-lightness`, `real-flicker`, and the
three about what would hold a clip still: `motion`, `motion-pictures`,
`attribution`. `all` is the first six, `real` is the next five and `motion` is
the last three. They are kept apart because only one of the three groups needs a
network and only one needs a clip with motion in it, and because re-taking one
must not re-date the pages the others feed. The inputs are gitignored,
`results.json`, `results-real.json` and `results-motion.json` are not, and the
pictures land in `out/`.

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

**What it is not is a photograph**, and that turned out to matter far more for
one measurement than for the one it was expected to. The worry written here for
a chapter was cost: the anisotropic Kuwahara's sample bound grows with local
anisotropy, so a frame of architecture should cost more than a frame of foliage,
and the comic figures were to be treated as a hard case rather than a typical
one. Measured against four photographs, that is wrong in the ordering and nearly
right in the conclusion. The scene is the dearest of the five by 2 to 19 per
cent, which is the top of a narrow range rather than a class of its own, and
foliage costs more than a brick wall does.

**What was actually wrong was the temporal measurement**, in the one style
nobody was worried about, and it cost that style an operator.
See [measurement 0](#0-the-same-three-measurements-on-a-picture-a-camera-took).

`make-clips.sh` encodes three clips from it. The one that matters is
`static-720p`: fixed camera, fixed scene, so everything that differs between two
consecutive frames is grain and the encoder's own noise.

---

## 0. The same three measurements, on a picture a camera took

Measurements 1 to 3 were all taken against a scene this directory draws. That
was the right call and it was never checked. This is the check. It changed one
answer, and the answer changed a style.

### The methodology, which is the interesting part

Real footage cannot be committed, so there were exactly two honest ways to take
this: fetch a known input by URL and pin it by hash, or publish the number with a
caveat saying the input is unavailable. **It is fetched.** The measurement in
question is the one the whole per-frame design rests on, and a number nobody can
re-take is a number nobody can contradict, which is worse than no number.

`fetch-real.sh` verifies a SHA-256 before deriving anything. That accepts one
failure mode the synthetic scene does not have, a URL that stops resolving, and
removes the one that matters: if the bytes at the far end change, the script
refuses to run rather than measuring a different picture under the same name.
A stale hash fails loudly. A stale input does not fail at all.

Three kinds of input, because no one of them settles it:

- **the scene**, re-taken inside the same run rather than quoted from above. A
  control that sits in another file taken on another day is not a control.
- **four photographs**, put through exactly the recipe `make-clips.sh` uses, so
  the picture is the only thing that differs. Real texture, synthetic grain.
- **two shots of a film**, stream copied rather than re-encoded, so the codec
  noise being measured is the film's and not this machine's. Real everything,
  including subject motion, which is the one thing a fixed camera was isolating
  and which no real shot can be without.

The photographs are CC0 from Wikimedia Commons; the film is Tears of Steel,
CC-BY 3.0, (CC) Blender Foundation. Nothing fetched is committed or
redistributed. The shots are the quietest in the film, found by scanning all
17,620 frames for the window whose worst consecutive-frame difference is
smallest.

### What came back

**The cost question, which is the one this README worried about, is a non-event.**
Content moves the comic chain by 2 to 19 per cent and moves the ordering the
wrong way round: foliage costs more than a brick wall. Corrected above.

**The comic chain holds.** It is steadier than its input on all four
photographs, which is the finding that was surprising and the one the design
leans on.

**The poster chain did not, and it was the outline.** On a brick wall it
amplified its input by 5.7 where the scene reports it attenuating by two, and
turning the outline off returned it to 0.95. With the codec taken out entirely, a
perturbation whose 99th percentile is six codes came out at seventy-eight, and at
eight without the outline.

The cause is exactly the rule
[measurement 2](#what-this-measurement-bought-the-floor-under-a-soft-transition)
established, broken in the one place it could not be applied. Every hard decision
in a style has a floor under its transition width. The outline compared the
quantised colour here against the quantised colour a line away, `round()` flips a
whole band on an infinitesimal change, that moved the comparison by a fifth of
the Oklab range, and it crossed the line threshold, so an ink stroke appeared at
full weight. The scene has almost no pixel near a band edge, and the population
that flickers is exactly that one.

**Run `real-flicker` before theorising about it.** The stability tables say how
much moves and never which pixels, and the difference was the whole diagnosis
here: 2% of pixels sounds like a diffuse shimmer and was not diffuse at all. It
traced the ink, along every boundary the flatten found marginal. `out/` gets one
picture per style per photograph, the styled frame at half brightness with
everything that moved more than eight codes painted over it, and the pair with
and without the outline settled the question in one look. It is the check on the
fix as well: what the same map shows now is scattered through the texture rather
than drawn along the ink.

**Both hard decisions in it were softened before the operator was replaced**, in
every combination and at four widths, and none of that could have worked. Softening the neighbour probe cuts the noise and the
signal together, which weakens every genuine outline for a fifth of the flicker.
Widening the threshold one-sidedly displaces the decision rather than resolving
it, and took the outlines off the reference scene while the flicker was still
there. Centring that transition is the right shape and free, and buys nothing on
its own. The two together stop three times above the floor. A hard probe leaves a
discrete quantity for a width to resolve, which no width can do.

**So the probe stopped rounding.** The outline now measures the flattened colour
itself, and a stroke's weight is that distance ramped up to the threshold rather
than a decision taken at it: nothing below a quarter of the threshold, full
weight at it, proportional in between. That is continuous in the picture by
construction, and it is still a region boundary rather than an edge detection
because of WHICH picture it reads. The bilateral's answer is where smog, grain
and the inside of foliage have already gone. The wall goes from 5.7 times its
input to 1.36, and the perturbation from seventy-eight codes to fifteen against
a floor of eight.

**What is left is not the quantiser, and it does not go away by tuning either.**
The flatten's own edge contrast moves under grain, and an outline whose weight
follows contrast follows that. Widening the ramp buys the difference back in
proportion: twice as wide reaches twelve codes and visibly greys every line. The
five codes are in `docs/limits.md` with that trade rather than described as
solved.

**The look was checked with a number, not with an eye.** Rendering the reference
scene through both chains and differencing them, the new operator moves 7.8% of
it more than eight codes, and what moves is the contours the old one drew where
the band grid crossed a nearly flat field. Those are the banding artefact rather
than a boundary between two things, they are also exactly the population that
flickered, and losing them is the change a person can see.

**The tables are on `/research/real-footage.html`**, generated from
`results-real.json`, like every other table this project relies on.

---

## 1. Print is not "probably cheaper". It is 200 times cheaper

An earlier version of this project timed the comic chain and said plainly that
the print chain never had been, three passes against nineteen, only one at output resolution,
so it _should_ be cheaper, but that was an argument rather than a measurement.

Median milliseconds, full quality tier, default controls:

| style  | 720p    | 2 MP    | 12 MP | 24 MP |
| ------ | ------- | ------- | ----- | ----- |
| comic  | 119.4   | 100.2   | 106.9 | 107.9 |
| poster | **1.1** | **1.3** | 2.9   | 4.9   |
| print  | **0.5** | **0.6** | 1.9   | 3.7   |

The ordering holds at every size, and an earlier version of this table said it
did not. It reported 25.1 and 13.0 in the 24 MP column and argued from them that
both cheap styles go superlinear past about 12 megapixels as the working set
stops fitting anything. Re-taken on a quiet machine the growth from 12 to 24
megapixels is 1.7 times for twice the pixels, which is sublinear rather than
super. The old figure was a busy machine, and it survived because nothing
re-took it. **Check the min against the median before believing a row**, which is
what that field is in the results file for. Every row above a millisecond here
sits at 0.95 or better; the run that reproduced the old figure sat at 0.85. Below
a millisecond the ratio says nothing, because the medians are rounded to a tenth
and 0.4 against 0.5 is 0.80 by arithmetic rather than by contention.

The poster column moved in this chapter and it moved for a reason:
[measurement 0](#0-the-same-three-measurements-on-a-picture-a-camera-took)
replaced the outline, and its four neighbour probes no longer run a five-stop
palette search each. That is invisible at 720p and worth a third of the cost at
12 megapixels, where the pass at output resolution is the whole chain.

The comic chain is flat in output resolution for the reason its own stage
implies: the expensive stage runs on a buffer whose size is derived from an
apparent scale and never grows.

Two things follow, and the second one is the whole reason a third style exists.

**The comic chain is the Kuwahara and nothing else.** Its cost tracks the
flatten buffer's pixel count almost exactly and is nearly flat in output
resolution: 720p costs _more_ than 2 MP, because a 16:9 flatten buffer holding
the same apparent radius is 19% larger than a 3:2 one. Everything at output
resolution, the cel step, the ink threshold, the composite, is single digits.

**A style does not have to be expensive to be flat.** The comic chain spends
119 ms deciding what to smooth. The print chain spends half a millisecond and
reads as more deliberately designed than the comic chain does, because what
makes it look chosen is the four inks and the paper, not the amount of work.

The detail control is where the surprising figures live: higher detail is
CHEAPER when a clamp binds, because the
Kuwahara radius falls, and the quality tiers COLLAPSE when a stage clamps to the
output's short edge. Both reproduce here.

| comic, full tier | 720p  | 2 MP  | 12 MP | 24 MP |
| ---------------- | ----- | ----- | ----- | ----- |
| detail 0         | 43.0  | 40.6  | 41.4  | 42.1  |
| detail 0.5       | 119.4 | 100.2 | 106.9 | 107.9 |
| detail 1         | 49.1  | 203.2 | 348.6 | 349.5 |

At 720p and detail 1 the flatten buffer clamps to 720 and the radius falls to
4.25, so draft, full and export are the same render. 49.2, 49.1, 49.1. At 2 MP
nothing clamps and the same setting costs four times as much.

**The poster chain is a per-frame budget.** 1.1 ms at 720p against a 33 ms
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
| poster        | 0.38 | **4.1**  | **0.29%** |
| print         | 1.39 | **12.6** | **3.01%** |

**On this picture, no style amplifies its input; every one attenuates it.** Two
of those three rows survived a photograph unchanged and the poster row did not;
see [measurement 0](#0-the-same-three-measurements-on-a-picture-a-camera-took),
which is where that row's outline was rebuilt and where this one was re-taken
afterwards. The comic chain is a
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
| sigma 2      | 6         | 3     | 3      | 5     |

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
| chroma floored as well       | 4.9  | 0.56%   |

That last row is where this chapter finished. The outline change in
[measurement 0](#0-the-same-three-measurements-on-a-picture-a-camera-took) has
since taken the same clip to 4.1 and 0.29%, which is the table above.

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
| poster        | 7.15  | 86.1  | 13.7%   |
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
  flattened colour here against the flattened colour a line's width away costs
  four taps and has one threshold whose units are "how different do two areas
  have to be". A difference of Gaussians reads the photograph and has no such
  opinion: it answers to contrast wherever it finds it, so it inks smog and
  sensor noise, and the threshold that stops it also stops it drawing the faint
  boundary that matters. What it compared when this was written was two ROUNDED
  colours, and
  [measurement 0](#0-the-same-three-measurements-on-a-picture-a-camera-took) is
  what that cost.

Whole chain, nine passes, one at output resolution: **1.1 ms at 720p** against
the comic chain's 119.

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

---

## 4. The residue is the input, and a cleaner input does not touch what amplifies

Measurement 2 said no style amplifies its input, measurement 0 said that was
true of a drawn scene and false of a brick wall, and both left the same question
open: what IS the flicker that softening a decision cannot reach. There were
three stories about it, and they imply completely different features at
completely different prices.

**The input moves.** A fixed camera still delivers grain and encoder noise, and
every stage downstream answers to it honestly. The fix is one pass BEFORE the
chain and needs no motion estimation on a static shot.

**A stage amplifies.** Something inside the chain moves more than its own input
did. The fix is inside one stage of one chain and touches no architecture.

**The decisions really are per frame.** The fix is the previous stylised frame,
warped by motion, blended where the warp can be trusted. The expensive one, and
the only one that breaks an invariant this product has promised: a render is a
function of its frame, so scrubbing straight to frame 500 and playing up to it
give the same picture.

```bash
./tools/style-bench/make-clips.sh        # traffic-720p and its mask
./tools/style-bench/fetch-real.sh        # the four photographs
node tools/style-bench/run.mjs motion
```

### The third story is empty, and it is empty structurally

A chain is a pure function of its frame. Hand it the same picture twice and it
gives the same answer twice, so there is nothing in a styled frame that was not
in the source frame. That is not an argument, it is a row: on a clip encoded
with no temporal grain the input moves 1.4 codes at the 99th percentile, which
is the codec, and every chain answers with 1.0, which is the floor a difference
of nearly nothing has.

So a temporal method cannot remove anything the chain invented, because the
chain invents nothing. Whatever it removed, a quieter input would have removed
too, without a warp and without breaking the invariant.

### The second story is where the residue is, and only on a real picture

The amplification table is on `/research/holding-still.html`. Its shape is the
finding: on the drawn scene every chain but print attenuates, and on
photographs the poster chain amplifies a brick wall by 1.36 and foliage by 1.46,
and the comic chain at full detail amplifies the wall by 2.02 where at no detail
it attenuates by 0.62.

**Both of those are already located.** Poster's is the outline, which is 1.36
with it drawn and 0.95 without on the wall, 1.46 against 0.86 on foliage. That
is the same stage measurement 0 rebuilt, and `docs/limits.md` already carries
the gap it did not close. Comic's is the detail control: raising it shrinks the
Kuwahara radius until the flatten stops flattening, and what survives is the
grain the flatten was there to remove.

**And the drawn scene hides all of it**, which is the second time that has
happened and the reason the four photographs are in this run rather than beside
it. A finding taken on the synthetic scene alone reversed sign once already and
it cost a style an operator.

### The first story is real and the cheap fix does less than it looks

Averaging each frame against the one before it on the way IN is one pass, needs
no motion estimation on a fixed camera, and is nothing like a temporal filter on
the output. Measured rather than argued about, at the weakest weight worth
measuring, a quarter of the last frame.

It takes the input down by about a fifth and the styled output down with it,
roughly in proportion, on every chain and every picture. **And it makes the
amplification worse wherever the amplification was already above one**: poster
on the wall goes from 1.36 to 1.52, on foliage from 1.46 to 1.62, and comic at
full detail from 2.02 to 2.48.

That was not what this expected and it is the useful half. What a denoise
removes is the high-frequency part of the input, which is the part these chains
attenuate hardest. What is left is the part they amplify. So a cleaner input
lowers the number and leaves the mechanism exactly where it was, which makes it
a way of reporting less flicker rather than a way of having less.

---

## 5. The counter-metric, built before the cure and failed by the cheapest cure

Every temporal method improves flicker trivially, and some of them do it by
making the picture worse. Blend enough of the last frame in and a fixed camera
is perfectly steady while a moving one smears. **Neither clip this project had
could catch that.** `static-720p` has a fixed camera and nothing in it can
expose a ghost. `pan-720p` moves a still, so every pixel moves together, which
is the one case a warp of the last frame gets right by construction. A smear
needs something to move against something that does not, and ground that has
just been uncovered.

So `make-scene.mjs` gives its five cars speeds and sorts them by depth, and
`make-clips.sh` writes `traffic-720p.mp4`, a clip with a fixed camera and five
things moving at different rates in front of it, two of them closing on each
other. Beside it goes `traffic-mask-720p.mp4`, which says which pixels a moving
thing covered on each frame, drawn from the same geometry as the picture rather
than inferred from it and encoded losslessly so the boundary survives.

**The still this file has always written is unchanged to the byte**, which
matters more than the clip does: every committed style number was taken against
it. At time zero the cars are where they were and the sort is a no-op.

### Four numbers, over three populations the mask defines

`residue` is how much the styled frame moves where nothing moved, which is
measurement 2's flicker restricted to the pixels that are honestly still.
`honest` is how much it moves where something did, which is the control.
`deviation` is how far a method's frame is from the per-frame render of the same
frame, in each of the three populations, and it is zero everywhere for the
per-frame row by construction. `detail` is the gradient energy inside a moving
car against the per-frame render's, because a smear loses it.

**The deviation is split three ways because the picture said so.** The first
version measured it only in the band a car had just left, on the argument that a
ghost can live nowhere else. The trail map the harness writes says otherwise:
most of what a blend does is on and around the moving object itself, and a
vacated-band figure alone would have missed the larger half. That is the same
lesson `real-flicker` taught about the poster outline, learned again by looking
at which pixels rather than at how many.

### A metric with no failing case is not a check

So a straw man is measured beside every row: the previous stylised frame blended
in at a fixed weight, with no motion compensation, which is the cheapest thing
anybody would try. It has to fail, and if it does not then the metric is wrong
and nothing built on it can be believed.

It fails. Half of the last frame takes the comic chain's residue from 3.6 codes
to 2.0, which is the number everybody quotes, improved by two fifths. It pays
with 58 codes of deviation in the band a car has just left, 53 on the car
itself, and 13% of the gradient energy inside a moving car for the poster chain.

**And on the clip with no moving grain it is worse than that.** There the
residue is already at the codec floor, so the same blend has nothing left to
remove: it makes the residue flicker WORSE and still costs the same sixty codes
of deviation. The cure being worse than the disease with nothing left to cure,
in one row, which is exactly what this measurement was built to be able to say.

### What was built

Nothing. The expensive answer solves a problem that does not exist, the cheap
one lowers a number without touching what causes it, and what is left is in one
stage of one chain, where measurement 0 has already been once and where the
number it did not close is in `docs/limits.md` rather than in a plan.

## What follows

0. **The residue that is left is the input, and the chain's own gain decides
   what becomes of it.** A chain is a pure function of its frame, so nothing in
   a styled frame was invented: on a clip with no moving grain every chain
   answers the codec floor. What differs is the gain, and the gain depends on
   the picture rather than on the chain. The drawn scene says every chain but
   print attenuates; a brick wall says the poster outline is at 1.36 and the
   comic chain at full detail is at 2.02.
1. **Style cost is a choice, not a constraint.** Two of the three styles run in
   under 2 ms at 720p. The one that costs 119 ms spends all of it in a single
   stage whose look, on this scene, the cheap one matches or beats.
2. **Per-frame independence is not the problem it was assumed to be** for
   smoothing-dominated chains. It is a real problem for hard thresholds against
   a fixed field, which is what a halftone is.
3. **Every hard decision in a style needs a floor under its transition width,
   expressed in the units of the thing being decided.** That single rule is
   worth more to video than any amount of temporal filtering, and it costs
   nothing.
4. **A floor is only available where the quantity being decided is continuous.**
   Where it is not, no width resolves anything and the decision itself has to
   go: the poster outline compared two rounded colours, six widths were measured
   against it, and what worked was reading the colour before it was rounded.
5. **Fit the palette to the picture.** Imposing colour is what makes a result
   look chosen; imposing it on a range the picture does not occupy makes it look
   like one colour.
6. **A cleaner input reports less flicker rather than causing less.** Averaging
   frames on the way in takes the input down a fifth and the output with it, and
   makes the amplification WORSE wherever it was above one, because what it
   removes is the part the chain attenuates hardest.
7. **Build the thing that catches a cure being worse than the disease first.**
   The cheapest temporal filter improves the number everybody quotes by two
   fifths and costs sixty codes of deviation around anything that moves. Without
   a clip where something moves against something that does not, and a mask
   saying which is which, that trade is invisible and the number looks like
   progress.
