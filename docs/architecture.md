[Rotyl](../README.md) / How it is put together

# How it is put together

```
src/core/      the engine, no DOM, no framework
src/platform/  browser adapters: decode, texture upload, encode, mux, inference
src/app/       Preact UI
```

It ships as 163 KB of JavaScript, 50.8 KB gzipped, plus 31 KB of subset fonts.
Three runtime dependencies, all but the framework code-split, so a photograph
fetches none of the other two: the inference runtime arrives on the first object
click, the demuxer on the first video, the container writer on the first clip
export.

`core` never imports from `platform` or `app`. That is enforced by
`tsconfig.core.json`, which compiles `src/core` with `"lib": ["es2023"]` and no
`dom`, so a stray `window` or `HTMLElement` fails the build rather than being
caught in review. The payoff is concrete: every shader is unit-tested by running
it for real through Dawn in Node, with no browser and no mocks.

Three things were tried at this layer and dropped, each with a number rather
than a preference. **React**, at 59.5 KB gzipped against Preact's 6.1 KB, for an
application whose interface is a canvas and eight buttons. **A WebGL2 fallback**,
which doubles the shader surface permanently in order to serve browsers that
will have WebGPU before it is finished. And **Web Workers for export**, which
measured 50% slower than doing it on the main thread, because moving a
full-resolution image across the boundary costs more than the parallelism
returns. Every rejection this project has made is collected, with what decided
it, on the research page the drop zone links to.

There is now exactly one worker, and it is the exception that keeps that third
rejection intact rather than a change of mind about it. The crash journal
appends three and a half kilobytes per edit, not a full-resolution image per
frame, and the API that can append to a file without copying it first,
`createSyncAccessHandle`, does not exist on the main thread at all. Through the
one that does, adding a record to a ten-minute journal measures 98 ms; in a
worker it is 0.13 ms at every size. See [saving the work](saving.md).

One more decision belongs here because it is about the build rather than about
the picture. **Shaders reach the bundle as strings**, and this codebase comments
them as heavily as its TypeScript: 78 KB of WGSL, two thirds of it explanation,
shipped to every user. A build-time transform removes the comments and keeps
every newline, which is worth 17 KB gzipped, a quarter of the application
bundle, and leaves a WGSL compile error still reporting the line it is on. It
runs in development too, so the string the browser gets is the string both test
suites exercise.

