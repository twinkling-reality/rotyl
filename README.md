# Rotyl

**Select part of an image or a video, transform only that part, export at full
resolution.** Everything outside the selection stays byte-identical.

Runs on your machine. Nothing is ever uploaded. On first use, the model comes
from the same Rotyl deployment as the application and stays in the browser's
cache.

![The right half of a video frame stylised while the left half stays exactly as
it was, as the camera pans across a street](docs/media/hero.gif)

One rectangle, dragged once. Everything inside it is stylised on every frame;
everything outside it is the source, unchanged.

## Running it

```bash
pnpm install
pnpm dev
```

The development command prepares Rotyl's complete, versioned EdgeTAM release
before it starts. An offline clone with no model cache stops with the missing
file and the command that supplies it; it never starts a partial editor.

Needs a browser with WebGPU (Chrome/Edge 113+, Safari 26+, recent Firefox).

```bash
pnpm verify   # typecheck, lint, format, unit tests, production build
pnpm e2e      # Playwright, real Chrome
```

`pnpm verify` is also the required GitHub Actions job. Playwright stays a
separate real-Chrome run because it tests the browser and GPU the unit gate does
not emulate.

## What it does

**Selecting.** Brush a region, click the object, drag a box around it, or drag a
plain rectangle. Everything left of the toolbar's divider asks a segmentation
model what is there; everything right of it draws what you draw. The model runs
on your machine, and the boundary it returns is reconstructed against the
photograph rather than magnified from a 256 px answer.
See [selecting an object](docs/selection.md).

**Styling.** Three chains, sharing nothing but the seam: a painterly flatten with
inked contours, a flat poster snapped to a fitted palette, and a four-ink
halftone over warm paper. A style is a texture and a mix, so adding one is a
directory and a line in a table.
See [how it is put together](docs/architecture.md).

**Video.** Open an MP4 or a MOV, play it, scrub it, and select on any frame. An
edit holds from the frame it was made on until something later changes it, and
Track follows what is selected forward through the clip as a job the playhead is
free to ignore, one object per thing you clicked, because the log has recorded
which things those were since object selection landed. Every stage still runs per
frame, and what that costs was measured rather than assumed: a chain invents
nothing, so the flicker that is left is the input, and both ways of filtering it
out were priced and neither is here. See [video](docs/video.md).

**Exporting.** The frame on screen as a picture, or the clip as an MP4, whole or
between an In and an Out. Both are the preview's renderer at the preview's
parameters stopping at the same pass, so a saved file cannot drift from what was
on screen. A clip asks where it goes before it encodes anything, and in a
browser that can answer that it is written into the file as it is made rather
than held until the end. Its soundtrack goes with it, copied across as the
packets it arrived as rather than re-encoded, and interleaved with the picture
so the file still plays before it has finished arriving.

**Saving.** The selection is a command log and now it outlives the tab. Save
writes it as a `.rotyl` file, and dropping that file back in replays it: the same
mask, on the same frames, with the playhead where it was. It holds the log and
not the media, which a browser cannot address, so it names the file instead and
says how to recognise it. A file of a different shape is refused; a re-encode of
the same one opens with a sentence beside its name. And every edit is written
down as it lands, so a tab that dies is offered its work back on the next load
rather than losing it between one press of Save and the next.
See [saving the work](docs/saving.md).

![The comic style with the Mural palette applied inside a dragged rectangle,
with the style panel open](docs/media/styles.webp)

The selection boundary runs through the near car, so the same object appears
stylised and untouched at once. The controls a style declares are what the panel
draws, which is why adding a style needs no interface code.

## How it is put together

```
src/core/      the engine, no DOM, no framework
src/platform/  browser adapters: decode, texture upload, encode, mux, inference
src/app/       Preact UI
```

`core` never imports from `platform` or `app`, enforced by a second tsconfig that
compiles it with no `dom` library, so a stray `window` fails the build rather
than being caught in review. The payoff is concrete: every shader is unit-tested
by running it for real through Dawn in Node, with no browser and no mocks.

It ships an initial 162 KB of JavaScript, 49.8 KB gzipped, plus 31 KB of subset fonts.
Three runtime dependencies, all but the framework code-split, so a photograph
fetches neither the inference runtime, nor the demuxer, nor the container writer.
One Web Worker, which appends the crash journal because the API that can do that
without copying the file does not exist on the main thread.

## Reading further

| page                                           | what it covers                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| [How it is put together](docs/architecture.md) | the layers, the render path, what a style is, why the selection is a log   |
| [Selecting an object](docs/selection.md)       | the model, the three readings of one click, and the guided filter          |
| [Video](docs/video.md)                         | playing, holding a selection across frames, reading frames, writing a clip |
| [Saving the work](docs/saving.md)              | the document, coming back from a crash, and which file it belongs to       |
| [What was measured](docs/measurements.md)      | why every number lives on a generated page instead of in these files       |
| [Deployment](docs/deployment.md)               | the production build, immutable model paths and release boundary           |
| [The interface](docs/interface.md)             | closing a file, saying what is happening and what happened, type           |
| [Known limits](docs/limits.md)                 | what it cannot do, in its own words                                        |
| [Licence](docs/licences.md)                    | MIT, and what the dependencies are                                         |

**Every measurement is on `/research.html`**, linked from the top right before a
file is open, and generated at build time from the benchmarks' own results rather
than typed in by hand. One page per finding, with the command that re-takes it.
The harnesses in `tools/` carry the argument behind each number, next to the
code that produced it.

## Known limits, in short

Object selection and tracking need the network on first use. On half-precision
hardware their model files are 18.57 MB and another 22.24 MB served,
respectively, all from the deployment that served Rotyl and all checked before
use. A clip's picture is re-encoded, so outside the selection it is the source
pixels written again rather than the source bytes; its sound is copied across
rather than re-encoded, and a soundtrack an MP4 cannot carry is dropped, which
the interface says before the work rather than after it. Playback has no sound
at all. Only Chrome and Edge can give a page a file to write into, so everywhere
else a clip export is built in the tab and stops at about twelve minutes of
1080p with what it wrote. A saved selection references its media rather than
containing it, and recognises the file by its shape and by a digest of its two
ends, which cannot see a re-encode that agrees at both ends and in length. The full list, which
is longer and does not flatter the project, is in
[known limits](docs/limits.md).

## Licence

MIT. See [LICENSE](LICENSE).

The dependencies are not all MIT and one of them has an obligation attached, so
they are written down rather than left to whoever reads a lockfile:
[licences](docs/licences.md).

Rotyl's [EdgeTAM release](models/edgetam/README.md) is Apache-2.0. Its licence,
attribution and modified-file notice travel beside the graphs in every build.
