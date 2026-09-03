# shots

The pictures in the README and in `docs/`, taken by driving the real
application.

```bash
pnpm dev --port 5180          # in another shell
node tools/shots/run.mjs
```

Writes `docs/media/hero.gif`, `docs/media/video.webp` and
`docs/media/styles.webp`, and deletes its own intermediate frames.

**They are generated rather than captured by hand**, for the reason the research
figures are: a binary artefact nobody can regenerate is a liability, and a
screenshot that has quietly stopped matching the interface is worse than none.
Re-run this after anything that changes the chrome.

**The hero uses a real CC0 portrait.** The generator fetches Cameron Kirby's
_Photographer in close-up_ from Wikimedia Commons and verifies its pinned
SHA-256 before opening it. The source stays in an ignored cache; the generated
GIF is the only copy committed. The video and style-shelf stills keep using the
synthetic street scene because they document measured video behavior.

**The hero records one complete edit.** It drags a rectangle through the
photographer and camera, holds the default Comic result, switches that same
selection to Print, then undoes it. The loop begins and ends on the photograph,
so the change reads without an unexplained jump.

## What it costs, and why those numbers

| file        | size   |
| ----------- | ------ |
| hero.gif    | 424 KB |
| video.webp  | 44 KB  |
| styles.webp | 52 KB  |

A GIF is the only moving format GitHub renders from a repository path. It is
held to 680 pixels across 32 frames and 256 colours. The real portrait needs
that palette to remain photographic before the edit, while its repeated frames
still compress tightly. The stills are WebP, which is what flat interface
chrome compresses to almost nothing, and the same format the research figures
use.

The stills use Riso and Mural because the hazy synthetic street otherwise gives
the palette fitter almost no hue to preserve. The portrait needs no corrective
palette: its skin, blue sky, black camera and warm landscape already give Comic
and Print meaningful source colour.

