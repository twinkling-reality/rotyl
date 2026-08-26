[Rotyl](../README.md) / Stylisation decisions

# Stylisation decisions

Evidence ledger for the selective person-to-animation treatment. Local paths
were tried first. This page records why they failed and which hosted path was
then authorised.

Nothing here is publish-ready. The licensed set was run on PhotoMaker and
then on FLUX Kontext. The pictures failed the bar. No demo reel.

## Visual bar

The selected person has to read as a desirable illustrated character at normal
viewing size and at a paused full-resolution still. Identity, expression, eyes,
hair, hands, clothing and silhouette stay coherent. The photograph around the
selection stays the photograph. Melted faces, sticker eyes, posterised
photographs, and a generated picture faked inside the interface all fail.

The same licensed stills used for the local work remain the set. Provenance is
in `tools/style-bench/evaluation-set.json`. Nothing fetched is committed.

## Local paths, closed

A hue-keeping Anime cel pass was added on the Comic flatten and ink, on
`cursor/anime-cel-eval-7d99`. Official DCT-Net graphs, including FaceAna
alignment, were run offline on the same stills. Both failed.

The shader reads as a posterise-and-ink filter of the photograph. Eyes stay
muddy photographic patches. Hair collapses to a mass. Retuning the last-pass
knobs cannot invent facial drawing the flatten discarded.

Official DCT-Net pastes a 288 cartoon head through `alpha.jpg`. On this set
that is sticker eyes and a missing nose, or a melted face, or a void. The
background graph stylises the whole frame. Those graphs were not converted and
are not shipped.

InstantID, IP-Adapter-FaceID and PuLID were not opened as local browser models.
They are the wrong size for this product, and the FaceID variants depend on
InsightFace weights that are not licensed for commercial redistribution.

This work does not reopen the Anime shader or DCT-Net.

## Hosted path

Authorised as an explicitly separate option. Stills first. Not a fifth local
slider. The user has to opt in. Privacy, cost, latency and retention are stated
before a still leaves the machine.

**Pick.** PhotoMaker, Tencent ARC, Apache-2.0, hosted on Fal as
`fal-ai/photomaker` with the `photomaker-style` pipeline and img2img from the
still being sent.

**Why this one.** PhotoMaker is in the identity-preserving class that was
asked for. Its official stacked-ID embedding is CLIP, not InsightFace, so the
weight licence matches the code licence. The still is both the identity archive
and the img2img start, which keeps pose and clothes as a reading of this frame
rather than a new scene. Fal is a hosted API the existing Cloudflare worker can
call without putting a key in the browser. The result comes back as a layer.
The compositor that already holds Comic, Poster and Print writes unselected
pixels from the original still.

**Why not InstantID or PuLID.** Both are strong identity methods. Both, in
their official stacks, pull InsightFace face models that are licensed for
non-commercial research. This ledger already refused unofficial relicence and
will not do it for a hosted job either.

**Why not IP-Adapter-FaceID.** Official FaceID weights say the same InsightFace
restriction. The CLIP IP-Adapter Plus weights are Apache-2.0, but there is no
equally clean hosted img2img endpoint that uses those weights without the
FaceID encoder. PhotoMaker is the implementable hosted form of that idea.

**Why not a local SDXL runtime.** A multi-hundred-megabyte download would
abandon the size of this browser product. That is the other half of the
authorization boundary, and it was not taken.

## What ships, and what does not

The option is a toolbar control named Illustrated, only on a photograph. It is
not in the Style list and it is not Comic, Poster, Print or Anime. Opening it
prints the terms. Send is disabled until there is a selection and the host has
configured a Fal key. The worker refuses a job whose consent is missing or
stale. Closing the file drops the layer. Clips are not sent.

The generated layer is at most 1280 pixels on the long edge. Unselected pixels
are still the original still at the original resolution.

The job is not configured in an ordinary clone. `FAL_KEY` is a host secret.
Without it the panel still opens, so the terms can be read, and nothing leaves.

