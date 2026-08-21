[Rotyl](../../README.md) / End-to-end fixtures

# What these files are, and how to make them again

The files the Playwright suite opens. They are committed because a test that
fetched its own input would be a test of the network, and they are written down
because a binary artefact nobody can regenerate is a liability. That is the same
rule the font subsetting command in
[the interface](../../docs/interface.md) follows.

Four of the five are tiny. The fifth is a megabyte and has a section of its own
at the bottom, because what it cost and what decided its settings are both
larger questions than the others put together.

**`sample.png`** is an ordinary photograph small enough to decode instantly.

**`sample.mp4`** is two seconds of 320x240 H.264 with an AAC soundtrack. The
video was made once and is stream-copied from then on, so the pixels the export
tests compare against have never moved:

```bash
ffmpeg -i sample.mp4 \
  -f lavfi -i "anoisesrc=color=pink:seed=7:sample_rate=48000:duration=2:amplitude=0.4,aformat=channel_layouts=stereo" \
  -map 0:v -map 1:a -c:v copy -c:a aac -b:a 96k -movflags +faststart out.mp4
```

The soundtrack is there because a clip export carries audio through, and a
fixture with no audio track cannot tell an export that carries it from one that
drops it. Pink noise rather than a tone, so every packet is a different length:
packets that are all the same size make any arrangement of them look regular.

**`sample-mulaw.mov`** is the same video again with a mu-law soundtrack. It
exists so the branch that refuses to carry a soundtrack is a branch that gets
run: QuickTime holds mu-law and MP4 does not, so this is an ordinary file whose
sound has nowhere to go.

```bash
ffmpeg -i sample.mp4 -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=2" \
  -map 0:v -map 1:a -c:v copy -c:a pcm_mulaw sample-mulaw.mov
```

**`sample.webm`** is refused by signature and never decoded, so what is in it
does not matter beyond the first four bytes.

## The occlusion clip, which is the one that is not small

**`occlusion.mp4` and `occlusion.json`** are the only fixture here whose right
answer is known before anything runs, and they are the whole reason this suite
can say anything about tracking through an occlusion. `sample.mp4` is colour
bars with a timecode burned into them. There is no object in it and nothing goes
behind anything, so a real tracking run over it can show that commands get
written and can show nothing whatever about a frame the model was asked about
and answered.

The clip is `tools/edgetam-export/make_fixture.py`'s occlusion scene, which is
the one the tracker's own measurements are taken on: 854x480, twenty-eight
frames, a disc crossing behind a bar and coming out the far side with an
identical disc waiting there. The bar's width is the disc's own diameter plus
eight frames of travel, so which frames it is wholly hidden on follows from the
geometry rather than from anybody's observation of a model. `occlusion.json` is
that scene's `truth.json`, copied here because `tools/edgetam-export/fixture/`
is gitignored at 66 MB of PNG, and the test reads it rather than holding
literals.

```bash
(cd tools/edgetam-export && ./venv/bin/python make_fixture.py occlusion)

ffmpeg -framerate 12 -i tools/edgetam-export/fixture/occlusion/f%02d.png \
  -vf "scale=out_color_matrix=bt709:out_range=tv" \
  -c:v libx264 -pix_fmt yuv420p -crf 24 -bf 0 -g 12 \
  -colorspace bt709 -color_range tv -movflags +faststart \
  e2e/fixtures/occlusion.mp4

cp tools/edgetam-export/fixture/occlusion/truth.json e2e/fixtures/occlusion.json
```

`make_fixture.py` seeds its generator with a constant and deletes the frames it
is about to replace, so the first line reproduces the same twenty-eight
pictures; the second is the only step whose bytes depend on a local x264, which
is why the clip is committed rather than built by the suite.

**No B-frames, so decode order is presentation order** and packet N is
`truth.frames[N]`, which is the identity the whole assertion rests on. And the
colour matrix is stated rather than left to be guessed: 480 lines is exactly
where one decoder assumes 601 and another 709, and everything the model is shown
arrives through it.

### It is a megabyte, and that is the picture rather than the setting

`make_fixture.py` draws a new background on every frame, so there is no temporal
redundancy anywhere in this clip: it is twenty-eight independent pictures, and
H.264 has nothing to predict from. At 1,047,671 bytes it is fifteen times
`sample.mp4` for less than half the frames, and no encoder setting changes that.

### What the quality is, and why it was measured rather than picked

The same command with `-crf` varied, each one run through the real tracker from
the same seed. The third column is PSNR against the frames the clip was made
from. The fourth is what the run reported on the machine every number in this
project was taken on, and it is the only column that could read differently on
another one.

| crf | file      | against the frames | what the run reported              |
| --- | --------- | ------------------ | ---------------------------------- |
| 18  | 2,145,499 | 37.7 dB            | absent on 12 to 20, came back      |
| 20  | 1,795,589 | 36.9 dB            | absent on 12 to 20, came back      |
| 22  | 1,443,976 | 35.8 dB            | absent on 12 to 20, came back      |
| 24  | 1,047,671 | 34.5 dB            | absent on 12 to 20, came back      |
| 26  | 620,288   | 33.1 dB            | absent on 12 to 20, came back      |
| 27  | 396,262   | 32.5 dB            | absent on 12 to 20, came back      |
| 28  | 240,185   | 32.0 dB            | absent to the end, never came back |
| 29  | 158,298   | 31.8 dB            | absent to the end, never came back |
| 30  | 122,077   | 31.7 dB            | absent on 11 to 20, came back      |
| 32  | 88,992    | 31.4 dB            | absent on 11 to 20, came back      |

**Every row reports the object absent on all eight frames the bar covers, and
not one of them misses a frame.** That is what the test asserts, and it is the
part that does not depend on the encode at all.

**What does depend on it is what happens afterwards.** Two encodes never find
the object again: the run stays absent through to the last frame, including the
four the whole disc is back in view on. That is not a quality floor, because the
two rows below them are coarser and come back. It is a band, and no mechanism
for it has been established here. What is known about its edges is that they
move: the same ladder encoded without the colour matrix above puts crf 27 in the
band as well, and it comes back once the matrix is stated. So the decisions
inside the band are marginal rather than wrong, and a clip that lands in it is a
clip this test would be measuring instead of the tracker.

So the committed clip is four steps and 2.5 dB clear of the nearest failure
rather than one step, and that is the whole of what decided crf 24. Halving the
resolution instead, which is the obvious way to make it small, does not work:
428x240 at 99,574 bytes never comes back either.

### The one frame it is allowed to disagree about

Nearly every row above reports frame 20 absent as well, which is one more than
the eight the bar covers. Frame 20 is the frame the disc first shows again, at
five per cent of itself. The reference tracker gets it wrong by exactly one
frame too, which is the `reacquisition_delay` on `/research/tracking.html`, and
`/research/the-host.html` already says a run's answer there is which side of a
coin flip it landed on. The seed moves it too: the committed clip seeded with
the square inscribed in the disc rather than with the disc's bounding box, which
is the same gesture drawn a third smaller, reports frame 21 absent as well. So
the test asserts the frames the bar covers and the frames the whole disc is in
view on, and says nothing about the slivers between them.
