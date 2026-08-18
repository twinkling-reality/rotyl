[Rotyl](../README.md) / Selecting an object

# Selecting an object

Click one with the Object tool and the whole thing is selected. Shift-click adds
another region to the same object; Alt-click carves one away. Dragging pans, so
there is no modifier to learn for the common case.

Or draw around it with the Box tool. A box says something a click cannot, where
the thing _ends_, which makes it the better prompt for anything without an
unambiguous middle. It composes with clicks rather than replacing them: draw a
box, switch back to the Object tool, and Alt-click whatever it caught by
mistake. Drag is the box, so Shift-drag pans there, as it does in the brushes.

**A box is a question, not a selection.** It asks what object lies inside the
region and answers with the object, so dragging one around a building gives the
building and not the rectangle. That is the point of it, and it is also the
first thing anyone gets wrong, because the gesture is the one every other editor
uses for a marquee. The Area tool is the marquee: the same drag, taking the
region exactly, with an edge where it was put and no model involved. Alt-drag
cuts one back out. The two sit on opposite sides of the toolbar's divider.
everything left of it asks a model what is there, everything right of it draws
what you draw.

A segmentation model (EdgeTAM) runs on your machine, in the browser. The first
use downloads it, about 16 MB compressed for the runtime and 20 MB for the
weights, and caches both; after that it is offline. Your image is never sent
anywhere. The only thing that crosses the network is the model coming to you.

Three things about the shape of this are load-bearing.

**What the system understands is not what it draws.** Reading the frame is
expensive and happens once; answering "which object is under this point" is
cheap and happens per click. Each prompt returns three candidates, usually the
same click read as a part, a whole and a group, and `PerceptionStore` keeps all
of them while the renderer is told about exactly one, through an ordinary
undoable command. Nothing in the perception layer can touch a mask texture.

**The click was ambiguous, so the answer is a choice.** A point on a sleeve is a
cuff, a shirt and a person, and the model says so. The alternatives appear under
the prompt as their own silhouettes, the arrow keys reach them too, and taking
one _replaces_ the command rather than stacking another, so changing your mind
about which object you meant costs one undo rather than two.

They are offered smallest first, which is the axis a person chooses along;
confidence decides only which is drawn first, because nobody can see it. Two
readings that agree to within a tenth are one reading, and are shown as one:
three buttons that do the same thing imply a choice that is not there. And the
thumbnails share a single crop rather than each framing itself, since three
silhouettes at three magnifications would destroy the one comparison being
offered.

**A 256 px mask is not a boundary.** The model answers at 256 px square whatever
the photograph is, so on a 4000 px image its edge is wrong by a dozen pixels
before anything else happens, and magnifying it cannot help: a nearest tap
staircases and a bilinear tap gives a sixteen-pixel ramp following the mask's
own grid. So the boundary is _reconstructed_ from the image with a guided filter
(He, Sun and Tang) whose guide is the photograph in Oklab, three channels, not
luminance, because two regions of equal lightness and different hue are exactly
the case a scalar guide cannot see. Measured on a synthetic edge, in image
pixels:

| engine error | 1 texel | 2    | 3    | 4    | 6    |
| ------------ | ------- | ---- | ---- | ---- | ---- |
| magnified    | 3.5     | 7.5  | 11.5 | 15.5 | 23.5 |
| refined      | −0.5    | −0.4 | 4.6  | 11.0 | 21.8 |

The window spans about six engine texels, which is what sets where that gives
out. The filter runs during replay rather than once, so the command log holds
the model's own 256 px answer, 64 KB, and export reconstructs the
boundary against the full-resolution image rather than magnifying a preview's.