**Not publish-ready.** The licensed set was run on this path. The pictures
failed the bar. A request that returns a picture is not a desirable character.
Do not put this on a demo reel. Do not describe the control as a character
generator.

## Hosted run, judged

A configured host ran `fal-ai/photomaker` with `photomaker-style`, img2img from
the still, 100 steps, style strength 40, and strengths 0.48 and 0.40. Identity
archives were uploaded to Fal storage because a data-URI zip is refused. Sheets
are local under `tools/style-bench/out/illustrated/` and are not committed.

**portrait-close.** Hands and camera stay, and so does the landscape. The
result is still a photograph. Red hair is invented. Not an illustrated
character.

**portrait-glasses.** The glasses disappear. Hair and window light stay
cinematic. Identity is a neighbour of the sitter, not the sitter.

**portrait-somali.** A young woman in a floral headscarf becomes a man with
stubble and loose hair. Clothes and expression do not survive.

**portrait-lehna.** Magenta knit, gold headpiece, nose ring and earrings do
not hold. One strength grows a beard. The backdrop is restyled, not left as
the photograph.

**portrait-doorway.** An older man in a mustard turban becomes a young blonde
in an anime doorway. Pose is kept. The person is not.

**portrait-hands.** Closest sheet. The thinking hand and grey shirt remain.
The leopard headband is gone. That is still not the same person, dressed.

None of the six read as a desirable illustrated character who is still that
person, with the photograph around them still the photograph. PhotoMaker
invents a new face more readily than it draws this one.

## Hosted run, identity follow-up, judged

Same authorized path. One more licensed sweep after leftover Fal spend was
named: 100 steps, strength 0.30, style strength 20, one candidate. Product
defaults stay 0.48 and 40. Sheets are local under
`tools/style-bench/out/illustrated/s030/` and are not committed.

**portrait-close.** Hands, camera, and landscape stay. The result is still a
photograph. A red band is invented on the cap.

**portrait-glasses.** The glasses stay this time. The sheet is still a
cinematic painting of a neighbour, not a drawn character who is this person.

**portrait-somali.** The sitter stays a young woman. The floral border leaves
the headscarf. The smile does not.

**portrait-lehna.** No beard. Magenta knit, gold headpiece, nose ring, and
earrings still do not hold. Hair is restyled.

**portrait-doorway.** An older man in a mustard turban becomes a young blonde
again. Pose and kurta stay. The person does not.

**portrait-hands.** Closest sheet again. The thinking hand and grey shirt
remain. The leopard headband is gone.

Pulling toward the still fixes some of the costume failures. It does not
stop PhotoMaker inventing a new face. None of the six clear the bar.

## Hosted run, FLUX Kontext, judged

PhotoMaker invents a new face, so leftover Fal spend went to an edit of
this still: `fal-ai/flux-pro/kontext` and `fal-ai/flux-pro/kontext/max`.
No InsightFace. Product POST is still PhotoMaker. Sheets are local under
`tools/style-bench/out/illustrated/kontext-pro/` and `kontext-max/` and
are not committed.

**portrait-close.** Now drawn, not a photograph. Hands, camera, and
landscape stay. A red strap is invented on a backward cap.

**portrait-glasses.** The glasses stay. The dark sweater becomes an olive
tee. The eye colour is invented.

**portrait-somali.** Stays a young woman. Max keeps the cream shawl and
the floral border. Pro moves the pattern onto the wrap.

**portrait-lehna.** Magenta knit stays. Max drops the gold headpiece.
Earrings drift.

**portrait-doorway.** An older man in a mustard turban stays an older man
in a mustard turban. Pose and kurta stay. This is the PhotoMaker failure
that Kontext actually holds.

**portrait-hands.** The thinking hand and the leopard headband stay. Shirt
colour drifts on max.

Kontext draws this still instead of stacking a new identity. Doorway and
hands are the first hosted sheets that still read as these people,
dressed, and as drawings. The set as a whole does not clear the bar.
`publishReady` stays false.

## Hosted run, FLUX.2 Pro edit, judged

