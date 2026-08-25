[Rotyl](../README.md) / Stylisation decisions

# Stylisation decisions

Evidence ledger for the selective person-to-animation treatment. Local paths
were tried first. This page records why they failed and which hosted path was
then authorised.

Nothing here is publish-ready. The licensed set was run on PhotoMaker. The
pictures failed the bar. No demo reel.

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

This work does not reopen Anime, DCT-Net, InstantID, PuLID, or
IP-Adapter-FaceID.

## Measurements

Hosted latency and cost are Fal's, not this machine's. A 100-step still on
this set waited about two minutes (99 s to 163 s wall time on the jobs that
actually ran that long) and billed at $0.00125 a compute second, about twenty
cents if the whole wait were compute. Queue time is not billed. Fal locked
the account several times mid-run with an exhausted-balance 403 even while
`users/current` then reported unlocked. The terms now quote those measured
figures.

The compositor contract for an adopted layer is the existing style harness:
unselected pixels stay byte-identical. That test is in
`test/illustrated-layer.test.ts`. It is not a visual-bar test.
