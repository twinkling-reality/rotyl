[Rotyl](../README.md) / Video

# Video, so far

![A video frame with its right half stylised, the timeline below it carrying In
and Out beside the frame count, and Frame and Clip export buttons above](media/video.webp)

Open an MP4 or a MOV, select a region, and play it. Every frame goes through the
same renderer a photograph does, the same style chain, the same composite, the
same selection.

## Playing it

**Playback holds full quality until it demonstrably cannot**, and the tolerance
for that is deliberately wide. This is an editor showing what a filter does, not
a media player, so a third of the frames carrying the real look beats all of
them carrying an approximation. When that was decided the chain measured 46 ms a
frame on a 720p clip at high detail against a 20 ms budget, and it still played
at 44 of 50 frames a second because the frames it cannot render are skipped
rather than queued. That case is cheaper now: the same setting measures 16 ms
since the flatten was bounded below the picture, and the default 40.
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

**And what is left of it is the input, not an invention.** A chain is a pure
function of its frame: hand it the same picture twice and it answers the same
twice, which is measurable rather than arguable. On a clip encoded with no
temporal grain the input moves 1.4 codes at the 99th percentile and every chain
answers with 1.0, which is the floor. There is nothing in a styled frame that
was not in the source frame, so a temporal method has nothing to remove that a
quieter input would not also remove.

What differs between chains is the GAIN, and the gain depends on the picture.
The drawn scene says every chain but print attenuates. A photograph of a brick
wall says the poster chain is at 1.36 and the comic chain at full detail is at
1.75, where at no detail it is 0.63. Both of those are one stage: the poster
outline, which the section below is about, and the anisotropic Kuwahara's sector
weighting, which the detail control used to hand raw grain by clamping the
flatten's buffer at the picture's own resolution and so turning the downsample
in front of it into a copy. That is bounded now, and what the bound did not
close is in [known limits](limits.md) with its number.

**A cleaner input was measured and does less than it looks.** Averaging each
frame against the one before it on the way in is one pass and needs no motion
estimation on a fixed camera. It takes the input down about a fifth and the
output down with it, and it makes the amplification WORSE wherever it was above
one, because what it removes is the part these chains attenuate hardest. It is
a way of reporting less flicker rather than of having less, so it is not here.

**And blending the previous stylised frame in is worse than the disease.** That
was measured before it was built, on a clip where five cars move against a city
that does not: half the last frame improves the residue by two fifths and costs
fifty-five codes of deviation around anything that moves, and 13% of the
gradient energy inside a moving car. On the clip with no moving grain, where
there is no residue left to remove, it makes the residue worse and costs the
same fifty-five codes. `tools/style-bench` has the counter-metric and the picture, and
[known limits](limits.md) has what none of it fixed.

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
be found again cannot be corrected, and it says which KIND of thing began there:
a mark for an edit somebody made, a bar for a run, and a faint stretch of that
bar where the model said the object was behind something. It also carries In and
Out, which say which
part of the clip an export writes, and nothing at all until one is set: a clip
somebody has said nothing about must not carry marks implying they have. The
letters are the ones every editor binds, shifted here because the unshifted
pair is taken by the Object tool and the tools come first. And undo moves the playhead to whatever it
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
measures 135 ms against playback's thirty-three, a memory bank is causal so
there is no meaning to running it backwards, and the frame provider costs
0.47 ms forward against fifteen to seek back. Behind the playhead and
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
something the first button already does. A stop is a field on what the run hands
back rather than an exception thrown out of it, which it was until the run had
anything to hand back at all.

**And a run says what it found, on the two occasions it is not what was asked
for.** A run that walked to the end of the clip and found the object on every
frame of it says nothing: the marks are the whole story and a line congratulating
a button on having worked would be the product talking over itself. A run that
was stopped says where it got to and that the frames it followed are kept, which
is the part nobody can see. And a run that lost the object behind something says
on how many frames, because a stretch of clip with no selection on it is exactly
what a tracker that failed looks like and is the opposite of one. It is the rule
a clip export already follows, in the same line, for the same reason.

