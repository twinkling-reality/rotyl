# shots

The pictures in the README and in `docs/`, taken by driving the real
application.

```bash
pnpm dev --port 5180          # in another shell
node tools/shots/run.mjs
```

Writes `docs/media/hero.gif`, `docs/media/video.webp` and
`docs/media/styles.webp`, and deletes its own intermediate frames.

**They are generated rather than captured by hand**, for the reason the research
figures are: a binary artefact nobody can regenerate is a liability, and a
screenshot that has quietly stopped matching the interface is worse than none.
Re-run this after anything that changes the chrome.

**The scene is synthesised, not photographed.** It is the same street the style
bench measures against, drawn by `tools/style-bench/make-scene.mjs` with no
dependencies. A photograph cannot be checked in, licensing aside, and a picture
nobody else has is a picture nobody else can reproduce.

**The hero selects the right half and nothing else.** A rectangle over part of
the subject is what the Area tool is for, but a split down the middle is the
clearest statement the product can make: the same content, plain on one side and
stylised on the other, while the camera pans across both.

## What it costs, and why those numbers

| file        | size   |
| ----------- | ------ |
| hero.gif    | 1.3 MB |
| video.webp  | 40 KB  |
| styles.webp | 48 KB  |

A GIF is the only moving format GitHub renders from a repository path, and it is
an expensive one, so it is held to 680 pixels across 32 frames of 48 colours.
That is where the split still reads and the file stops being rude to anyone
cloning. The stills are WebP, which is what flat interface chrome compresses to
almost nothing, and the same format the research figures use.

The palettes are not decoration. A stylised hazy street with no palette comes
out grey, which is the failure the palette exists to fix rather than a fair
picture of the chain, so the hero uses Riso and the style panel shows Mural.
