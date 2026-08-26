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

**A drifting track reports itself as a good one.** On the Tears of Steel bridge
crossing, where the tracker loses the walker, the predicted IoU never falls
below 0.92 across 191 frames and the object score never once says absent. At
frames 180 to 190, where the mask is no longer on her, the predicted IoU is
0.98, the highest in the clip. Confidence RISES as it drifts, because a mask
that has settled on a stable piece of background is an easy mask to predict.
So nothing can be gated on the model's own scores: it is confidently wrong.

**What actually fails is scale, not position.** The centroid follows her across
the frame. The area does not follow her toward the camera:

| clip           | subject                | mask area, first to last | ratio |
| -------------- | ---------------------- | ------------------------ | ----- |
| `traffic-720p` | car approaches         | 530 to 1125              | 2.12  |
| `tos-crossing` | walker fills the frame | 6035 to 6339             | 1.05  |

The car grows and its mask grows with it, so scale adaptation is not broken in
general. On the crossing the walker ends up several times the area she started
at and the mask stays a band about 40 grid columns wide the whole way, so by the
end it covers hedge and bridge beside her rather than her.

**Three explanations were tested and are not it.**

_Not the model losing confidence._ There is no signal to gate on, per the
numbers above.

_Not a shot cut._ `ffmpeg` scene detection finds nothing above 0.15 across the
clip, and the frames either side are one continuous camera move.

_Not the squashed aspect._ The clip is 2.40:1 and the model input is square, so
a person arrives very tall and narrow, which looked like the obvious suspect.
Re-running on the same footage cropped to 1.50:1 gives a mask 66 grid columns
wide against 41, a ratio of 1.61 where the crop ratio is 1.60. The mask covers
the same real region either way and grows just as little, 0.96 against 1.05.
The distortion is not what is hurting it.

_Not accumulated drift._ Seeding fresh at frame 150, where she is already large,
and tracking only the last 41 frames reaches the same place as a track that ran
from frame 0: area 5124 against 6339, columns 93 to 126 against 87 to 126. A
track with no history to have drifted through arrives at the same answer, so
what is wrong is not something that built up along the way.

**So the mechanism is still open.** What is known is that the mask the model
produces for this subject is a fixed-width band that does not widen as she
approaches, that it produces the same band from a fresh prompt as from a long
track, and that it reports high confidence throughout. Anyone picking this up
should start there rather than at memory, aspect, or cut detection, all of which
have been paid for already.
