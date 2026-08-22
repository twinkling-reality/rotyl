[Rotyl](../README.md) / What was measured

# What was measured, and where it lives

**Every number this project relies on is on a page generated from the harness
that took it.** `/research.html`, linked from the top right before a file is
open: an index, and a page per finding. What a style costs and whether it holds
still, what decode costs and where colour goes, what writing a clip costs, what
tracking would cost before building it, what editing costs, and a ledger of
every approach that was tried and dropped with the number that decided it.

**The tables are not written, they are read.** Generated at build time out of
the harnesses' own `results.json`, which is the point of it rather than a detail
of it: a path that no longer resolves fails the build, so a stale number cannot
reach a reader who has no way of checking it. This README carries none of those
tables for the same reason. Every figure quoted in prose here is one somebody
could check against a page that regenerates.

One entry is one finding, because the question a reader has is "what did we
learn" rather than "which harness produced this". One harness therefore writes
more than one results file, and an entry names the one it reads rather than
having it inferred, so re-taking one measurement does not re-date a page that
did not move. Dates come from the commit that last touched that file, so "is
this current" has an answer.

The model release and the CI gate each have a harness of their own for the same
reason. `tools/model-assets` measures first-page, served, cached, invalidated and
digest costs without re-taking a video timing. `tools/ci-bench` records the unit
suite's assertion report separately from its native process exit, without
re-dating either model delivery or a renderer. Their generated pages are
`/research/model-delivery.html` and `/research/ci.html`. The local CI result did
not transfer to GitHub's virtual Macs, so the hosted runner and installed-Chrome
decision is a separate measurement at `/research/hosted-ci.html`, with its own
result files and command.

**One of the inputs is fetched rather than drawn**, which is the one exception
to everything else here being reproducible from the repository alone. It is
pinned by hash and it exists because the alternative was worse: the measurement
it feeds is the one the per-frame design rests on, and a number nobody can
re-take is a number nobody can contradict. `tools/style-bench/fetch-real.sh`
argues it at length.

The entries that argue about a look carry pictures, and the rest do not. An
argument about whether output is worth looking at that shows none of it is asking
to be taken on trust; a page of decode timings with a hero image on top is a
marketing habit. The figures are rendered by the same harness, from the same scene,
through the same compositor as the numbers beside them, and their captions name
the tiles from the figure's own metadata, so a caption cannot describe a picture
that changed underneath it. They are the one generated artefact here that is
committed, because they need a GPU and a browser to produce and the build cannot
make them; what the build does instead is refuse to reference one that is
missing.

It is a static file and not a route, so it costs the application bundle nothing.
Vite renders it per request in development and emits it at build, and nothing
generated is checked in.
