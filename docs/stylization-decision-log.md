[Rotyl](../README.md) / Stylisation decisions

# Stylisation decisions

Evidence ledger for the selective person-to-animation treatment. Started 24
August 2026, updated 25 August after official FaceAna renders on the same set.
This checkout was a clean `main` at `6874749`. The DCT-Net hybrid described in
the handoff was not present. The original pasted specification file was not on
this machine; the handoff text was treated as authoritative.

The ledger and the Anime slot are in the tree. Evaluation media, official
DCT-Net graphs, and rendered sheets stay gitignored. Nothing was deployed or
published.

## Candidate matrix

Licences were read from official repositories, official model cards, and
licence files. A permissive code licence was not treated as a weight licence.
Unofficial ONNX conversions were rejected even when a third-party page labelled
them Apache-2.0.

| candidate                 | official source                                                                                                                                                  | paper                                                                                 | code                                    | weights                                                                     | commercial                            | redistribute                | training provenance                                                                                                                 | size                                                                                                                                                        | browser                                                        | verdict                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| DCT-Net anime             | [menyifang/DCT-Net](https://github.com/menyifang/DCT-Net), [ModelScope card](https://www.modelscope.cn/models/damo/cv_unet_person-image-cartoon_compound-models) | Men et al., SIGGRAPH 2022 / TOG, [arXiv:2207.02426](https://arxiv.org/abs/2207.02426) | Apache-2.0                              | Apache License 2.0 on the ModelScope card (`License` field, API 2026-08-24) | yes, under Apache-2.0                 | yes, with notice            | FFHQ plus "100+ cartoon faces collected from the internet". Official README cannot release cartoon exemplars for copyright reasons. | `cartoon_anime_h.pb` 5,894,895 B; `cartoon_anime_bg.pb` 5,894,895 B; `detector.pb` 4,475,998 B; `keypoints.pb` 4,146,481 B. Official path warps a 288 face. | feasible after a documented TF frozen-graph to ONNX conversion | authorized, then rejected on look: official FaceAna hybrid on this set still fails the visual bar. Not converted, not shipped |
| AnimeGANv3                | [TachibanaYoshino/AnimeGANv3](https://github.com/TachibanaYoshino/AnimeGANv3)                                                                                    | Liu et al. related work; official terms are the repo licence                          | custom, non-commercial                  | same terms                                                                  | no, unless Asher Chan issues a letter | no                          | studio-style stills                                                                                                                 | ~8–15 MB ONNX in unofficial conversions                                                                                                                     | yes, and irrelevant                                            | rejected: official terms prohibit commercial use                                                                              |
| AnimeGANv2 community ONNX | Hugging Face mirrors such as `vumichien/AnimeGANv2_Hayao`                                                                                                        | Chen et al.                                                                           | often labelled Apache-2.0 by converters | original AnimeGAN terms are not Apache                                      | no                                    | unofficial relicence        | Hayao / Shinkai stills                                                                                                              | ~8.6 MB                                                                                                                                                     | yes                                                            | rejected: unofficial conversion of a restricted model                                                                         |
| White-box Cartoonization  | [SystemErrorWang/White-box-Cartoonization](https://github.com/SystemErrorWang/White-box-Cartoonization)                                                          | Wang and Yu, CVPR 2020                                                                | CC BY-NC-SA 4.0                         | same                                                                        | no                                    | share-alike, non-commercial | cartoon stills                                                                                                                      | tens of MB                                                                                                                                                  | possible                                                       | rejected: NC-SA                                                                                                               |
| Photo2Cartoon             | [minivision-ai/photo2cartoon](https://github.com/minivision-ai/photo2cartoon)                                                                                    | Minivision writeup                                                                    | MIT                                     | Google Drive weights, no separate weight card                               | code yes; weights unclear             | unclear                     | "young Asian women"; authors say other groups are poorly covered                                                                    | ONNX on Drive                                                                                                                                               | possible                                                       | rejected: weight licence and evaluation diversity                                                                             |
| U-GAT-IT selfie2anime     | [taki0112/UGATIT](https://github.com/taki0112/UGATIT)                                                                                                            | Kim et al., ICLR 2020                                                                 | MIT                                     | Drive checkpoints                                                           | code yes                              | unclear for weights         | selfie2anime                                                                                                                        | large                                                                                                                                                       | poor                                                           | rejected: face crop, not a full person                                                                                        |
| MediaPipe Face Stylizer   | [Google AI Edge](https://developers.google.com/edge/mediapipe/solutions/customization/face_stylizer)                                                             | MediaPipe                                                                             | Apache-2.0                              | Apache-2.0 for the framework and published models                           | yes                                   | yes, with notice            | cartoon / oil face only                                                                                                             | small                                                                                                                                                       | yes                                                            | rejected: face crop, not anime, not clothing or hands                                                                         |
| Anima / SD-class          | various                                                                                                                                                          | 2024–2026 DiT / SD                                                                    | mixed                                   | typically NC                                                                | no                                    | no                          | huge scraped sets                                                                                                                   | gigabytes                                                                                                                                                   | not usefully                                                   | rejected: size, licence, hosted-class cost                                                                                    |

Hosted diffusion (InstantID, IP-Adapter, PhotoMaker, PuLID, ToonCrafter) can
beat any of the above on a still. They are a different product: media leaves
the machine, or a multi-hundred-megabyte runtime is downloaded. That is an
authorization boundary, not a local implementation task.

## Architecture decision

Four questions, answered from the matrix and from this repository's own
constraints rather than from optimism.

1. Can a small DCT-Net refinement pass the visual bar? No. The handoff's local
   hybrid had already failed it and is not in this checkout. Official FaceAna
   plus the published 288 head graph was then run on the same stills. Alignment
   is no longer the excuse: faces land on faces, then the head model replaces
   them with a cartoon template or a melted smudge. That is the model, not Haar.
2. Can a stronger local neural model run in the browser at useful resolution?
   The only clearly licensed full-body portrait stylizer small enough to fetch
   is DCT-Net. Official inference is a 288 aligned head plus a background
   graph. That is a detail ceiling, not a full-resolution model.
3. Can Rotyl's style contract host that model? A style is a synchronous GPU
   chain. ONNX Runtime Web is already present for EdgeTAM and creates its own
   device. A neural pass would be asynchronous, cached, and a second runtime
   conversation. Justified only if rendered evidence beats a full-resolution
   shader chain on identity, anatomy and motion.
4. Can video stay stable? Style-bench already showed that a per-frame smoothing
   chain attenuates grain and that a previous-frame blend smears motion. A
   neural GAN that reorganises faces per frame is the case that measurement
   exists to catch.

**Shipped architecture.** Anime is a WebGPU cel pass. It reuses the comic
flatten and ink, which are the operators that hold still on video, and replaces
the last pass. Hue is kept. Lighting is keyed (warm highlight, cool shadow).
Skin chroma is held. Clothing chroma is lifted. Dark hair can take a specular
sheet. Strength is a source-to-treatment crossfade. Line is ink weight. Colour
is how far the lighting and chroma treatment go. Preview and export are the
same parameter mapping as every other style.

**Visual verdict, shader, 24 August 2026.** This architecture does not pass the
person-to-animation bar. The same evaluation stills, rendered through the real
compositor at a 1200-pixel long edge, read as a posterise-and-ink filter of
the photograph. Eyes remain photographic patches. Hair becomes a dark mass.
A paused face does not look drawn. Comic and Anime are distinguishable, but
the difference is lighting and chroma, not a change of medium. Retuning the
last-pass knobs cannot invent facial drawing that the flatten discarded. That
is an architectural limit, not a slider problem.

**Visual verdict, official DCT-Net, 25 August 2026.** Same stills, official
graphs, official FaceAna 5-point warp from a `/tmp/DCT-Net` checkout of
`source/cartoonize.py`. The background graph is a painterly filter of the
whole frame. The head graph, when a face is found, pastes a 288 cartoon head
through `alpha.jpg`. On Lehna and the occlusion still that is sticker eyes
and a missing nose. On the Somali portrait and the hands still it is a
melted face. On the doorway still the face becomes a void. Haar-box hybrids
were worse on identity because the crop missed; official alignment closes
that caveat and does not clear the bar. Converting the same graphs to ONNX
would ship the same look plus a second runtime.

**Not shipped.** DCT-Net ONNX, face-landmark head blends, a second inference
runtime, hosted stylisation. Official graphs were downloaded, hashed, and
run offline. They were not converted and not added to the product.

**Authorization boundary.** Clearing the bar needs an identity-preserving
illustrated generator (hosted InstantID / IP-Adapter / PhotoMaker / PuLID, or
an equivalently licensed local model large enough that this browser product
cannot carry it). That sends media off the machine, or downloads a
multi-hundred-megabyte runtime. It is a product decision, not a local
implementation task. The smallest ask: whether Rotyl may add an explicitly
separate hosted stylise option, with stated privacy, cost, latency, and
retention.

## What earlier experiments this replaces

None in this repository. The handoff named a local DCT-Net hybrid
(`src/platform/stylization/anime-engine.ts` and friends). Those files were
absent here. They were not ported, because the handoff already recorded that
they failed the visual bar, and because unofficial or unconverted weights were
not going to be silently introduced.

## Measurements

This cloud VM has no hardware GPU. Chrome 148 only exposed WebGPU through
SwiftShader (`--use-webgpu-adapter=swiftshader`). Node Dawn found no adapter
until lavapipe was installed, then aborted on the first full style chain
("futex facility returned an unexpected error code"). Numbers below are
therefore SwiftShader CPU timings on this machine. They are not product
timings and must not be generalised, including not to the handoff's MacBook
Pro (M3 Pro, 18 GB, macOS 26.5.1, Chrome 151).

Adapter reported by the evaluation page: vendor `google`, architecture
`swiftshader`, device `0xc0de`, description `SwiftShader Device (Subzero)`,
user agent HeadlessChrome/148, `hardwareConcurrency` 4.

| item                        | value                  | notes                                                                      |
| --------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| Anime model download        | none                   | shader chain                                                               |
| DCT-Net official graphs     | see hashes below       | run offline; not converted; not shipped                                    |
| Official FaceAna detections | 6 of 8 stills          | 0 on close and glasses; 2 faces on crossing-mid                            |
| Selective compositor        | 94.8 s / 4 stills      | SwiftShader; GrabCut substitute masks; `outsideMax` 1–12 codes             |
| Evaluation wall             | 261.4 s for 16 images  | source + Comic + Anime each, plus PNG write                                |
| Warm still (SwiftShader)    | 13.2–14.8 s            | 800–1200 px long edge; six stills                                          |
| TOS frame (SwiftShader)     | 5.07–5.17 s            | 1200×501                                                                   |
| Browser-exposed memory      | not claimed            | `performance.memory` was not recorded; do not invent a heap figure         |
| Hardware GPU still / export | not measured here      | this VM cannot expose one                                                  |
| Preview vs export           | same parameter mapping | both go through `resolveAnimeParams`; not pixel-compared on a hardware GPU |

JSON timings: `tools/style-bench/results-anime-eval.json` and
`tools/style-bench/results-anime-selective.json`.

Official ModelScope files, SHA-256, kept under gitignored
`tools/style-bench/real/dct/`:

| file                  | bytes     | sha256                                                             |
| --------------------- | --------- | ------------------------------------------------------------------ |
| `cartoon_anime_bg.pb` | 5,894,895 | `71efec51b4566cce3a3123822fb4e17794ad062c3e324b33f2a65df850c037ad` |
| `cartoon_anime_h.pb`  | 5,894,895 | `338e7bf7ab4014ba9da864c2dda104f26d8af6c7f468038782d92ccc8e2dedda` |
| `detector.pb`         | 4,475,998 | `8e42012b74def7225fd70b0df5814090a8f36787b860e91032c06d55adae5ad4` |
| `keypoints.pb`        | 4,146,481 | `80d03c931bc15ec9d3113e446cba4f35b4d8a0f8323b04fe547fb8d280f446d6` |
| `alpha.jpg`           | 23,133    | `cfde5c765d2ade4a4e968bbe4149682c2557d5e84f5ae48e9e20f48499faac2e` |

FaceAna was the published stack from `/tmp/DCT-Net`, not ModelScope's
Python package. Two local patches were required to run it on this
machine: `LK/lk.py` imported `modelscope`, and `face_landmark.py` used
`np.int`. Neither patch changes the graphs.

## Rendered evidence

Full-frame style (mask of ones), so these sheets judge the look, not the
compositor. The compositor's unselected-pixel contract is the existing style
harness, not these pictures.

Contact sheets, source / Comic / Anime:

- `tools/style-bench/out/evaluation/sheets/portrait-close-source-comic-anime.jpg`
- `tools/style-bench/out/evaluation/sheets/portrait-glasses-source-comic-anime.jpg`
- `tools/style-bench/out/evaluation/sheets/portrait-somali-source-comic-anime.jpg`
- `tools/style-bench/out/evaluation/sheets/portrait-lehna-source-comic-anime.jpg`
- `tools/style-bench/out/evaluation/sheets/portrait-doorway-source-comic-anime.jpg`
- `tools/style-bench/out/evaluation/sheets/portrait-hands-source-comic-anime.jpg`
- `tools/style-bench/out/evaluation/sheets/tos-crossing-{early,mid,late}-source-comic-anime.jpg`
- `tools/style-bench/out/evaluation/sheets/tos-occlusion-{early,mid,late}-source-comic-anime.jpg`
- `tools/style-bench/out/evaluation/sheets/tos-crossing-adj-anime.jpg`
- `tools/style-bench/out/evaluation/sheets/tos-occlusion-adj-anime.jpg`

Face crops:

- `tools/style-bench/out/evaluation/crops/somali-anime-face.png`
- `tools/style-bench/out/evaluation/crops/lehna-anime-face.png`
- `tools/style-bench/out/evaluation/crops/hands-anime-face.png`
- `tools/style-bench/out/evaluation/crops/occlusion-mid-anime-face.png`

Source / Anime / DCT background / Haar hybrid / official FaceAna hybrid:

- `tools/style-bench/out/evaluation/sheets/portrait-somali-source-anime-dct-official.jpg`
- `tools/style-bench/out/evaluation/sheets/portrait-lehna-source-anime-dct-official.jpg`
- `tools/style-bench/out/evaluation/sheets/portrait-hands-source-anime-dct-official.jpg`
- `tools/style-bench/out/evaluation/sheets/portrait-doorway-source-anime-dct-official.jpg`
- `tools/style-bench/out/evaluation/sheets/tos-crossing-mid-source-anime-dct-official.jpg`
- `tools/style-bench/out/evaluation/sheets/tos-occlusion-mid-source-anime-dct-official.jpg`

Official FaceAna face crops:

- `tools/style-bench/out/evaluation/crops/somali-dct-official-face.png`
- `tools/style-bench/out/evaluation/crops/lehna-dct-official-face.png`
- `tools/style-bench/out/evaluation/crops/hands-dct-official-face.png`
- `tools/style-bench/out/evaluation/crops/occlusion-mid-dct-official-face.png`

Selective composites through the real `CompositeRenderer`. Masks are
GrabCut, labelled as a substitute for EdgeTAM, because this VM's WebGPU
is SwiftShader. Source / mask / full-frame Anime / compositor mix:

- `tools/style-bench/out/evaluation/sheets/portrait-somali-selective.jpg`
- `tools/style-bench/out/evaluation/sheets/portrait-lehna-selective.jpg`
- `tools/style-bench/out/evaluation/sheets/portrait-hands-selective.jpg`
- `tools/style-bench/out/evaluation/sheets/tos-occlusion-mid-selective.jpg`

Mask-edge crops (source | mask | composite):

- `tools/style-bench/out/evaluation/crops/portrait-somali-selective-edge.png`
- `tools/style-bench/out/evaluation/crops/portrait-lehna-selective-edge.png`
- `tools/style-bench/out/evaluation/crops/portrait-hands-selective-edge.png`
- `tools/style-bench/out/evaluation/crops/tos-occlusion-mid-selective-edge.png`

`outsideMax` is the largest RGB code difference on pixels whose GrabCut
coverage is 8 or below: Somali 3, Lehna 12, hands 2, occlusion 1. Those
are soft-edge and GrabCut-leak numbers, not a claim that the product
mask is byte-identical. Lehna's geometric background shows GrabCut leak
as a smear next to the shoulder. The compositor itself is the existing
style harness.

## Failures, assigned

| worst visible failure                                               | subsystem   |
| ------------------------------------------------------------------- | ----------- |
| Faces read as posterised photographs with ink, not drawn characters | stylisation |
| Eyes remain muddy photographic patches without irises or highlights | stylisation |
| Hair collapses to a mass; individual sheets are not invented        | stylisation |
| Crossing-shot faces become dark dashes at medium scale              | stylisation |
| Profile under backlight becomes a silhouette                        | stylisation |
| Official DCT head paste: sticker eyes, missing nose, or melted face | stylisation |
| Official DCT background graph stylises the whole frame              | stylisation |
| Full-frame bench sheets also stylise the background                 | bench       |
| GrabCut leaks into Lehna's geometric backdrop                       | selection   |
| SwiftShader-only WebGPU on this VM                                  | environment |

The background leak in the sheets is the bench, not the product: `StyleStage`
writes a full-coverage mask so the look can be judged. Unselected pixels stay
byte-identical through `CompositeRenderer`, which the existing style harness
already asserts.

A blinded preference test was not run. The pictures do not need one: a
neutral viewer is being asked to prefer a filter they can already name.

## Known limits of the shipped chain

- It is not a learned character generator. Hair sheets, eye highlights and
  clothing folds come from the picture's own structure, then get flattened.
- Soft skin-likelihood is a hue/chroma heuristic. Unusual lighting, makeup,
  monochrome stills and some darker or very fair skin can be under- or
  over-classified. Hue is still kept, so a face does not become a costume.
- Profiles, glasses, hands and occlusion are only as good as the flatten and
  the selection. Segmentation and tracking failures are not styliser failures.
- Small faces keep less facial drawing because the ink buffer is derived from
  apparent scale, not from a 256 px aligned crop.
- Re-encoded video keeps the background outside the style pass. It does not
  keep byte-identical unselected pixels after H.264.
- This VM cannot run the Dawn Node style tests or a hardware-GPU browser
  suite. Chrome 148 needed `--use-webgpu-adapter=swiftshader` to get an
  adapter at all.

## Evaluation media

Provenance is in `tools/style-bench/evaluation-set.json`. Nothing fetched is
committed. Tears of Steel remains CC-BY 3.0, (CC) Blender Foundation. The
crossing window is stream-copied from 25.75 s (193 frames). The occlusion
window is stream-copied from 360 s (149 frames). Stills are CC0 Wikimedia
photographs, including two Unsplash uploads published before 5 June 2017.