**The model is asked, on every frame, whether the object is in it at all**, and
the answer used to reach nobody. An occluded frame gets an empty mask, which is
the reference's behaviour and is right, and an empty mask is also what a
selection erased down to nothing looks like: the log could not tell them apart,
so nothing downstream of it could either. The command carries the verdict now.
That is one optional field, the second thing in the log that says how a command
came to be rather than what it does, and the first was `group`. What it buys is
that the timeline can draw the occlusion, that a frame the model gave up on
stops reporting a selection nobody made, and that all of it survives a save and
a reload, which a fact about the run would not. What it costs is on
`/research/the-occlusion.html`.

**And a model has now written one.** Every `absent` command that had ever
existed in this repository was written by a test: by a tracker made of
arithmetic, by a benchmark, or by hand. The two end-to-end tests that drive a
real tracker skip on a build with no host, which is every build a clone can make
on its own, and had skipped in every run of this suite. Pointed at a local host
they pass, and there is a third beside them now whose answer is known before it
runs.
It opens the occlusion scene out of `tools/edgetam-export`, twenty-eight frames
in which a disc passes behind a bar for eight of them, and checks the frames the
model called absent against the geometry the harness drew rather than against
another run. The bar's width is the disc's diameter plus eight frames of travel,
so which frames it covers is arithmetic somebody did while drawing them.

It says the object is behind something on all eight of them, and on this machine
on the frame it first shows again as well, which is five per cent of a disc and
which the reference tracker is late on by the same one frame. So the test
asserts the eight and says nothing about the slivers at either end: that frame
is a coin flip, and encoding the same pictures differently lands on both sides
of it. What the clip cost to commit, and the ladder of encodes that decided its
settings, is in `e2e/fixtures/README.md`.

**The timeline draws a run as a run.** Three hundred frames is one gesture, and
until this chapter it was three hundred marks that looked exactly like three
hundred separate strokes, on a projection that was handed the frame numbers and
nothing else. It is one bar over the frames the run reached now, with the
stretches the object was hidden in drawn faintly inside it rather than left as
gaps, since a gap and a run that never got there are the same picture. The
anchor keeps its own mark, because where somebody chose and where the run
started are two facts and the track can carry both. Ten minutes of tracking went
from eighteen thousand elements to two, and it is two however many objects the
run followed, because a run is one gesture whatever it followed. What multiplies
with them is the commands the projection walks, which is why it was taken again
at several: it runs on every render of the editor, and 1.1 ms over eighteen
thousand commands is 1.4 over fifty-four thousand.

**Tracking a second object is a second seed.** `runTracking` takes a list of
masks, builds one track per mask, and advances all of them against one
embedding per frame, so reading the frame, which is the expensive half, does not
scale with the number of objects: measured end to end, one object is 135 ms a
frame and two are 226 rather than 270. The first track's command replaces what
was held forward, which is the drift being removed, and the rest add. A second
tracker is a second implementation of four methods and nothing else changes.

**The interface reaches that now, and what was missing was never the loop.** It
was a way to say WHICH objects. This product has one selection and no concept of
a set of them, and a second seed with no way to name, re-select or undo one of
them separately would have been a capability with no handle on it.

**It does not need one, because the log has been recording the answer since
object selection landed.** `SelectIntent` has three values and the first is
`object`, documented in its own type as "a different thing; starts a fresh
prompt". A fresh prompt clears the committed revision, so the model's answer to
it is a NEW `applyMask` command, where shift-click and alt-click refine the
prompt in place and replace the last one. Clicking two cars therefore leaves two
commands and clicking one car twice leaves one, which is exactly the distinction
a tracker needs and exactly the one the interface was already drawing. Nobody
had read it back.

So a run follows one object per answer the selection is made of, and the Track
button says how many before it is pressed: from the log rather than from the
GPU, which is where the button's own existence is decided from and where
coverage is inferred from for the same reason. There is no ninth button, no
mode, and no list for anybody to manage. Measured through the real build, the
whole of it is 0.56 KB gzipped on the application bundle, which is the one
number a feature in this product has to answer for: the framework was chosen at
59.5 KB against 6.1 for an interface that is a canvas and eight buttons, and it
is still eight buttons.