## The render path

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
saved file. Writing a clip is that loop run once per frame rather than a second
one: a source hands over frames, a sink takes them, and a photograph is a
one-frame document that goes through it once. Whether those bytes end up in a
file the user named or in a blob the browser downloads is one line inside the
sink, which is why a browser that can be handed a file did not cost a second
export. A soundtrack is a second stream rather than more frames, so it has a
cursor of its own and a second method on the sink, and it is still not a second
loop: what the loop gained is one question per frame, asking whether the sound
is behind. See [writing the clip out](video.md#writing-the-clip-out).

**Boundaries have no seam.** Every stage before the composite runs over the
whole image. Masking earlier would be cheaper but wrong: a style's kernels
sample well outside their own pixel, so pixels just inside the selection would
be computed from zeroed neighbours and draw a halo.

## A style is a texture and a mix

Nothing outside `src/core/style` knows what a style does. One declares its
controls as named values and turns the source into a styled texture at output
resolution; the compositor blends it through the mask and knows nothing else.
The UI builds its controls from the declaration, so a style is a directory and a
line in `styles.ts`. The engine, the export path, the composite and the panel
are untouched.

A control is a slider or a choice, and a choice is still a number: its value is
an index into the options it declares. That is why adding one moved nothing
between here and the export path. The app stores it, compares it and hands it
back exactly as it does a slider, and all the declaration buys is that the panel
draws buttons instead of a track for a decision with no meaningful midpoint.

**Comic** flattens with an anisotropic Kuwahara filter, finds contours with a
flow-based difference of Gaussians along the structure tensor, then quantises to
cel bands and multiplies the ink over them. Twenty passes over three
differently-sized buffers.

It also carries a **palette**, and that is the control that decides whether the
result looks designed or merely processed. The reason a filter looks like a
filter is that it keeps the photograph's colour: stylise hazy traffic and the
flattening, the quantisation and the ink all do their job, and the answer is
grey, because the input was grey. An illustration of the same street is not
grey, not because it was drawn better, but because somebody chose the colours,
and no amount of edge detection supplies the choosing.

So a palette maps LIGHTNESS to colour rather than nudging the colours already
there. Dark parts of the picture take the dark end of a five-stop ramp, light
parts the light end. Form survives completely, since it is carried by the
lightness being used as the index, and hue is replaced wholesale, which is the
point, because smog has no hue worth keeping. The ramp is interpolated in Oklab,
so the midpoint of two stops is the colour a person would call the midpoint;
the same blend in linear RGB takes a deep teal to a cream through a muddy green.
It is applied after the cel step and indexed by the quantised lightness, so the
palette lands in the flat bands rather than reintroducing a gradient across
them.

**And it is fitted to the picture before it is applied.** A palette is a claim
about where a photograph's lightness lives, and photographs disagree: measured
on the reference scene, hazy traffic has a lightness spread of 0.136 where every
palette here spans 0.23 to 0.29. Applied literally, a ramp is therefore read
through two and a half of its five stops and the whole frame comes out in one
colour, which looks like a palette that was chosen badly and is really a
palette that was barely used. So one pass measures the picture's own mean and
spread and one affine map moves it onto the palette's, which was the single
largest change to how a stylised frame looks in this chapter. It costs a
fullscreen pass onto a 1×1 target: one invocation, a fixed grid of a thousand
taps. Fixed, because sample points that do not move between frames follow the
scene rather than the grain. An auto-exposure that pumps would be worse than no
fitting at all.

**Poster** flattens with an iterated separable bilateral, quantises to flat
areas in Oklab, snaps them to the palette, and draws a line where two areas
meet. Nine passes, one at output resolution, and a millisecond at 720p.

It is the same palette data read the other way round. A ramp indexed by
lightness cannot keep two things apart, a red tail light and a grey wall of the
same lightness come out the same colour, so this style takes the NEAREST stop
in all three dimensions instead. The palette becomes a set rather than a ramp,
and a picture in five chosen colours still shows a car against a road.

Its outline is a region boundary rather than an edge detection, which is the
cheaper idea and also the better one. What makes it one is WHICH PICTURE it
reads: the flattened one, the bilateral's own piecewise-constant answer, which
is where smog, sensor grain and the inside of foliage have already gone. The
line is drawn where that colour changes across a line's width: four taps, and
one threshold whose units are "how different do two areas have to be". A
difference of Gaussians reads the photograph and has no such opinion. It answers
to contrast wherever it finds it, so it inks all three, and the threshold that
stops it doing that also stops it drawing the faint boundary that mattered.

For most of this project's life it compared the QUANTISED colour on both sides,
and that was the one hard decision here with no floor under its transition,
because a rounded value is what a floor cannot reach: the value belongs to a
neighbour, and round() flips a whole band on an infinitesimal change. On a
detailed photograph that put a stroke on and off between frames, five times the
input on a brick wall. Both of its hard decisions were softened, in every
combination and at four widths, and none of that worked, which is the useful
half of it: the answer to a decision taken on a discrete quantity is not a wider
transition, it is not taking a decision. A
stroke's weight is the distance itself now, ramped up to the threshold, and what
it costs is the contours the quantiser drew across a nearly flat field, which
were the banding artefact rather than a boundary between two things. What is
left of the flicker is the flatten's own edge contrast, and that is in
[known limits](limits.md) with its number rather than described as solved.

**Print** separates the image into four ink densities and screens each one at
its own angle, over warm paper, slightly misregistered. Three passes, only the
last at output resolution.

What the three share is the colour maths, a box downsample, the palette and its
fitting, and the shape of a fullscreen pass. Nothing else, and in particular not
a line of the compositor: each landed without one changing, and all three are
held to the same contract by the same harness in `test/style-harness.ts`. What
they deliberately do not share is the stage that makes each one what it is.
a Kuwahara flatten and a bilateral flatten are not two settings of one thing,
they are the difference between painterly and printed.

## Resolution is derived, not configured

Every style has a characteristic length. A Kuwahara radius, a bilateral sigma,
a screen pitch, the width of a line.
Written the obvious way that length is a pixel count which must grow with
resolution to keep the look constant, and cost then grows with the _fourth_
power of resolution.

So it is inverted. Each stage declares the apparent scale it wants as a fraction
of the image, and its buffer resolution is _derived_ to hold that scale. Cost
becomes linear in pixels, "more detail" buys resolution rather than kernel
width, and a coarser halftone costs less rather than more. A screen carries no
detail below its own cell, so the buffer feeding it shrinks as the dots grow.

Because every length is a fraction of the image and never of the output buffer,
preview and export compose identically. That is a property of the two parameter
modules alone, and it is tested in each of them exactly, across every output
size and quality tier.

**A derived resolution can ask for more than the picture has, and what happens
then is not free.** The comic style's flatten asks for 1356 pixels of a 720
pixel frame at full detail. Clamping the request at the frame's own resolution
keeps the fraction exact, which is what the invariant above needs, and it also
turns the box downsample in front of that stage into a copy, which is what the
picture needed: that downsample is the only thing in the chain that removes
grain before the stage that amplifies it. So the flatten now carries a second
bound, a root two below the picture, and every flatten pixel is the mean of at
least two source pixels at every setting. The apparent scale is untouched, only
sample density moves, and the chain is three times cheaper at 720p. What that
cost and what it did not fix is on `/research/the-detail-control.html`.

## The selection is a command log

Strokes, not pixels, are the source of truth. Replaying the log rebuilds the
mask, which makes undo, redo, and export-at-a-different-resolution the same
operation, and means no edit ever costs a full-resolution snapshot. Stroke
coordinates and radii are in source pixels, so a brush edge exported at 6000 px
is the shape that was drawn rather than a magnified approximation.

`applyMask` is the one route by which a mask produced outside the brush can
reach the renderer, and it is how object selection connects, deliberately, and
undoably. It is also how tracking connects, and that was the point of building
it this way: a tracker contributes one of these per frame it has followed the
object to, and nothing between the model and the renderer needed a new idea.

What tracking did add is a group. One run is three hundred commands and one
gesture, so commands carry the id of the gesture that made them and undo takes
the whole run. It is one optional field and two loops, and it is the only thing
in the log that knows more than one command can belong together.

**And it made the mask's shape matter.** One a frame at 64 KB is a gigabyte for
ten minutes, so a mask is packed rather than held plainly, which takes it to
about 3 KB without changing anything else about the log: it is still a
resolution-independent statement about the image and replaying it still
reconstructs a boundary. Unpacking is what that costs, and unpacking is not once
per frame but once per command the frame folded to, so the fold cuts at the last
command that decides the frame by itself. A run of masks applied with `replace`
therefore folds to the last of them, whether it is three hundred or eighteen
thousand, and the replay does one upload.

It is also what makes a lost graphics device survivable. Everything the renderer
owns belongs to one `GPUDevice` and dies with it; the log belongs to the work
and does not, so the document is created outside the engine and handed to each
one in turn. A loss costs the decoded pixels, which are read from the file
again, and nothing else: a new device, a new engine around the same log, the
image re-uploaded, and the view carried across so the canvas comes back where it
was. Three rebuilds inside a minute is a driver that will keep doing it, and
that is the point at which it says so rather than looping.

**And it now outlives the tab, which for most of this project's life it did
not.** The log survived a lost device and did not survive a reload, which is the
largest gap there has been between what this page promises and what the product
did. Saving is the log written out and opening is the log handed back: no cached
mask, no snapshot, nothing derived, because a replay of eighteen thousand
commands is a fold to one and a texture upload, measured at 0.3 ms. What the
file has to solve instead is the thing a browser makes hard, which is naming
media it has no path to, and that is in [saving the work](saving.md) with the
measurements behind it.

**It outlives a tab that was never given the chance to save, too.** Every
command is appended to a journal as it lands, and a session that ended is
offered back on the next load. That is the same log in a second shape and for a
measured reason: written as a document per edit it is 2559 ms at ten minutes of
tracking, and appended as a record it is 0.13 ms whatever is already there.

The format lives in `src/platform`, not here. Core owns what a document IS and
knows a frame is an integer and a mask is a packed byte run; what a document
becomes on a disk is bytes, a `TextEncoder` and a file handle, none of which
exist in `tsconfig.core.json`'s world. It is the same split as the frame
provider, where core knows a frame index and platform knows how to decode one.