Same leftover Fal spend. `fal-ai/flux-2-pro/edit` on the same six stills.
Sheets are local under `tools/style-bench/out/illustrated/flux2-edit/` and
are not committed.

**portrait-close.** Drawn. Hands and camera stay. A red snapback strap is
still invented.

**portrait-glasses.** Glasses stay. The sweater becomes a teal jacket and
the room is a new scene.

**portrait-somali.** Stays a young woman with the floral border.

**portrait-lehna.** Gold headpiece and nose ring stay. A gold pendant is
invented.

**portrait-doorway.** Mustard turban and white mustache stay. The dark
interior becomes a pale room.

**portrait-hands.** Thinking hand, grey shirt, and leopard headband stay.

FLUX.2 is not a step past Kontext on the set. Lehna holds more. Glasses
holds less. The set does not clear the bar.

## Hosted run, keep-list spend, judged

Leftover Fal spend named the costume failures and ran them again:
Kontext max, then `fal-ai/nano-banana-2/edit` at 1K. Sheets are local
under `tools/style-bench/out/illustrated/kontext-keep/` and `nano-edit/`
and are not committed.

**portrait-close.** Still drawn. Both still invent a backward cap.
Kontext keep still paints a red strap.

**portrait-glasses.** A dark knit sweater stays this time. Glasses stay.

**portrait-somali.** Cream shawl with the floral border on the edge.

**portrait-lehna.** Gold headpiece stays. Nano keeps the nose ring.

**portrait-doorway.** Mustard turban and the older man stay.

**portrait-hands.** Leopard headband and the thinking hand stay.

Naming the clothes helped. The set still does not clear the bar.
`publishReady` stays false.

## Hosted run, close-cap seeds, judged

Four more Kontext max jobs on portrait-close, seeds 11, 23, 41, and 67,
told not to add a red strap or flip the cap. Every sheet still invents
a backward cap and a red strap. Seed 67 puts the strap on the forehead.
Prompting and reseeding do not stop that invention. Sheets are local
under `tools/style-bench/out/illustrated/close-seeds/` and are not
committed. This work does not reopen Anime, DCT-Net, InstantID, PuLID,
or IP-Adapter-FaceID.

## Hosted run, Seedream and GPT Image, judged

Leftover Fal spend left Kontext close alone and ran the keep-list on two
other edit families: `fal-ai/bytedance/seedream/v4.5/edit` at the $0.04
list price, then `fal-ai/gpt-image-1.5/edit` at high quality and high
input fidelity. Sheets are local under
`tools/style-bench/out/illustrated/seedream-edit/` and `gpt-edit/` and
are not committed.

**portrait-close.** Both are drawings of these hands, this camera, and
this landscape. The photograph already shows a red adjustment strap on
the black cap. Seedream keeps that strap and still draws the cap
backward. GPT replaces the strap with brown leather and rewrites the
camera lettering.

**portrait-glasses.** Both keep the glasses and a dark knit. Seedream
warms the hair toward auburn. GPT invents stickers on the glass.

**portrait-somali.** Cream shawl with the floral border stays on both.

**portrait-lehna.** Seedream keeps the magenta cardigan, gold headpiece,
nose ring, and earrings. GPT turns the cardigan red.

**portrait-doorway.** Mustard turban, white mustache, kurta, and red
doors stay on both.

**portrait-hands.** Thinking hand, grey shirt, and leopard headband stay
on both.

Seedream holds clothes better than Kontext close-seeds or GPT Image.
The set still does not clear the bar. `publishReady` stays false.
Product POST is still PhotoMaker. No demo reel.

## Correction, the close cap

The source photograph for `portrait-close` was read again, at full size and at
a crop of the head. It shows a black snapback worn backward: the flat brim
points behind the head, and the red band across the forehead is the adjuster
strap, visible because the cap is backward.

Earlier entries on this page recorded a backward cap and a red strap as
inventions, on Kontext, on the keep-list sweep, on the four close-cap seeds,
and on Seedream. That reading was wrong. Those sheets were drawing the
photograph. The Seedream entry had already noticed the strap is in the still
and still counted the backward cap as a miss.

