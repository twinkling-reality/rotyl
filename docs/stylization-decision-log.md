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
holds less. The set does not clear the bar. This work does not reopen
Anime, DCT-Net, InstantID, PuLID, or IP-Adapter-FaceID.

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
Pro edit measured 16 s to 36 s wall. No new compute-second bill was
read. Product terms stay `illustrated-v2` and still quote PhotoMaker.

The compositor contract for an adopted layer is the existing style harness:
unselected pixels stay byte-identical. That test is in
`test/illustrated-layer.test.ts`. It is not a visual-bar test.
