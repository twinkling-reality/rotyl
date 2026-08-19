[Rotyl](../README.md) / Licence

# Licence

Rotyl is MIT. See `LICENSE`.

What it depends on is not all MIT, and one of them has an obligation attached,
so it is written down here rather than left to whoever reads a lockfile:

| what                 | licence     | how it is used                                    |
| -------------------- | ----------- | ------------------------------------------------- |
| preact               | MIT         | bundled                                           |
| onnxruntime-web      | MIT         | bundled, code-split                               |
| mediabunny 1.55.1    | MPL-2.0     | bundled unmodified, code-split                    |
| Geist and Geist Mono | SIL OFL 1.1 | subset and served, see `public/fonts/LICENSE.txt` |
| sixteen Lucide paths | ISC         | inlined into `src/app/icons.tsx`                  |

**mediabunny is the one that asks for something.** MPL-2.0 is file-level
copyleft: it reaches the files it covers and no further, so it does not touch
anything here, but anyone distributing a build has to say where those files came
from. They come from https://github.com/Vanilagy/mediabunny, unmodified, at the
version this project's lockfile pins.

**The segmentation model is not covered by any of this**, and it was worth
reading rather than assuming, because tracking makes it far more central than an
optional tool. It is fetched at runtime from a third party rather than bundled;
`tools/edgetam-export` says which checkpoint and where from.

**EdgeTAM is Apache-2.0, and so is everything under it.** The upstream repository
carries one `LICENSE`, Apache 2.0, with no `NOTICE` file and no acceptable-use
policy beside it, and the 56 MB checkpoint sits inside that repository rather
than under separate terms. The Hugging Face checkpoint the export runs against
and the ONNX release fetched at runtime both declare the same. So a public build
that fetches those weights is not blocked, and neither would bundling them be.

Two obligations follow for anyone who goes further than this project does.
Rotyl distributes none of it, since the weights are fetched by the browser from
somebody else's host, but the graphs `tools/edgetam-export` produces are a
derivative work of an Apache-2.0 checkpoint: hosting those means shipping the
licence text and the attribution with them. And Apache 2.0 asks that modified
files say they were modified, which those graphs are.