The keep-list prompt carried the same error. It asked for a cap facing the
other way and for no red strap, which asked the model to depart from the
still. That is against the visual bar, which keeps costume and silhouette
coherent with the photograph. The prompt now describes the cap as photographed.

The four close-cap Kontext seeds were spent against a miss that was not there.
No claim about `portrait-close` on any family stands until it is judged again
on the corrected prompt. `publishReady` stays false and product POST stays
PhotoMaker.

## Hosted run, six more edit families, judged

Leftover Fal spend went past Seedream 4.5 to six edit families, run on the
corrected keep list: Seedream 5 Pro, Seedream 5 Lite, Nano Banana Pro, Qwen
image edit 2511, Grok Imagine edit, and FLUX.2 Flex edit. Thirty six sheets,
six licensed stills each. Sheets are local under
`tools/style-bench/out/illustrated/` in `seedream5-pro/`, `seedream5-lite/`,
`nano-pro/`, `qwen-edit/`, `grok-edit/` and `flux2-flex/`, and are not
committed.

**The close cap, settled.** All six families draw the black snapback worn
backward with the red adjuster strap across the forehead, because that is what
the photograph shows. Six of six. Nothing was invented on this still by any
family, on this sweep or on the earlier ones. The correction above stands.

**Skin tone on dark-skinned sitters.** A forehead patch was sampled on the
three dark-skinned sitters and averaged, in luma out of 255, against the same
patch in the photograph. The sample box was rendered onto both images first to
confirm it lands on skin.

| family          | somali | lehna | hands | mean absolute |
| --------------- | ------ | ----- | ----- | ------------- |
| Grok Imagine    | +23.8  | +4.0  | +13.8 | 13.9          |
| Nano Banana Pro | +26.6  | -16.6 | +4.1  | 15.8          |
| Seedream 5 Pro  | +44.6  | -19.1 | +22.1 | 28.6          |
| FLUX.2 Flex     | +41.1  | -29.2 | +48.1 | 39.5          |
| Qwen 2511       | +69.6  | -18.5 | +32.0 | 40.0          |
| Seedream 5 Lite | +72.5  | +17.0 | +53.1 | 47.5          |

The somali photograph is an aged, underexposed print, so part of a positive
number is shadow resolving into flat fill rather than a change of complexion.
That does not account for the size of the drift on Seedream 5 Lite, Qwen, or
FLUX.2 Flex. On `portrait-somali` and `portrait-hands` those three draw a
visibly lighter complexion than the sitter, and Lite also draws a younger face.
The `DRAW` prompt pins "the same face, age, skin", so this is an identity miss,
not a style choice. Grok and Nano Banana Pro hold skin closest.

The number ranks fidelity, not the bar. A family that barely stylises scores
well on it by doing nothing. Grok is the case in point: its somali sheet keeps
the photograph's mottled shading, the individual hair strands, and the small
blue mark on the shawl, and reads as a traced and posterised photograph rather
than a drawn character. The bar fails posterised photographs. So the drift
column is a check to run against a family that already draws, not a ranking of
which family to adopt.

**Seedream 5 Pro.** The best drawing of the six. Lehna keeps the magenta
cardigan, the gold headpiece, the turtleneck, the silver earring, and the
backdrop pattern row for row. Doorway keeps the turban, the white mustache, the
kurta pocket, the red doors, the door latch, and the wall stencils. Hands keeps
the leopard headband, the top knot, the grey crew neck, and draws a coherent
five-fingered hand at the chin. Close keeps the camera lettering. Glasses keeps
the tortoiseshell frames and the knit, and invents a lit face and a visible eye
where the photograph is nearly a silhouette. Somali lightens the skin.

**Seedream 5 Lite.** Holds the same costume list at a lower price and a cruder
line. It has the worst skin drift of the six and draws a younger face on
somali.

**Nano Banana Pro.** Flat vector line with heavy outlines. Costume holds on all
six and skin holds best after Grok. Faces are more generic than Seedream 5 Pro
and the smile is lost on lehna.