Hero source: [_Photographer in close-up_ by Cameron Kirby](https://commons.wikimedia.org/wiki/File:Photographer_in_close-up_%28Unsplash%29.jpg),
CC0 1.0 via Wikimedia Commons.

## tracked-clip

```bash
pnpm dev --port 5180
node tools/shots/tracked-clip.mjs
```

Writes `docs/media/tracked-clip.mp4` and `docs/media/tracked-clip.gif`. This is
the front-page claim moving rather than still: one object chosen once, followed
through the clip on device, with the treatment composited only inside it. The
app writes the MP4 itself through its own export, so what lands here is what a
user gets rather than a screen recording of the editor.

`ROTYL_CLIP`, `ROTYL_SUBJECT` and `ROTYL_GROW` pick a different clip and a
different thing in it. `SELECT_ONLY=1` writes the seeded frame and stops, which
is worth doing first: tracking is minutes long and a click one proposal off is
not visible until the end.

**Do not press Escape between choosing the proposal and tracking.** It cancels
the proposal while the preview goes on showing the one that was highlighted, so
the editor looks right and the track follows the smaller default.

**`ROTYL_SUBJECT` is a fraction of the clip, not a fraction of the canvas.** The
canvas is the whole viewport and the clip is fitted inside it, so the two agree
only when the footage is about as wide as the viewport. The Tears of Steel clips
are, which is why this went unnoticed. A portrait clip is letterboxed by 450
pixels a side, and a seed meant for the middle of the subject lands on the floor
beside it. Both scripts now read the clip's shape from the header and map
through the drawn rectangle, so the fraction means the same thing whatever shape
the footage is. Both defaults were renumbered at the same time and the seed did
not move: on the 534-tall Tears of Steel clips, 0.72 of the canvas and 0.774 of
the clip are the same pixel to within a quarter of one. Any `ROTYL_SUBJECT`
written down before this change is in the old frame of reference and wants the
same correction.

**The default clip is two people, and only one of them is drawn.** That is the
whole claim in one frame: his face carries ink and flat fill while her hair,
a foot away, still resolves to individual strands. Nothing has to be said about
what is being looked at.

**A moving camera is past what the tracker holds.** This was tried first on the
Tears of Steel bridge crossing, where the camera follows a walker who turns. The
seed was correct and verified, and the track still walked off her onto the trees
behind by the end of the clip, three times, including with longer settle times.
The committed demo uses a near-fixed camera because that is what works today.
Following a turning subject on a moving camera is the next piece of work, and it
is worth knowing before this is shown to anyone.

## track-confidence

```bash
pnpm dev --port 5180
node tools/shots/track-confidence.mjs        # ROTYL_CLIP, ROTYL_SUBJECT, ROTYL_GROW, OUT
```

Writes one row per tracked frame: the model's object score, its predicted IoU,
and the mask's covered area and centroid on the 256 grid. It exists because a
drifting track is invisible from outside, and the numbers below are why.

**This section records a hunt that found nothing, and that is the point of
keeping it.** It claimed at various times that the tracker drifts, that masks do
not grow with the subject, and that the export disagrees with the editor. None
of those survived being checked. What is below is what was actually seen, and
what it cost to find out.

**The mask is correct where it was checked.** `ROTYL_MASK_AT` writes the mask
out as a PGM per named frame. On the bridge crossing, frame 0 is a clean human
silhouette, head to feet. Frame 185, unsquashed back to the frame's own shape
and laid over the picture as a tint, sits on her hair, her face, her jacket and
her body, with the background clear. That is a working track, not a drifting
one, on the run that was instrumented.

**`ROTYL_MASK_AT` names frames and has no wildcard.** It is matched with
`includes`, so `-1` matches nothing and writes no masks at all, quietly, after
a full track has already been paid for. Every frame means every frame:
`ROTYL_MASK_AT="$(seq -s, 0 80)"`. Note that an N-frame clip logs N-1 frames, so
the last frame has no mask and the last one has to be held over if whatever
consumes them wants all N.

**A mask is a square grid, and a painted clip need not share the source's
frame rate.** The grid is 256 by 256 whatever shape the frame is, so it is
stretched back and wants a pixel or two of blur before it is used as an alpha:
at 1280 tall one cell is five pixels and a hard edge shows every one of them.
Compositing is `alphamerge` and `overlay`, never `maskedmerge`, which blends
chroma globally and tints the whole frame. If the painted clip came back from a
video model it may be tagged at a different rate than the source while holding
the same frames, and pairing those by timestamp drops and duplicates; `setpts`
re-times both by frame index so frame N meets frame N.

**The model's own scores say nothing useful.** Predicted IoU stays between 0.92
and 0.99 for all 191 frames and the object score never reports absent. Whatever
does go wrong, it cannot be detected from these.

**Three things were tested and are not causes.** No shot cut: `ffmpeg` scene
detection finds nothing above 0.15. Not the squashed aspect: re-running on the
same footage cropped from 2.40:1 to 1.50:1 gives a mask 66 grid columns wide
against 41, a ratio of 1.61 where the crop ratio is 1.60, so it covers the same
real region either way. Not accumulated drift: seeding fresh at frame 150 and
tracking only 41 frames lands where a track from frame 0 lands.

**And the export agrees with the tracker.** Captured from one run rather than
two: the mask at frame 185 spans columns 359 to 503 of a thousand, and the
pixels the exported file changes span 370 to 502. The style lands where the mask
is. An earlier note here claimed they disagreed. That was a mask from one run
compared against a file from another, which is not a comparison: two runs of the
tracker need not agree, so `ROTYL_EXPORT` now writes the clip from the same run
that wrote the masks.

**So what was the original fault?** Pressing Escape between choosing the
proposal and tracking, which cancels the proposal while the preview goes on
showing the highlighted one. The editor looked right and the track followed the
smaller default. That is fixed, and everything measured since has been chasing
a fault that was already gone. The measurements above are worth keeping because
they say where the problem is NOT, but none of them describes a live bug.