**Coverage no answer claims belongs to the first object.** A brush stroke and a
dragged rectangle are regions somebody drew rather than things a model was asked
about, so nothing in the log says whether two brushed blobs are two objects or
one. Giving them a track of their own would invent an object nobody named;
giving them to the first is what already happens, because until now there was
exactly one seed and everything was in it. That rule is what leaves a
single-object run byte for byte the run it was.

**And an occlusion stops being a fact about the clip and becomes a fact about an
object.** A run hands back one absence count per object rather than one number,
because three objects and nine absences is one object hidden for nine frames or
three hidden for three. The timeline needed nothing: it already answers a frame
the way the fold does, so a stretch is drawn faintly only where every object is
missing from it. On the fixture clip where one disc goes behind a bar and an
identical one stands beside it, following both draws no faint stretch at all
where following one draws the whole occlusion, and both pictures are correct:
the standing disc is selected on every frame of it.

**And so does the price, which four committed figures were silent about.** A run
writes one command per frame per object, so a second object is a second mask on
every frame it reaches. Ten minutes following three things is a 196 MB document
against 65 for one; the fold cuts at the first object's `replace` and therefore
leaves one command per object rather than one, so a replay unpacks that many
masks and costs 0.9 ms against 0.3. None of those figures was wrong and not one
of them said "per object", which is the whole of what reaching a second seed did
to them. What each of the four came back as at one, two and three objects is on
`/research/per-object.html`.

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

**What the browser does to the colour on the way there is the transfer the file
declares, and no probe here had ever declared one.** A frame is converted from
the transfer its bitstream states into the sRGB everything downstream expects,
and for five chapters that conversion was measured with clips that state no
transfer at all. An unspecified transfer defaults to BT.709 and the probes hold
sRGB values, so the eleven codes they came back out by in the midtones were the
browser believing a file rather than a defect in the path, and the 2D canvas
that does not have them is right about the content and wrong about the file.
Encode the same patches saying sRGB and the conversion does not happen; say
BT.709 and it does; say nothing and it does by exactly as much.

**Asked with a clip that says BT.709 and means it, the conversion is nearly
right and the alternative is worse.** Against ffmpeg converting the same file,
what lands in the texture is within a code from mid grey up. What is left is a
shadow error, up to seventeen codes, because the curve the browser applies
behaves like a pure power where BT.709's has a linear toe. A 2D canvas applies
nothing, which that clip needed, so it is out across the whole ramp, and getting
a frame onto the GPU through one costs 1.2 ms a frame at 1080p. So this stays as
it is, and what is left of it is in [known limits](limits.md) with both numbers.

**A full-range clip is the one colour question here that had no answer for four
chapters, and the answer is that it depends on which decoder the browser
picks.** Most footage is limited range, where black is 16 and white is 235; a
clip that says it is full range puts them at 0 and 255, and reading one as the
other is a contrast error over the whole picture with nothing on screen to
suggest it. Chrome's hardware H.264 decoder applies the flag and its software
decoder ignores it, and frame size is what chooses between them: the same
picture is exact at 1280x720 and thirteen codes out at 320x180. There is no
branch here to get right and no branch that could help, because
`VideoFrame.colorSpace` reports that clip as limited range either way, right
and wrong alike, and reports BT.709 primaries and transfer for a bitstream that
declares neither. The flag is readable; whether the decoder acted on it is not.
So it is in [known limits](limits.md) rather than corrected.

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

**Sound is not more frames, and it is still not a second loop.** A soundtrack is
a second stream whose packets do not land on frame boundaries and are not the
same number as the frames, so it gets a cursor of its own on the source and a
second method on the sink. What it does not get is a pass of its own over the
file, and that is a measurement rather than a preference. Written as one run
after the video, the sound of a given second sits most of the file away from its
picture and the distance grows with the clip, which is not a progressive file
whatever order the boxes are in. Written that way it is usually not a file at
all: with the index reserved, the muxer cannot size the movie box until it has
seen a packet from every track, so a run of video with the audio behind it
queues every frame in memory and, on a track carrying B-frames, fails before a
byte is written. So the loop asks on every frame whether the sound is behind and
hands over whatever is due, which is one comparison per frame and turns that
distance into a constant. `tools/video-bench` has the three arrangements.

