[Rotyl](../README.md) / Video

# Video, so far

![A video frame with its right half stylised, the timeline below it, and Frame
and Clip export buttons above](media/video.webp)

Open an MP4 or a MOV, select a region, and play it. Every frame goes through the
same renderer a photograph does, the same style chain, the same composite, the
same selection.

## Playing it

**Playback holds full quality until it demonstrably cannot**, and the tolerance
for that is deliberately wide. This is an editor showing what a filter does, not
a media player, so a third of the frames carrying the real look beats all of
them carrying an approximation. The chain measures 46 ms a frame on a 720p clip
at high detail against a 20 ms budget, and it still plays at 44 of 50 frames a
second because the frames it cannot render are skipped rather than queued.
Dropping to the draft tier unconditionally was the first attempt and it was
wrong twice over: on a small clip at high detail the two tiers are the same
render anyway, since both clamp to the clip's own short edge, and on a large one
no tier saves it. Nothing here is affected by tracking, which is a job
rather than a render-loop activity; see below.

A panel of stylisation over a moving scene is what the Area tool is for: drag a
rectangle once and the traffic runs through it. The tools either side of the
toolbar's divider are in [selecting an object](selection.md).

## What boils, and what does not

**Every stage runs per frame with no knowledge of the last one**, which is the
thing most likely to make stylised footage look cheap: a decision that flips
between two frames boils, however good either frame is.

The comic chain being the steadiest of the three is the opposite of what was
expected of it, and it holds on photographs as well as on the drawn scene the
first measurement used: an anisotropic Kuwahara does not choose between two
nearly equal sectors on one pixel's noise, it chooses on the variance of two
hundred samples.

What does boil is a hard threshold against a fixed field, which is what a
halftone dot is, and what a hard quantiser would be if it were left hard. The
poster style's first version measured a 99th percentile of 23 codes and 1.7% of
pixels visibly flickering; putting a floor under the width of every soft
transition, in the units of the thing being decided rather than in pixels, took
that to 4.9 and 0.6%, at no cost anyone can see on a still. That rule
generalises: a style may make any decision it likes, as long as the decision is
allowed to be undecided somewhere.

**The rule was not applied everywhere, and it took a photograph to show it.**
The poster style's outline compared two quantised colours a line's width apart,
which is a hard decision with a neighbour on one side of it and therefore no
derivative to floor. On a drawn scene of large flat regions that is invisible.
On a brick wall it amplified its input 5.7 times, because a brick wall is
nothing but marginal region boundaries.

**And the answer was a different operator, which is the second half of the
rule.** A floor under a transition works when the quantity being decided is
continuous. That one was not: it was a distance between two rounded colours, and
rounding is the one thing a width cannot resolve. Both hard decisions in it were
softened, in every combination and at four widths, and the best of those stopped
three times above the floor. So the rounding went instead. The
outline measures the flattened colour itself and a stroke's weight is that
distance, which is continuous in the picture by construction, and the wall goes
from 5.7 times its input to 1.36 against 0.95 for the same chain drawing no
outline at all. What that costs is the contours the quantiser used to draw
across a nearly flat field, which were the banding artefact rather than a
boundary between two things. What it does not do is close the gap completely,
and that is in [known limits](limits.md) with its number rather than in a plan.
`tools/style-bench` has all of it, including the four tuning passes that came
first.

## A selection belongs to a frame, and to every frame after it

**A selection holds from the frame it was made on until something later changes
it**, which is what every keyframe system does and what a selection is for: a
region of the picture that a style applies to, stated once and true from then
on. Scrub or play past it and the style is still there.

The other reading is that a command applies to its own frame alone, and it is
right about something real: a stroke's coordinates say where something _was_
when it was drawn, so a selection held across a moving subject drifts off it.
This was built that way first and it was the wrong call. With nothing producing
the missing frames, exact match does not trade drift for accuracy. it trades a
selection that drifts for no selection at all. Holding forward is wrong slowly,
and only when the subject moves. Exact match is wrong immediately and always.
Tracking is what produces those frames, and it needed none of this to change:
its commands fold on top of the held value at each frame it reached, so the gap
gets filled in properly rather than held, by the mechanism that was already
there.

Two smaller things, both the difference between honest and usable. The timeline
marks the frames where an edit begins, because a selection whose origin cannot
be found again cannot be corrected. And undo moves the playhead to whatever it
undid: the log is one list with one cursor, so undo means the last thing you
did, which may be somewhere you are not looking. An edit disappearing in front
of you is undo, and an edit disappearing off screen is a bug report. Following
the cursor also disarms the sharp edge, since the next stroke discards the redo
tail and now does it on the frame the user is actually on.

