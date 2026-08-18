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
no tier saves it. Tracking does not exist yet.

A panel of stylisation over a moving scene is what the Area tool is for: drag a
rectangle once and the traffic runs through it. The tools either side of the
toolbar's divider are in [selecting an object](selection.md).

## Why stylised footage does not boil

**Every stage runs per frame with no knowledge of the last one**, which is the
thing most likely to make stylised footage look cheap: a decision that flips
between two frames boils, however good either frame is. Measured on a fixed
camera, where everything that differs between consecutive frames is grain and
the codec's own noise, no style amplifies its input and all three attenuate it.
In output codes, the 99th percentile per-pixel change from one frame to the next
is 9.5 for the source, 3.2 for comic, 4.5 for poster and 12.6 for print.

The comic chain being the steadiest is the opposite of what was expected of it:
an anisotropic Kuwahara does not choose between two nearly equal sectors on one
pixel's noise, it chooses on the variance of two hundred samples. What does boil
is a hard threshold against a fixed field, which is what a halftone dot is, and
what a hard quantiser would be if it were left hard. The poster style's first
version measured a 99th percentile of 23 codes and 1.7% of pixels visibly
flickering; putting a floor under the width of every soft transition, in the
units of the thing being decided rather than in pixels, took that to 4.5 and
0.5%, at no cost anyone can see on a still. That rule generalises: a style may
make any decision it likes, as long as the decision is allowed to be undecided
somewhere. `tools/style-bench` has the numbers and how they were taken.

## A selection belongs to a frame, and to every frame after it

**A selection holds from the frame it was made on until something later changes
it**, which is what every keyframe system does and what a selection is for: a
region of the picture that a style applies to, stated once and true from then
on. Scrub or play past it and the style is still there.

The other reading is that a command applies to its own frame alone, and it is
right about something real: a stroke's coordinates say where something _was_
when it was drawn, so a selection held across a moving subject drifts off it.
This was built that way first and it was the wrong call. Nothing can currently
produce the missing frames, so exact match does not trade drift for accuracy.
it trades a selection that drifts for no selection at all. Holding forward is
wrong slowly, and only when the subject moves. Exact match is wrong immediately
and always. When tracking lands it will contribute commands on the frames it has
followed the object to, and those fold on top of the held value at each of them:
the same mechanism, with the gap filled in properly rather than held.

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
