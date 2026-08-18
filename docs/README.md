[Rotyl](../README.md) / Documentation

# Documentation

One page per concern. Each says what was decided and why, and none of them holds
a table of measurements: those are on `/research.html`, generated at build time
from the benchmarks' own results, for the reason
[what was measured](measurements.md) gives.

| page                                      | what it covers                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| [How it is put together](architecture.md) | the layers, the render path, what a style is, why the selection is a log   |
| [Selecting an object](selection.md)       | the model, the three readings of one click, and the guided filter          |
| [Video](video.md)                         | playing, holding a selection across frames, reading frames, writing a clip |
| [What was measured](measurements.md)      | why every number lives on a generated page instead of in these files       |
| [The interface](interface.md)             | closing a file, saying that it is working, type and fonts                  |
| [Known limits](limits.md)                 | what it cannot do, in its own words                                        |
| [Licence](licences.md)                    | MIT, and what the dependencies are                                         |

The argument behind each measurement is in the harness that took it, next to the
code it justifies: `tools/style-bench`, `tools/video-bench` and
`tools/edgetam-export`.

The pictures in `media/` are produced by `node tools/shots/run.mjs`, which drives
the real application, so a screenshot cannot go on describing an interface that
has changed.
