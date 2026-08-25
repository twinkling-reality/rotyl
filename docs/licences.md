[Rotyl](../README.md) / Licence

# Licence

Rotyl is MIT. See `LICENSE`.

What it depends on is not all MIT, and one of them has an obligation attached,
so it is written down here rather than left to whoever reads a lockfile:

| what                   | licence     | how it is used                                    |
| ---------------------- | ----------- | ------------------------------------------------- |
| preact                 | MIT         | bundled                                           |
| onnxruntime-web        | MIT         | bundled, code-split                               |
| mediabunny 1.55.1      | MPL-2.0     | bundled unmodified, code-split                    |
| Geist and Geist Mono   | SIL OFL 1.1 | subset and served, see `public/fonts/LICENSE.txt` |
| seventeen Lucide paths | ISC         | inlined into `src/app/icons.tsx`                  |

**mediabunny is the one that asks for something.** MPL-2.0 is file-level
copyleft: it reaches the files it covers and no further, so it does not touch
anything here, but anyone distributing a build has to say where those files came
from. They come from https://github.com/Vanilagy/mediabunny, unmodified, at the
version this project's lockfile pins.

**EdgeTAM is Apache-2.0, and Rotyl distributes it.** The upstream EdgeTAM
repository carries the Apache License, Version 2.0. The published ONNX selection
graphs and the checkpoint from which the tracking graphs are exported declare
the same licence. Their repositories and exact revisions are part of
`models/edgetam/manifest.json`, beside the byte length and SHA-256 digest of
every file.

The selection graphs are unmodified copies. The memory encoder, fixed-size
memory attention graph, tracked mask decoder and extracted parameters are
modified files produced by `tools/edgetam-export`. That distinction is stated
in `models/edgetam/NOTICE.txt`, with the upstream attribution and the changes
Rotyl made.

Every deployment carries `LICENSE.txt` and `NOTICE.txt` in the same versioned
directory as the graphs. The build checks both against the manifest just as it
checks a weight, and refuses to produce a deployment if either is absent or
different. The model release therefore does not rely on a deployer remembering
the Apache-2.0 obligations after copying the files; the licence and notice are
part of the release contract.

**The hosted illustrated still is a separate licence surface.** It is not
bundled. When a host configures `FAL_KEY`, a consented still is sent to Fal
and run through PhotoMaker.

| what       | licence                  | how it is used                                      |
| ---------- | ------------------------ | --------------------------------------------------- |
| PhotoMaker | Apache-2.0 (Tencent ARC) | hosted inference only, never shipped in the bundle  |
| SDXL base  | CreativeML Open RAIL++-M | used by the PhotoMaker host, not redistributed here |
| Fal API    | Fal API Services terms   | the worker is the only caller; the key stays there  |

InstantID, PuLID and IP-Adapter-FaceID were not chosen because their official
face encoders depend on InsightFace weights that are not licensed for
commercial redistribution. That refusal is in
[stylisation decisions](stylization-decision-log.md).