**And the sound is copied rather than encoded.** The picture is re-encoded
because it was re-drawn; the audio was not touched, so what goes into the file
is the packets that came out of it, bit-identical, with nothing changed but the
moment they play. There is no `AudioDecoder` and no `AudioEncoder` anywhere in
this product and passing packets through needs neither. What that costs is two
edges: an AAC track's own priming packet sits at a negative timestamp that MP4
cannot express, and a range's in point lands inside a packet rather than between
two. Both are dropped, each is at most 21 ms at 48 kHz against a 33 ms frame,
and everything kept is at exactly the moment it was at in the source. The
alternative is re-encoding the first packet, which is exact and is also the only
thing that would stop the sound being the source's own bytes.

**A soundtrack the container cannot hold is said before the work.** An MP4 holds
eighteen audio codecs and QuickTime holds more, so a `.mov` with mu-law audio is
an ordinary file whose sound has nowhere to go. Deciding that costs a list
lookup on a track that is already open, so it is a fact about the open file
rather than an outcome of the export: it is in the row beside the file's name
and in the export button's own sentence, and it is said again when the file
lands. The one thing it must not be is a discovery made by playing the result.

**A range is a range on the export, not a trim of the document.** In and Out
mark which frames a clip export writes, and that is all they change: every
command in the log keeps its absolute frame number and still folds forward, so a
selection made on frame 0 still applies to a range that starts at frame 400. A
trim that renumbered frames would put the log and the timeline into
disagreement about what frame 500 means, and every edit made before the in point
would either move or stop applying. The one thing that is rebased is the
presentation timestamp, so the written file starts at zero, and that is a
property of the file rather than of the document.

**Where the bytes go is asked before any of them exist.** A browser that can be
handed a file writes each packet into it as the encoder makes one, so what the
tab is holding does not depend on how long the clip is. A browser that cannot
has to build the whole file first, and past some length that fails.
`showSaveFilePicker` is Chrome and Edge; Safari and Firefox have no way to let
somebody give a page a file. So this is two paths, and which one a session takes
is settled at the click rather than discovered at the end.
Encoding for five minutes and then asking where to put it would be the worst
possible order: by then the file is in memory, which is the thing a handle
exists to avoid, and the answer might be "nowhere".

**The index still goes at the front, and that is what made the file path worth
building rather than obvious.** A stream writes forward, and a container written
forward puts its index at the END, which is a different file: nothing plays it
until the last byte has arrived and nothing seeks it without reading to the end
first. So the room for the index is RESERVED before the first frame and seeked
back to at the finish. That needs a writable stream that can seek, which a file
handle gives, and an exact packet count, which an export has: it knows how many
frames it is writing before it renders the first one. What is left of the
reserved room becomes a `free` box, which is under a megabyte on a ten minute
clip.

Reserving is what the path with no file to write into does now as well, and it
is not what it did before. Building the file in memory used to mean holding
every encoded packet until the end and only then assembling them, so the media
existed twice at the moment it was written out. Reserving writes each packet
into the file as its chunk closes instead, which holds one copy rather than two,
and, the part the interface needs, makes how large the file has got so far
something the sink can read as it goes.

**And that path has a ceiling, which is now stopped at rather than run into.**
The known limits page used to say a ten-minute export would be about a gigabyte
and that there was no answer to that beyond failing. Ten minutes works. What
fails is twenty-five, at finalize, three and a half minutes in, and the heap
grows one for one with the file all the way there, so the ceiling is arithmetic:
four times the file has to fit at the moment it is finished, twice in the buffer
it is assembled in because that buffer doubles, once more for the copy sliced
out of it and once more for the blob a download is handed. So the budget is the
browser's own heap limit over four, and past it the export ends where it got to
and hands over a clip of that. Given a file to write into there is no budget at
all, because nothing is being held: measured over twenty-five minutes, the heap
grows by half a megabyte per thousand frames, which is the noise of a decode
loop. `tools/video-bench` has the ladder.

