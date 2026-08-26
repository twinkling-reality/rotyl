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

**The default clip is the synthesised street, not a person.** A person on a
moving camera was tried first, on the Tears of Steel bridge crossing. The seed
was correct and verified, and the track still walked off her onto the trees
behind by the end of the clip, repeatably. Following one object through a
moving-camera shot of a person who turns is past what the tracker holds today.
That is worth knowing before this is shown to anyone, and it is the honest
reason the committed demo uses a fixed camera.
