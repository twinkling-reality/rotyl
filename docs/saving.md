[Rotyl](../README.md) / Saving the work

# Saving the work

`docs/architecture.md` has said from the beginning that strokes rather than
pixels are the source of truth, and that replaying the log rebuilds the mask.
Undo is a cursor into it. Export replays it rather than asking the app which
commands apply. A lost graphics device is survivable because the log belongs to
the work and does not die with the device.

And nothing saved it. Reload the page and three quarters of an hour of tracking,
every correction and every choice of which of three objects you meant was gone.
The one structure everything else is built on was the one thing never allowed to
outlive a tab.

Press Save, or Cmd-S, and the log becomes a `.rotyl` file. Drop that file back
in and the selection comes back, on any frame it was made on, with the playhead
where it was.

**And the log is written down as it is made, so a tab that dies costs nothing.**
A button cannot protect the work between presses, and on a tracked run that is
three quarters of a minute of following an object per press somebody did not
make. See [coming back from a session that ended](#coming-back-from-a-session-that-ended).

## What a document is, and what it is not

**It is the log and nothing derived from it.** No cached mask, no thumbnail, no
rendered anything, and that is a measurement rather than a preference. Loading
one is a fold and one texture upload: the fold cuts at the last command that
decides a frame by itself, so eighteen thousand commands of a ten-minute tracked
run fold to one, and that one plus unpacking its mask is 0.3 ms. A cache would
be a second source of truth in the one structure this architecture exists to
have exactly one of, in exchange for a third of a millisecond.

**It does not contain the media.** That is the decision somebody will ask about
first, so: a photograph is a few megabytes and embedding it makes a document
that always opens, and a clip is two gigabytes and embedding it means holding
two gigabytes to write one file, which is the exact ceiling
[the long clip measurement](video.md#writing-the-clip-out) exists to have
removed. One feature that is four megabytes on one kind of file and two
gigabytes on another is two features. One path for both has been this project's
answer to every other question of that shape, and the answer that works for both
is a reference and a way of recognising the file it names.

**The style is in it.** [The interface](interface.md) says the style survives
closing a file, because that is a choice about how the tool is set up rather
than about this photograph, and re-picking a palette on every file would be the
tool forgetting what it was told. A saved document refines that rather than
contradicting it: closing is the absence of information and opening a document
is the presence of it, and a document that reopened under somebody else's
palette would not be showing what was saved. The tie-breaker is export, which
replays the log at the style the app is set to, so a document carrying the log
and not the style would be saving half of what the picture depends on.

**The playhead and the export range are in it, and the view is not.** Both of
the first two are statements about this clip that somebody made on purpose, and
reopening ten minutes of tracking at frame 0 loses the one thing that costs a
scrub to find again. Zoom and pan are fitted against a canvas whose size belongs
to the window rather than to the work, so a document reopened in a smaller
window would restore a pan into empty space. The project already treats them
that way: `use-rotyl.ts` carries the view across a lost graphics device
separately from the document, because the log is the work and the view is where
somebody was standing.

**The redo tail is not in it.** A document holds work that was done; a redo tail
is work that was undone. It is also self-defeating, since the next stroke
discards the tail anyway, so a saved one would vanish the moment anybody drew.

## Which file it belongs to

A browser has no paths. A document names media it cannot open, so the file has
to be supplied again, and the only question left is whether it is the same file:
a selection replayed over the wrong clip is a wrong answer that looks like a
right one.

**The whole file cannot be digested here, and that is the platform rather than a
budget.** `crypto.subtle.digest` takes a buffer and there is no streaming form
of it anywhere, so hashing two gigabytes means holding two gigabytes at once.
Where it fits it runs at about two gigabytes a second, so on a real clip it is a
second of work on top of the whole file in the heap.

**So two things are compared, and they fail differently.** The shape, which is
the dimensions and the frame count, is free because the loader already read it.
The bytes are a digest of the first megabyte, the last megabyte and the length,
which costs under two milliseconds whatever the file is.

- **A different shape is refused.** Frame 1043 may not exist and a stroke at
  (3000, 2000) may be off the image, so there is nothing to replay and no
  judgement to make. The sentence names the file it wanted and its shape,
  because "wrong file" without that leaves somebody guessing between two clips
  on a desk.
- **The same shape and different bytes opens, and says so.** Every command
  replays and every frame number means what it meant. It may be a re-encode of
  the same clip, which is an ordinary thing to have done. So the note goes
  beside the file's name where the soundtrack warning goes, because it is a fact
  about the open file rather than something that just happened.

What a bounded probe cannot see is a file that agrees at both ends and in length
and differs in the middle, which on media is a re-encode with the same container
layout and the same byte count. That is in [known limits](limits.md) rather than
left implied. The name is recorded and is not compared: a renamed file is the
same file, and the name is what the drop zone asks for when it has a document
and no media to go with it.

## The file

A JSON header and the packed masks behind it, which is the shape every honest
container has. Everything small enough to read in a text editor stays legible
and extensible, and the one thing that is neither goes in a region the header
points into. It needs no library, which a document format in a 50.7 KB
application has to be able to say.

```
0   magic          6 bytes, "ROTYL" and a zero
6   version        u16, little endian
8   header length  u32, little endian
12  header         UTF-8 JSON, that many bytes
..  payloads       packed masks, concatenated, in the order the header names
```

The obvious alternative was JSON with the masks base64 encoded, which needs no
format at all. It is a third larger, which is arithmetic, and it is also ninety
seven times slower to write and thirteen times slower to read, which is not: on
ten minutes of tracking it is 1090 ms against 11 to write and 160 against 12 to
read, because every mask has to be built into a string on the way out and taken
apart on the way back. A second of work to press Save is a different product.

**A document from a newer build is refused by version, before anything is
parsed.** This is the first format the project WRITES, and therefore the first
one it will have to read from an older version of itself, so the rule exists
before there is a second version rather than after: after that it is
archaeology. It is the same rule HEIC and Matroska already follow on the way in,
and it says what it is rather than failing somewhere further down.

**And a damaged one is refused rather than believed.** Every field in the header
comes off a disk and is checked rather than asserted, because the failure an
unchecked header produces is a stroke at NaN or a mask sliced past the end of
the payload, which replays as a picture rather than as an error. A write that
stopped part way needs no special care for the same reason: the header states
its own length and the payload offsets are absolute, so a truncated file fails
to read rather than replaying the part that arrived.

## Where it goes, and how you ask for it

**One destination path, not two.** A saved selection is one row in the same
table a clip and a picture are in: the picker, the fallback to the downloads
folder and the handoff to the browser are the same three things whatever the
bytes are. What it does not inherit is the ordering argument. A clip asks where
it goes first because minutes of encoding would otherwise be thrown away; a
document is eleven milliseconds of work, so the picker is simply where the click
goes.

**There is no dialog, because this product has none.** Save is a text button
beside undo and redo, because it belongs to the work rather than to the result:
undo, redo and save are the three things somebody does to a selection, and
export is what they do with one. With nothing selected it is disabled and its
title says so, which is the rule the close button already follows by not asking
a confirmation nobody needs.

**Opening is a drop, in either order.** Somebody still working drops the
document onto the editor and the selection comes back. Somebody who reloaded the
tab drops the document first, and it waits, naming the file it wants, until the
other half arrives. Two drops rather than a dialog, and the drop zone is already
the control: what changes is what it is asking for.

A document dropped onto the editor is taken and a photograph is not, which is
deliberate. A document is additive to the open media; a second photograph would
replace the file under somebody's hands and take the log with it, on a drop they
may have meant for another window entirely.

**And a document dropped over unsaved edits is not taken either.** No drop has
ever been able to destroy the open session here, which is exactly why a
photograph dropped onto the editor is swallowed rather than opened, and a
chapter about not losing work is the wrong place to introduce a way of losing
it. Loading a selection over another one is a replace and cannot be anything
else: the fold is sorted by frame, so the commands underneath cannot be left in
place behind a clear and undone back to. The line says what it would cost and
what to do about it, both of which are one click. Nothing failed and the file
they dropped is still on their disk, so it is the quiet line rather than the
colour this product spends on faults.

## What it cost

**3.0 KB gzipped**, taking the application bundle from 45.8 KB to 48.9, before
crash recovery added 1.8 KB more on top of it. About
half of that is the format and the digest and the other half is the interface
around them, and it is not behind a dynamic import, which is the opposite of
what the demuxer, the container writer and the inference runtime get.

That was measured rather than assumed. Split off, the format and the digest are
2.46 KB gzipped across three chunks and take 1.58 KB off the application: a
kilobyte and a half back for a session that never saves, and 0.9 KB more in
total plus three round trips for one that does. The container writer is split because it is
42.8 KB. This is not, and putting a network fetch in front of Save to recover a
kilobyte and a half would be a failure mode invented for the one operation in
the product that exists to keep somebody's afternoon.

Everything above is on `/research/the-document.html`, out of the harness that
took it.

## Coming back from a session that ended

Every edit is appended to a journal in the origin private file system as it
lands. Reload, crash, or close the tab, and the next load offers it back: the
drop zone names the file it needs, and supplying that file replays the work.

**A recovery is a document nobody had to save.** What comes back out of the
journal is the same `RotylDocument` a dropped `.rotyl` produces, so it takes the
same path from there. The same media check, the same replay, the same refusal if
the file supplied is the wrong one, the same sentence beside the name if it is a
re-encode. Nothing past that point knows where it came from except the one word
the drop zone says.

**It is not a save and it does not pretend to be.** Nothing appears while it
writes: no indicator, no line, no tick. There is nothing to say about 0.13 ms in
another thread, and a product that showed something would be claiming to have
put the work somewhere the user can find, which it has not. Save is still how
work leaves this browser.

### It is a different shape of the same log, and the measurement is why

A document is one JSON header with the masks in a region behind it. Written
once that is the right shape and eleven milliseconds for ten minutes of
tracking. Written on every edit it is quadratic, because the header is at the
front and grows: 2559 ms per edit at that size. So a journal is append-only
records instead, each carrying its own lengths, with nothing pointing backwards.

That also decides what a half-written journal is worth. A reader walks forward
and stops where the bytes stop, so a tab killed mid-append loses the record it
was writing and keeps every one in front of it. Refusing the file because the
last write did not finish would be throwing away the session in order to protect
it.

**An undo cuts the journal back rather than annotating it.** The journal is
defined as the applied commands, so it is either extended or cut to where the
two agree. A journal that only grew would offer back work its own session had
already taken away, which is worse than losing it: the user undid something and
it came back.

### It needed this project's first Web Worker

[How it is put together](architecture.md) rejected a worker for export at 50%
slower, and that rejection stands. This is the opposite trade and it was
measured before a line of it was written.

`createSyncAccessHandle` is not on the main thread at all, asked of the browser
rather than remembered. And the API a page can reach, `createWritable`, copies
the file to open a stream on it: 0.4 ms on an empty file and 117 on a 64 MB one,
so an append is not an append and one record onto a ten-minute journal costs 98
milliseconds, per edit, on the thread that draws. In a worker it is flat at
0.13 ms at every size, flushing after every record costs nothing measurable, and
handing the record over is below the clock's own resolution.

That is 1.8 KB gzipped on the application bundle and one more chunk of a
kilobyte, which only a session that opens a file ever fetches.

### What it will not do

The media still has to be supplied again, because a browser has no paths. One
journal is kept rather than one per file, so starting to edit a different file
supersedes it: the drop zone names the file it is waiting for, so choosing
something else is informed rather than accidental. And only one tab journals at
a time, because a sync access handle is exclusive; a second tab on the same
browser has crash recovery for whichever of them opened a file first. All three
are in [known limits](limits.md).

The numbers are on `/research/crash-recovery.html`.
