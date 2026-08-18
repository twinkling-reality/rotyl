[Rotyl](../README.md) / The interface

# The interface

## Closing a file

The X beside the wordmark gives the file back: the decoder and its hardware
decode session, the source texture and mask on the GPU, the command log, and
whatever the perception layer had understood about the picture. A full-
resolution photograph and its mask are hundreds of megabytes, so closing one
has to release them rather than wait for the next open to displace them.

The style and its controls survive on purpose. They are a choice about how the
tool is set up rather than about this photograph, and re-picking a palette on
every file would be the tool forgetting what it was told.

For most of this project's life a session held one file and opening a second
meant reloading the page. The load path had been re-entrant the whole time.
What was missing was any way out of the one that was open.

Closing over work asks first, in place, and forgets it was asking after four
seconds so it cannot sit there armed. Closing over nothing does not ask at all,
because a confirmation nobody needs is the fastest way to teach people to click
through confirmations.

## Saying that it is working

One component, `src/app/Activity.tsx`, and every wait in the product goes
through it: opening a file, restoring after a lost device, downloading the
object model, reading a frame, finding an object, exporting. A product that
spins one way here and pulses another way there reads as several products.

It is a shimmer across the words rather than a spinner. A spinner says
something is happening; text that says what is happening says that too, and
answers the next question as well. The sweep is what stops it reading as a label
that has got stuck, which is the whole job the spinner was doing. Where a real
fraction exists there is a hairline under it, and the model download is the only
place one does.

**Nothing appears for the first 220 ms.** Under that, an indicator is a flash
the eye reads as a glitch, and the work has finished before anyone has worked
out what appeared. Over it, silence reads as a hang. Most opens and every style
change therefore show nothing at all.

The file picker gets the same treatment, and needs it most: a file input fires
no event for "the dialog is open", so a click used to produce nothing visible
until the operating system got around to drawing it. Window focus is the only
signal that it closed, because `change` fires when a file is chosen and never
when the dialog is dismissed.

Everything that arrives on screen arrives the same way: four pixels and a fade,
over 140 ms. There is no matching exit, because an element that animates out has
to stay mounted while it does, and that is a piece of timing state in every
component that can disappear. Things arrive gently and leave at once. Asking for
less motion removes the sweep rather than freezing it half way, which is what
the global reduced-motion rule alone would have done.

## Type and fonts

Geist and Geist Mono, SIL OFL 1.1 (see `public/fonts/LICENSE.txt`). Subset to
latin and clamped to the weights actually used. 23.2 KB and 8.1 KB. Regenerate
from the `geist` npm package with:

```bash
fonttools varLib.instancer Geist[wght].ttf wght=300:500 -o _geist.ttf
pyftsubset _geist.ttf --output-file=public/fonts/geist-latin-300-500.woff2 \
  --flavor=woff2 --unicodes="U+0000-00FF,U+2000-206F,U+2122,U+2212" \
  --layout-features="kern,liga,tnum,case,frac,ss03" --no-hinting --desubroutinize
```

Icons are eight Lucide paths inlined into `src/app/icons.tsx` (ISC). A kilobyte
of geometry did not justify a dependency.
