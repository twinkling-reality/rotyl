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
| eight Lucide paths   | ISC         | inlined into `src/app/icons.tsx`                  |

**mediabunny is the one that asks for something.** MPL-2.0 is file-level
copyleft: it reaches the files it covers and no further, so it does not touch
anything here, but anyone distributing a build has to say where those files came
from. They come from https://github.com/Vanilagy/mediabunny, unmodified, at the
version this project's lockfile pins.

**The segmentation model is not covered by any of this.** It is fetched at
runtime from a third party rather than bundled, and it carries its own terms;
`tools/edgetam-export` says which checkpoint and where from. Anyone hosting
Rotyl publicly should read those terms rather than assume this file speaks for
them.