The fold is sorted by frame rather than left in the order the edits were made.
Someone who paints at frame 100 and then scrubs back to clear frame 20 means the
clear to happen first; in log order it would happen last and wipe frame 100's
work while frame 100 was on screen.

A still image is a one-frame document. `frame` is required on every command
rather than optional, so there is no second shape to reason about and no branch
anywhere asking which kind of file this is.

## Tracking, and where it runs

**It is wired up, and it needs a host to fetch two graphs from.** The loop, the
memory bank, the second decoder and the button are all here;
`memory_attention_shared_fp16.onnx`, `memory_encoder.onnx` and
`parameters.json` are in no published release, so a build says where they are or
the feature is not offered:

```bash
VITE_TRACKING_HOST=https://example.org/edgetam pnpm build
```

**There is deliberately no default.** A wrong guess does not fail at start-up,
it fails after fetching nineteen megabytes at the moment somebody presses Track,
so with nothing configured there is no Track button rather than one that can
only apologise. `tools/edgetam-export` produces the three files in two commands
and says what a host owes anyone it serves them to, which is the Apache-2.0
licence text and a note that the files were modified.

**What the tracker computes is checked against the reference and not against
its author.** Half of a tracked frame is not in any graph: the transposes
between four sessions, the memory bank's layout, the prompt a frame with no
click sends, and the arithmetic either side of the memory encoder. Every one of
those fails by producing a plausible mask of roughly the right object.
`tools/edgetam-export/host.py` runs each of them against the reference's own
inputs; three were wrong when it was first run and none of the three produced an
error. The numbers are on `/research/the-host.html`, and the fixture it writes
is what `test/memory-bank.test.ts` asserts the TypeScript against.

The part that is this project's own design rather than the model's is
`src/core/perception/tracking-job.ts`, which is DOM-free, has one seam, and is
tested against a tracker made of arithmetic.

**It does not follow the playhead, and that is the decision.** A tracked frame
is about ninety milliseconds against playback's thirty-three, a memory bank is
causal so there is no meaning to running it backwards, and the frame provider
costs 0.47 ms forward against fifteen to seek back. Behind the playhead and
ahead of it were both on the table and are wrong the same way: both make the set
of frames that end up tracked a function of where somebody happened to scrub.

So it is a job. It starts on the frame the selection was made on and walks
forward at its own pace, and the playhead and the tracker become two independent
cursors over one document. Frames it has reached show what it found; frames it
has not show the held-forward selection they showed before, which is the fold's
existing behaviour and needed no change.

**One gesture, one undo.** Three hundred frames is three hundred commands, and
three hundred presses of undo is not undo. Commands from one run carry a group,
and undoing a group lands the playhead on the frame the selection was made on
rather than three hundred frames later where it stopped. That is one field on
`SelectionCommand` and two loops in `SelectionDocument`.

**Stopping keeps what it found.** A run abandoned half way has followed the
object as far as it got, and that work is worth what it would have been had the
clip ended there. Making Stop mean undo would be a second, worse button for
something the first button already does.

**Tracking a second object is a second seed.** `runTracking` takes a list of
masks, builds one track per mask, and advances all of them against one
embedding per frame, so reading the frame, which is the expensive half, does not
scale with the number of objects. The first track's command replaces what was
held forward, which is the drift being removed, and the rest add. A second
tracker is a second implementation of four methods and nothing else changes.

**Two cursors need two decoders.** A run opens a second `FrameProvider` over the
same file and a full-resolution texture of its own. Sharing the playhead's would
be each cursor cancelling the other's reads, since a provider lets a newer
request supersede whatever is in flight, which is exactly right for a pointer
being dragged along a timeline and exactly wrong for two readers. It also keeps
the reads cheap: a run only ever moves forward, so it never re-seeks after the
first frame, at 0.47 ms a frame against fifteen for a seek.

**What it does not share is the expensive half twice.** A run reads each frame
with the same vision encoder a click is answered by, borrowed from the
perception store that owns it, so tracking costs no second download and no
second copy of the weights in memory.

What produces the files it fetches is in `tools/edgetam-export`: two graphs the
published release does not contain, four parameters from the checkpoint, and a
position encoding worth computing rather than shipping.

## Getting frames out of a file

**There is no such thing as decoding frame N.** There is decoding from the
keyframe at or before N and discarding what comes between, so what a scrub costs
is set by keyframe spacing and by nothing else. Measured on 1080p30: the next
frame costs 0.47 ms, a seek costs 15 ms on a clip with one-second keyframes and
88 ms on the same content with a single keyframe. That one fact is the whole
design of the frame provider, one decoder is held open and fed forward, and it
re-seeks only when the target is behind the playhead or when a keyframe lies
between the two, which is exactly when starting again is cheaper than
continuing.

