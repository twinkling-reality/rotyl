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

**Opening a saved document is the one thing that overrides that, and it is not a
contradiction.** Closing a file is the ABSENCE of information about what the
style should be, so the tool keeps what it was told. A document is the PRESENCE
of it: it says what the selection was made under, and one that reopened beneath
somebody else's palette would not be showing what was saved. See
[saving the work](saving.md), which has the tie-breaker as well as the rule.

For most of this project's life a session held one file and opening a second
meant reloading the page. The load path had been re-entrant the whole time.
What was missing was any way out of the one that was open.

Closing over work asks first, in place, and forgets it was asking after four
seconds so it cannot sit there armed. Closing over nothing does not ask at all,
because a confirmation nobody needs is the fastest way to teach people to click
through confirmations.

## Saving, and opening again

The product has no dialogs anywhere and this is not where one arrives. Save is a
text button beside undo and redo rather than beside Export, because it belongs
to the work rather than to the result: undo, redo and save are the three things
somebody does to a selection, and export is what they do with one. `Cmd-S`
does the same, which is the binding every other application on the machine has
for it and the one surprise a save can least afford.

**With nothing selected it is disabled and its title says why**, which is the
rule the close button already follows from the other direction: a confirmation
nobody needs is the fastest way to teach people to click through
confirmations, and a control that does nothing is the fastest way to teach them
it is broken.

**Opening is a drop, in either order, because a browser has no paths.** A
document names media it cannot open, so both halves have to be supplied.
Somebody still working drops the document onto the editor and the selection
comes back. Somebody who reloaded the tab drops the document first, and the drop
zone holds it and asks for the file it names, by name. Two drops rather than a
dialog, and the drop zone is already the control: what changes is the sentence
in it.

A document dropped onto the editor is taken and a photograph is not. A document
is additive to the media that is open; a second photograph would replace the
file under somebody's hands and take the log with it, on a drop they may have
meant for another window.

**And the drop zone has a third thing to say, which is the one nobody asked
for.** Work from a session that ended without being given back is offered on the
next load, in the same place and in the same shape as a dropped document: the
zone names the file it needs and says why it wants it. It is the same sentence
structure on purpose, because it is the same request. What is different is one
line, and the difference is worth having: a document is a file somebody just
chose, and this is news. **Nor is one taken over unsaved edits**, which is the
same rule reaching the one gesture capable of breaking it: loading a selection
over another one is a replace, so the line says what it would cost and names the
two ways out, Save and the X. That is the close button's rule arriving at a
gesture with no button to arm.

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

## Saying that something happened

The status line says what is HAPPENING. Nothing said what had happened, because
until clips could be written into a file the browser always did: a download
announces itself, and there was nothing else an export could produce.

There is now. A clip written into a file the user chose announces nothing at
all, and a clip that came out shorter than the clip announces nothing either,
and both of those look exactly like an export that worked. So there is a second
line, in the place a failure would appear and in the secondary colour rather
than the warning one. An export that stopped where it was told to stop is the
product doing as it was asked, and colouring that like a fault is the fastest
way to teach people to distrust the colour.

It says three things and stays quiet about the fourth. That a file was written,
and its name. That an export stopped early, and how far it got. That it ran out
of room, which is a different sentence because it is a limit of the browser
rather than a button anybody pressed. And nothing at all about a whole clip that
went to the downloads folder, which the browser has already said.

**It also goes away by itself, which a failure does not.** A failure is a state
and stays until something changes it. This is an event: it says what JUST
happened, so left up through a scrub and two brush strokes it would be
describing something else by then. Ten seconds, which is long enough to read a
sentence about a clip that stopped early.

**Some things are states rather than events, and they go somewhere else.** A
soundtrack an MP4 cannot carry is true for as long as the file is open, so it
sits in the row beside the file's name and its dimensions, in the darkest of the
greys there rather than in the one saturated colour this product spends on
failures. Nothing has failed. Something is going to be lost, the user is going
to want to know before the minutes of encoding rather than after, and a line
that took itself down after ten seconds would be a line they were not looking at
when it mattered. It is said again when the file lands, because the warning went
up minutes earlier and a file that turns out to be silent when it is played is
the one thing this was built to stop being a surprise.

A restored selection that was saved against a different copy of this file is the
second, and it is in the same row for the same reason. The shape matched, so
every command replays and every frame number means what it meant; the bytes did
not, so this may be a re-encode rather than the clip the selection was drawn on.
That is worth knowing for as long as somebody is looking at it and is not a
failure, so it is a note beside the name rather than a line in the warning
colour. There can be two of them at once and the second must not replace the
first, which is why that row takes a list.

**And a button's second sentence lives in its title**, which is the rule the
Stop button already follows. The Clip button's is what pressing it will do:
which part of the clip, and whether the sound goes with it. That is where the
range says what it is, because the timeline shows where it is and the button
shows what it means.

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

Icons are sixteen Lucide paths inlined into `src/app/icons.tsx` (ISC). A kilobyte
of geometry did not justify a dependency.
