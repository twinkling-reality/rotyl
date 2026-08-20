[Rotyl](../../README.md) / End-to-end fixtures

# What these files are, and how to make them again

Three small files the Playwright suite opens. They are committed because they
are tiny and because a test that fetched its own input would be a test of the
network, and they are written down because a binary artefact nobody can
regenerate is a liability. That is the same rule the font subsetting command in
[the interface](../../docs/interface.md) follows.

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