It also decides what an export writes. A clip leaves here with a keyframe every
second rather than every two, which costs some bytes and buys a file this editor
can scrub at the speed the row above describes rather than the one below it.

Frames are addressed by index, and the index is built by walking the container
rather than by dividing a duration by a frame rate. A variable frame rate, or
the two-frame offset an edit list introduces on an ordinary file with B-frames,
would both make "frame 1043" mean something different to the decoder than to the
person who selected it, and eventually to the command log, which is what a
frame index has to be exact for.

**A decoded frame needs no colour path of its own.** It arrives as YCbCr, and
what lands in the source texture is the same sRGB-encoded byte an image decodes
to, within one code on a losslessly encoded probe. The sRGB view downstream then
does the decode in hardware, exactly as it does for a photograph. Writing it
through an sRGB view instead encodes it twice and is wrong by 73 codes at mid
grey, which is the kind of thing that is obvious in a measurement and invisible
in a review.

The demuxer is mediabunny, reached through a dynamic import, so a session that
never opens a video never fetches it. MP4 and QuickTime only: they share one
demuxer, so accepting `.mov` costs 49 bytes, where Matroska is a second demuxer
at 14 KB carrying codecs whose decode has not been measured here.

## Writing the clip out

Export offers two answers on a clip and one on a photograph, and the one that
gets the weight is the clip, because the clip is what somebody opened a video to
make. The frame on screen stays available beside it, quieter by size and colour
rather than hidden behind anything.

**It is the same loop, not a second one.** A source hands over frames and a sink
takes them; a photograph is a one-frame document and goes through it once. So
the renderer, the parameters and the pass it stops at are the same three things
they were when export could only write a picture, and the only new decision is
which pair the user asked for. A second container would be one entry in a table,
and a second codec one entry in another.

**The composite reaches the encoder through the canvas it already renders into.**
Measured, per frame at 1080p: capturing the canvas costs nothing detectable,
where copying the composite into a buffer and rebuilding a frame from the bytes
costs 1.4 ms and needs every row de-padded to undo the 256-byte alignment WebGPU
imposes on texture-to-buffer copies.

That path had to be checked rather than assumed, because a canvas is PRESENTED
rather than read, so capturing one is a claim about when as much as about what.
Being one frame out would be invisible in every timing number and would put the
selection drawn on frame N onto the pixels of frame N minus one. Run for real
and decoded back, all sixteen probe frames matched the source frame they were
rendered from and no other.

**A clip is written several times faster than it plays**, for a style that fits
inside a frame, and several times slower for one that does not: 5.0 ms a frame
at 1080p for poster and print, 339 for comic. Which is why an export says how
far it has got and can be stopped, and why Stop replaces the buttons rather than
sitting beside them. There is exactly one thing to do while it runs.

**The encoder is the pipeline.** Handed the same picture with the GPU taken out
of the loop entirely it measures 4.7 ms a frame at 1080p against 5.0 for
everything, because every stage before it runs on threads it is not using.
Writing the packets into a container rather than binning them costs a tenth of a
millisecond, so whatever a muxer costs, it is not per frame.

**And rate control had to be said out loud.** A qualitative quality level
resolves to a quantizer where the codec supports one, which is constant quality
and an unbounded file: measured on a styled 1080p frame, the default asks for
30 Mbit/s where the same level asked for as a bitrate is 12. Neither is faster.
It is five times the size of every file anybody exports, for nothing.

Keyframes are written every second rather than every two, which costs some bytes
and buys a file this editor can scrub: seek cost is set by keyframe spacing and
by nothing else.

**The container writer is behind its own dynamic import**, one further in than
the demuxer, and that is a measured decision rather than tidiness: writing costs
41.6 KB gzipped on top of a chunk that already reads, which is the size of the
whole application bundle to the tenth of a kilobyte. A photograph fetches
neither, a video fetches the reader, and only asking for a clip fetches the
writer. A second container inside it would cost twelve bytes, for the same
reason `.mov` costs forty-nine on the way in.

**Colour needed nothing on the way out either.** Sixteen flat patches through
the composite, out through the encoder and back come out bit-identical to the
same patches encoded by ffmpeg and decoded the same way. The error is entirely
the midtone shift Chrome applies on the 4:2:0 decode path, which was already
measured and attributed, and the container is tagged BT.709 limited range, which
is what an H.264 file is supposed to say.

What decided all of this, and what it cost to find out, is in
`tools/video-bench`, including the two numbers that say tracking cannot live
in the render loop.