**Qwen image edit 2511.** Costume holds, but it rewrites the camera lettering
on close, from `iya 645` to `Iya 5A6`. The keep list names that lettering. Skin
drift is large.

**Grok Imagine edit.** Holds skin best of the six and holds costume on all six,
but it holds them by tracing. Somali is a posterised photograph with the
original shading blotches intact. That is the failure this ledger named for the
Anime shader, reached from the other direction. The brow is furrowed on hands
where the photograph is serene. Close reads `iya 643` for `iya 645`.

**FLUX.2 Flex edit.** Costume holds and the cap and lettering are right. Skin
drift is large on somali and hands.

No family is adopted. `publishReady` stays false, product POST stays
PhotoMaker, and terms stay `illustrated-v2`. Whether any of these sheets clear
the bar is the user's call, not this page's. The skin drift above should be
settled before any family is adopted, because it falls on the sitters the
product would be drawing.

## Probe, is the skin drift promptable

The sweep above measured every family lightening the dark-skinned sitters. That
matters more than which family draws best, so the remaining spend asked one
question: is the drift a prompt problem or a model problem. The same stills were
run again with `SKIN_CLAUSE` appended, so the sheets differ from the sweep only
by that clause. Sheets are local under
`tools/style-bench/out/illustrated/skin-pinned/` and are not committed.

**Seedream 5 Pro does not respond.** Somali moved from +44.6 to +41.2 and hands
from +22.1 to +20.8. Naming the complexion does not move it. On this family the
drift is in the weights, not the prompt.

**Nano Banana Pro responds, and overshoots.** Forehead patch, luma out of 255,
against the same patch in the photograph.

| still            | photo | sweep | pinned |
| ---------------- | ----- | ----- | ------ |
| portrait-somali  | 47.0  | +26.6 | +9.2   |
| portrait-glasses | 53.9  | +78.5 | -1.7   |
| portrait-hands   | 66.6  | +4.1  | -20.9  |
| portrait-lehna   | 101.6 | -16.6 | -45.1  |

Mean absolute drift falls from 31.5 to 19.2, but the clause is blunt. It
corrects the two stills that were far out and pushes the two that were already
close too far the other way. The pinned lehna is visibly darker than the sitter
and has lost the facial modelling and the smile. That is a different identity
miss, not a fix.

**What this decides.** Seedream 5 Pro is the better drawing and cannot be
corrected at the prompt layer. Nano Banana Pro is a slightly plainer drawing
whose complexion is controllable. Grok holds skin best of all and holds it by
tracing, which the bar fails. For a control whose whole job is drawing a real
person, correctable beats prettier, so Nano Banana Pro is the path this evidence
points at.

It is not adopted yet. The clause is proven as a direction and is not calibrated.
It needs to be a strength that scales with how far the family actually drifts on
that still, not one sentence applied the same way to every sitter. Until that is
dialled in and the full six are judged on it, `publishReady` stays false, product
POST stays PhotoMaker, and terms stay `illustrated-v2`.

## The keep list the still writes for itself

The bench keep lists were written by a person looking at six known photographs.
A real upload never gets that, and the product has only ever sent one generic
sentence with no costume detail in it. So every judgement above was measuring
these families under a condition the product cannot reproduce. That gap is now
closed.

A vision pass reads the still and writes its own keep list, and that answer
becomes the keep clause. Nothing is hardcoded to one picture.
`describeIllustratedKeep` calls `fal-ai/any-llm/vision` on the uploaded still
with `KEEP_INSTRUCTION`, at temperature 0 so the same upload does not get a
different list each run. It asks only for what is visibly in the frame and
refuses to guess a name, a place, an occupation, or a mood, because guessing
would put invention into the clause that exists to stop invention.

**What it writes.** On lehna, unaided: a medium-dark brown skin tone, short
curly black hair, a silver nose ring on the left nostril, a black and gold
patterned headwrap, a black high-necked top, and a bright pink ribbed open
cardigan. On close: a black baseball cap facing backward with red on the brim,
chin stubble, and the camera lettering `Mamiya 645`, `No.18923`, `f=80mm`,
`1:2.8`, `MAMIYA-SEKOR C`. It found the backward cap on its own, which is the
detail three earlier sweeps scored as an invention. It is more specific than the
hand-written list it replaces, and it names complexion, which the hand-written
lists never did.