**And it costs a long export nothing.** Twenty-five minutes of 1080p into a
file, with a soundtrack and without, is 4.99 ms a frame against 5.00 and eight
megabytes more peak heap on a two gigabyte file. Those eight megabytes are the
second track's sample table in the reserved index rather than anything piling
up, so the property the last chapter rests on, that a streaming export holds
nothing however long the clip is, survives a second track.

**The index still goes at the front with two tracks in the file**, which needs
one more thing than it did with one: `reserve` sizes the sample tables before
the first sample lands, so EVERY track needs a maximum packet count up front.
The video's is free, since an export knows how many frames it is writing before
it renders the first one. The audio's is a metadata-only walk of the whole
track, which reads the sample tables and none of the payload, at about a
microsecond a packet. Fifty milliseconds on twenty minutes of 48 kHz audio, paid
once, before anything slow.

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
at 1080p for poster and print, 143 for comic, which was 339 before its flatten
was bounded below the picture. Which is why an export says how
far it has got and can be stopped, and why Stop replaces the buttons rather than
sitting beside them. There is exactly one thing to do while it runs.

**Stopping keeps what it wrote.** It used to abandon, and that was right while
the file existed only in memory: nothing had been promised and nothing was lost.
It stopped being right once the bytes go into a file somebody named, because a
picker creates that file the moment it is chosen, so abandoning leaves nothing
usable where they asked for a video. A stop finishes the file at the frame it
reached instead, which is a clip anything can open of the part that was
rendered. That is the rule a stopped tracking run already follows and for the
same reason: a run cut short did the work up to where it got to, and that work
is worth what it would have been had the clip ended there. The one exception is
a stop before the first frame, where there is nothing to keep: a page can
neither delete a file it was handed nor stop a writable stream committing when
it closes, so what is left there is a header with no index, and the interface
says that rather than leaving it to be discovered.

The interface carries that rather than a comment carrying it. The button's title
is what pressing it will do, and what came out is reported whenever it is not
what was asked for: an export that wrote four minutes of a fourteen minute clip
and said nothing would be indistinguishable from one that wrote all of it.

**The encoder is the pipeline.** Handed the same picture with the GPU taken out
of the loop entirely it measures 4.7 ms a frame at 1080p against 5.0 for
everything, because every stage before it runs on threads it is not using.
Writing the packets into a container rather than binning them costs a tenth of a
millisecond, so whatever a muxer costs, it is not per frame.

**And rate control had to be said out loud.** A qualitative quality level
resolves to a quantizer where the codec supports one, which is constant quality
and an unbounded file: measured on a styled 1080p frame, the default asks for
23 Mbit/s where the same level asked for as a bitrate is 6. Neither is faster.
It is nearly four times the size of every file anybody exports, for nothing, and
it is the one figure in that table that moves between runs, because constant
quality prices the picture rather than the setting.

Keyframes are written every second rather than every two, which costs some bytes
and buys a file this editor can scrub: seek cost is set by keyframe spacing and
by nothing else.

**The container writer is behind its own dynamic import**, one further in than
the demuxer, and that is a measured decision rather than tidiness: writing costs
42.8 KB gzipped on top of a chunk that already reads, which is nine tenths of
the whole application bundle and was all of it until a selection could be saved.
A photograph fetches
neither, a video fetches the reader, and only asking for a clip fetches the
writer. A second container inside it would cost eleven bytes, for the same
reason `.mov` costs forty-nine on the way in.

**Colour needed nothing on the way out either.** Sixteen flat patches through
the composite, out through the encoder and back come out bit-identical to the
same patches encoded by ffmpeg and decoded the same way. The error is entirely
the transfer conversion the upload applies to any 4:2:0 frame, which is measured
and attributed above and is the same on both sides of the comparison, and the
container is tagged BT.709 limited range, which is what an H.264 file is
supposed to say.

What decided all of this, and what it cost to find out, is in
`tools/video-bench`, including the two numbers that say tracking cannot live
in the render loop.