**Three keep lists, one family, one set of stills.** Nano Banana Pro, generic
against derived against hand written. Forehead patch drift, luma out of 255.

| still           | photo | generic | derived | hand  |
| --------------- | ----- | ------- | ------- | ----- |
| portrait-somali | 47.0  | +29.6   | +20.8   | +26.6 |
| portrait-hands  | 66.6  | +12.4   | -1.7    | +4.1  |
| portrait-lehna  | 101.6 | -26.1   | -25.8   | -16.6 |

Mean absolute drift on the three dark-skinned sitters: generic 22.7, derived
16.1, hand 15.8. `portrait-glasses` is left out of that mean because it is a
backlit near-silhouette, so any illustration that lights the face reads as a
large positive number and the patch says nothing about complexion there.

Costume goes the same way. The generic prompt turns the lehna cardigan red and
loses the doorway red on the doors and the teal wash on the wall. The derived
list keeps the magenta cardigan, the gold headwrap, the red doors, the teal
wash, and puts `No.18923` on the camera body, which no hand-written list ever
asked for.

**What this settles.** A model-written keep list matches a hand-written one on
this set, on skin and on costume, and beats the prompt the product actually
sends. It costs about a cent a still and five to seven seconds. The option is no
longer a demonstration that works on six photographs somebody studied. Nothing
in the request is tied to a particular picture.

`publishReady` stays false, because whether these sheets clear the bar is the
user's judgement and has not been given. What has changed is that the question
is now worth asking about a real upload rather than about six rehearsed ones.
Adopting means pointing the product POST at this path, which bumps the terms.

## Measurements

Hosted latency and cost are Fal's, not this machine's. A 100-step still on
this set waited about two minutes (99 s to 163 s wall time on the jobs that
actually ran that long) and billed at $0.00125 a compute second, about twenty
cents if the whole wait were compute. Queue time is not billed. Fal locked
the account several times mid-run with an exhausted-balance 403 even while
`users/current` then reported unlocked. The terms now quote those measured
figures.

The identity follow-up measured one long job at 232 s wall and five jobs at
9 s to 27 s. No new compute-second bill was read. Terms stay
`illustrated-v2`.

Kontext list prices on Fal are $0.04 a still for pro and $0.08 for max.
Measured wall on this set: pro 11 s to 144 s, max 12 s to 17 s. FLUX.2
Pro edit measured 16 s to 36 s wall. Nano Banana 2 edit lists $0.08 at
1K. Keep-list wall: Kontext max 11 s to 148 s, Nano 13 s to 38 s. Close-cap
seeds measured 13 s to 182 s. Seedream 4.5 edit lists $0.04 a still and
measured 15 s to 32 s wall. GPT Image 1.5 edit lists $0.133 a still at
high quality 1024, plus token charges, and measured 46 s to 77 s wall.
No new compute-second bill was read. Product terms stay
`illustrated-v2` and still quote PhotoMaker.

The six-family sweep measured wall times of 50 s to 116 s for Seedream 5 Pro,
43 s to 79 s for Seedream 5 Lite, 22 s to 39 s for Nano Banana Pro, 5 s to 28 s
for Qwen 2511, 18 s to 20 s for Grok Imagine, and 16 s to 20 s for FLUX.2 Flex.
Fal list prices were published for two of the six: Seedream 5 Lite at $0.035 a
still and Grok Imagine edit at $0.022 a still. The other four publish no price
in their endpoint metadata and none is guessed here. The account balance fell
from $4.394375 to $0.982175 across the thirty six jobs, $3.41 measured in
total. Fal settles billing with a lag, so a balance read straight after a
family finishes is low.

The compositor contract for an adopted layer is the existing style harness:
unselected pixels stay byte-identical. That test is in
`test/illustrated-layer.test.ts`. It is not a visual-bar test.
