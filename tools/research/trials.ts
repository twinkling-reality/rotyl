import type { Trial } from './page.ts';

/**
 * What was tried, and what happened to it.
 *
 * This is the only file here that is not generated, because there is nothing to
 * generate it from: a rejected approach leaves no results.json behind, and the
 * reasoning survives only in a README paragraph or in nobody's head. Which is
 * how the same idea gets proposed twice a year and re-measured each time.
 *
 * The rule for an entry is that the third column has to contain a NUMBER or an
 * observation specific enough to argue with. "Felt slow" is not a verdict, and
 * an entry that cannot say what decided it should not be here.
 */
export const TRIALS: readonly Trial[] = [
  {
    what: 'Writing the whole document on every edit, so a crash journal needs no second format',
    verdict: 'rejected',
    evidence:
      'A document is one JSON header with the masks behind it, so the header is at the front and grows with the log: written once that is 11 ms for ten minutes of tracking, and written per edit it is 2559 ms at that size and 42 ms at three hundred frames. Appending one self-describing record instead is 0.13 ms whatever is already in the file',
    where: 'tools/video-bench, measurement 13',
  },
  {
    what: 'Appending to the journal through createWritable, which is all a page has',
    verdict: 'rejected',
    evidence:
      'Opening a writable stream COPIES the file: 0.4 ms on an empty one, 117 ms on 64 MB, linear in between. So the append is not an append, and one record onto a ten-minute journal costs 98 ms on the thread that draws. createSyncAccessHandle is flat at 0.13 ms and does not exist on the main thread at all, which is why this product now has a Web Worker',
    where: 'src/platform/document/journal-worker.ts',
  },
  {
    what: 'Flushing the journal in batches rather than after every record',
    verdict: 'rejected',
    evidence:
      'Nothing to buy. On a 64 MB journal the two are identical at 0.128 ms a record, so durability per record is free, and a journal that is only durable when the browser feels like it is not a journal',
    where: 'tools/video-bench, measurement 13',
  },
  {
    what: 'One journal per media file, so several unfinished sessions can be offered back',
    verdict: 'rejected',
    evidence:
      'It needs a policy for pruning them and a directory that grows without one, to serve a case nobody has described: this product holds one file open at a time, and the drop zone names the file it wants, so opening a different one is an informed choice rather than an accident',
    where: 'src/platform/document/journal-worker.ts',
  },
  {
    what: 'Persisting a file handle so a recovery can reopen the media itself',
    verdict: 'open',
    evidence:
      'A handle from showOpenFilePicker survives in IndexedDB and can be re-acquired with permission, which would make a recovery one click rather than one drop. It needs the open path to become a picker, which is Chrome and Edge only, so opening a file would differ by browser where today it does not. Nothing has been measured',
    where: 'src/platform/document/journal.ts',
  },
  {
    what: 'JSON with the packed masks base64 encoded, as the saved document format',
    verdict: 'rejected',
    evidence:
      'A third larger before anything else happens, and on ten minutes of tracking 1090 ms to write against 11 for a container and 160 ms to read against 12, because every mask is built into a string on the way out and taken apart on the way back. A JSON header with the masks in a region behind it is the same file to read in a text editor and needs no library either',
    where: 'tools/video-bench, measurement 12',
  },
  {
    what: 'Embedding the media in the document, so it always opens',
    verdict: 'rejected',
    evidence:
      'It is right for a photograph and impossible for a clip: the same feature would be a four megabyte file on one and two gigabytes on the other, and writing the second means holding it, which is the exact ceiling measurement 10 exists to have removed. One path for both has been this project’s answer to every question of that shape, and the answer that works for both is a reference plus a way to recognise the file',
    where: 'src/platform/document/media-identity.ts',
  },
  {
    what: 'Digesting the whole media file, so a document is certain which one it belongs to',
    verdict: 'rejected',
    evidence:
      'crypto.subtle.digest takes a BufferSource and the platform has no streaming form of it, so a two gigabyte clip has to be resident to be hashed. Where it fits it runs at about 2000 MB a second, so it is a second of work on top of two gigabytes of heap. The first megabyte, the last megabyte and the length cost 1.9 ms at every size measured from 2 MB to 1 GB',
    where: 'tools/video-bench, measurement 12',
  },
  {
    what: 'Putting the document format behind a dynamic import, the way the container writer is',
    verdict: 'rejected',
    evidence:
      'Measured both ways through the real build: split off it is 2.46 KB gzipped across three chunks and takes 1.58 KB off the application bundle, so it buys a kilobyte and a half back for a session that never saves and costs 0.9 KB more plus three round trips for one that does. The writer is split because it is 42.8 KB. A network fetch in front of Save is a failure mode invented for the one operation that exists to keep somebody’s afternoon',
    where: 'src/platform/document/document-file.ts',
  },
  {
    what: 'Saving the redo tail, so a reopened document can be redone as well as undone',
    verdict: 'rejected',
    evidence:
      'A document holds work that was done and a redo tail is work that was undone. It is also self-defeating: SelectionDocument.apply discards the tail on the next edit, so a saved one would vanish the moment anybody drew a stroke, which is a feature that works exactly until it is used',
    where: 'src/platform/document/document-file.ts',
  },
  {
    what: 'Saving the view, so a document reopens where somebody was looking',
    verdict: 'rejected',
    evidence:
      'Zoom and pan are fitted against a canvas whose size belongs to the window rather than to the work, so a document reopened in a smaller window restores a pan into empty space. The project already treats it that way: use-rotyl.ts carries the view across a lost device separately from the document, because the log is the work and the view is where somebody was standing. The playhead and the range are saved, because both are statements about this clip that somebody made on purpose',
    where: 'src/platform/document/document-file.ts',
  },
  {
    what: 'Caching the rebuilt mask in the document, so a long tracked run opens instantly',
    verdict: 'rejected',
    evidence:
      'Nothing to fix. A ten-minute log folds to one command, because the fold cuts at the last command that decides a frame by itself, and the fold plus unpacking that one mask is 0.3 ms. A cache would be a second source of truth in the one structure this architecture exists to have exactly one of, in exchange for a third of a millisecond',
    where: 'tools/video-bench, measurement 12',
  },
  {
    what: 'Asking where a clip goes after it has been encoded, rather than before',
    verdict: 'rejected',
    evidence:
      'By then the whole file is in the tab, which is the thing a file handle exists to avoid, and the answer might be "nowhere": a dismissed dialog after three minutes of encoding throws three minutes away',
    where: 'src/platform/export/destination.ts',
  },
  {
    what: 'Letting a streaming export put the index at the end of the file, which is what a stream does by default',
    verdict: 'rejected',
    evidence:
      'A different file: nothing plays it until the last byte has arrived and nothing seeks it without reading to the end. Reserving room for it costs under a megabyte on a ten minute clip and needs an exact packet count, which an export has before it renders a frame',
    where: 'src/platform/export/clip-sink.ts',
  },
  {
    what: 'AppendOnlyStreamTarget, which needs no seeking at all',
    verdict: 'rejected',
    evidence:
      'It refuses a non-fragmented MP4 outright, by name, so what it leaves is the index at the end or a fragmented file, and both are files with different properties from the one this has always written',
    where: 'tools/video-bench, measurement 10',
  },
  {
    what: 'Holding every encoded packet until finalize, which is what a buffer target does by default',
    verdict: 'rejected',
    evidence:
      'The media exists twice at the moment it is assembled, the heap grows one for one with the file, and twenty-five minutes of 1080p fails with a RangeError after three and a half minutes of encoding. Reserving the index writes each packet as its chunk closes instead, which also makes the size so far readable',
    where: 'tools/video-bench, measurement 10',
  },
  {
    what: 'Blending the previous stylised frame into this one, to stop a clip boiling',
    verdict: 'rejected',
    evidence:
      'Measured before it was built, on a clip where five cars move against a city that does not. Half of the last frame improves the residue from 3.6 codes to 2.0, which is the number everybody quotes, and costs 58 codes of deviation in the band a car has just left, 53 on the car itself and 13% of the gradient energy inside it. On the clip with no moving grain, where the residue is already at the codec floor, it makes the residue worse and costs the same sixty codes. It also ends "a render is a function of its frame"',
    where: 'tools/style-bench, measurement 5',
  },
  {
    what: 'Averaging each frame against the one before it on the way INTO the chain',
    verdict: 'rejected',
    evidence:
      'One pass, no motion estimation on a fixed camera, and it takes the input down about a fifth and the styled output down with it. It also makes the amplification WORSE wherever it was above one: poster on a brick wall 1.36 to 1.52, on foliage 1.46 to 1.62, comic at full detail 2.02 to 2.48. What it removes is the part these chains attenuate hardest, so it reports less flicker rather than causing less',
    where: 'tools/style-bench, measurement 4',
  },
  {
    what: 'Reading the flicker residue out of the middle of a chain, stage by stage',
    verdict: 'rejected',
    evidence:
      'It needs a way to hand a working buffer out of a style pipeline, which is measurement scaffolding in shipped code and tells the outside what a style does. Three conditions over two clips answer the same question without one: a chain is a pure function of its frame, so a clip with no moving grain prices what it invents at the codec floor, and the amplification ratio prices what it does with what it was given',
    where: 'tools/style-bench/attribution.ts',
  },
  {
    what: 'Judging a temporal method on the flicker number alone',
    verdict: 'rejected',
    evidence:
      'Every temporal method improves it trivially. `static-720p` has a fixed camera and nothing in it can expose a ghost, and `pan-720p` moves a still, so every pixel moves together, which is the one case a warp of the last frame gets right by construction. A clip with differential motion and a mask saying which pixels moved is what makes the trade visible, and it cost one scene change and 342 lines',
    where: 'tools/style-bench, measurement 5',
  },
  {
    what: 'Copying the whole soundtrack in one call after the video, which is the cheapest thing to write',
    verdict: 'rejected',
    evidence:
      'It produces no file at all: with the index reserved the muxer cannot size the movie box until it has seen a packet from every track, so a run of video with the audio behind it queues every frame and, on a track carrying B-frames, fails before a byte is written. Unblocked with one packet in front, the sound of a given second then sits 98% of the file away from its picture and grows with the clip: 32 MB at thirty seconds, 325 MB at five minutes. Interleaved it is a constant 2.7 MB',
    where: 'tools/video-bench, measurement 11',
  },
  {
    what: 'Re-encoding the first audio packet so a range cuts exactly where the video does',
    verdict: 'rejected',
    evidence:
      'The only exact answer, and the only one that stops the sound being the source\u2019s own bytes. What it buys is at most one packet at the head of a range, 21 ms at 48 kHz against a 33 ms frame, and what it costs is an audio decoder and an audio encoder this product otherwise has none of. Dropping the straddling packet instead leaves every remaining one at exactly the moment it was at in the source',
    where: 'src/platform/video/frame-provider.ts',
  },
  {
    what: 'Making an export range a trim of the document rather than a range on the export',
    verdict: 'rejected',
    evidence:
      'Every command in the log carries an absolute frame number and folds forward, so renumbering frames would put the log and the timeline into disagreement about what frame 500 means, and a selection made before the in point would stop applying. Handing over fewer frames with the document\u2019s own numbers on them changes nothing else, and the end-to-end suite exports frames 40 to 49 of a selection made on frame 0',
    where: 'src/platform/export/export-source.ts',
  },
  {
    what: 'Asking the container writer whether it can carry a file\u2019s soundtrack',
    verdict: 'rejected',
    evidence:
      'The writer is 42.8 KB gzipped behind a dynamic import only a clip export fetches, and the question has to be answered while a video is merely open, so asking it would put the whole muxer in the chunk that opens a video. The codec list is written out in export.ts instead and a unit test asserts it against the writer\u2019s own, so an upgrade that changed it fails the suite',
    where: 'src/platform/export/export.ts',
  },
  {
    what: 'Abandoning a clip export when it is stopped, which is what it used to do',
    verdict: 'rejected',
    evidence:
      'A save dialog creates the file the moment it is chosen, so abandoning leaves an empty video file where somebody asked for a video. Finishing at the frame it reached gives a clip anything can open, which is the rule a stopped tracking run already follows',
    where: 'src/platform/export/export.ts',
  },
  {
    what: 'The origin private file system as somewhere to stage a clip in a browser with no save dialog',
    verdict: 'rejected',
    evidence:
      'Its quota is not a disk: estimate() reports three gigabytes on this machine and a write fails just past one, with and without exclusive mode and with durable storage granted. It is also a second full write of the file, and it would still land in the downloads folder afterwards',
    where: 'tools/video-bench, measurement 10',
  },
  {
    what: 'Fetching a real input by URL and hash, rather than publishing a number nobody can re-take',
    verdict: 'adopted',
    evidence:
      'The measurement it feeds reversed sign on a photograph: the poster chain amplified its input by five on a brick wall where the drawn scene reports it attenuating by two, which cost that style its outline operator',
    where: 'tools/style-bench/fetch-real.sh, and "What survived a real picture"',
  },
  {
    what: 'Softening the poster outline’s neighbour probe, so the field it thresholds is continuous',
    verdict: 'rejected',
    evidence:
      'Cuts the signal as much as the noise: 78 codes to 69 on a brick wall, for a visible weakening of every genuine outline on every picture',
    where: '"What survived a real picture", the outline',
  },
  {
    what: 'Widening the poster outline’s threshold one-sidedly, as it was written',
    verdict: 'rejected',
    evidence:
      'A transition opening at the decision displaces it rather than resolving it: wide enough to be steady took the outlines off the reference scene altogether, and a genuine boundary is only one band past the threshold to begin with',
    where: '"What survived a real picture", the outline',
  },
  {
    what: 'Centring that threshold’s transition on itself, and flooring its half width',
    verdict: 'rejected',
    evidence:
      'The correct shape and free, so it shipped for a chapter: 0.98% of pixels move more than 8 codes against the previous render, against 1.92% for the probe change. It still left the wall three times above the floor, and it went with the operator it was shaping',
    where: 'src/core/style/poster/wgsl/poster.wgsl',
  },
  {
    what: 'Making the poster outline temporally sound by any transition width at all',
    verdict: 'rejected',
    evidence:
      'The quantity being thresholded was a distance between two quantised colours and therefore discrete: a hard probe left nothing for a width to resolve and a soft one lost the signal. Every combination of the two was measured at four widths, and the best of them sat three times above the floor',
    where: '"What survived a real picture", the four tuning passes',
  },
  {
    what: 'Reading the flattened colour rather than its rounding, and making the outline’s weight that distance ramped up to the threshold',
    verdict: 'adopted',
    evidence:
      'On a brick wall a perturbation of six codes comes out at 15 rather than 78, against 8 for the same picture with no outline at all, and the same clip goes from 5.7 times its input to 1.36. It costs 7.8% of the reference scene, and what it costs is the contours the quantiser was drawing on its own grid',
    where: 'src/core/style/poster/wgsl/poster.wgsl',
  },
  {
    what: 'Closing the last five codes between the poster outline and no outline at all',
    verdict: 'open',
    evidence:
      'What is left is not the quantiser: it is the flatten’s own edge contrast moving under grain, and any weight that follows contrast follows that too. Widening the ramp buys it back in proportion and takes the outlines with it, measured at 12 codes for a ramp twice as wide and visibly grey lines',
    where: 'docs/limits.md',
  },
  {
    what: 'Pairs of a value and a length for the masks a tracked run leaves in the log',
    verdict: 'rejected',
    evidence:
      'The same size as PackBits to within a tenth of a per cent on a crisp boundary, 9.2 times against 11.8 on one six texels across, which is what an engine produces where it is unsure, and twice the size of what it encodes in the bad case rather than one byte in 128',
    where: 'src/core/document/coverage-mask.ts',
  },
  {
    what: 'Cutting a frame’s fold at the last command that decides it by itself',
    verdict: 'adopted',
    evidence:
      'Unpacking alone was 10.5 ms of a 33 ms frame across the three hundred masks a ten-second tracked run folds to, all but the last of them discarded by the next. Three hundred commands become one, and eighteen thousand become one',
    where: 'src/core/document/selection-command.ts',
  },
  {
    what: 'A guided filter against the photograph, for the model’s mask boundary',
    verdict: 'adopted',
    evidence:
      'On a synthetic edge, an engine error of one texel lands 3.5 image pixels out magnified and −0.5 refined; the window spans about six engine texels, which is where it gives out',
    where: 'README, "Selecting an object"',
  },
  {
    what: 'One decoder held open and fed forward, re-seeking only backward or far',
    verdict: 'adopted',
    evidence: 'The next frame costs 0.47 ms and a seek 15 ms, or 88 ms on a clip with a single keyframe',
    where: 'tools/video-bench, measurement 3',
  },
  {
    what: 'mediabunny as the demuxer, over hand-rolling one',
    verdict: 'adopted',
    evidence:
      'An ffmpeg MP4 carries an edit list whose media_time removes the composition delay: ignore it and every timestamp is two frames late, with no crash and no warning',
    where: 'tools/video-bench, "The demuxer"',
  },
  {
    what: 'Deriving each stage’s resolution from the apparent scale it wants',
    verdict: 'adopted',
    evidence:
      'A radius written in pixels makes cost grow with the fourth power of resolution; derived, it grows linearly, and a preview composes identically to an export',
    where: 'README, "Resolution is derived, not configured"',
  },
  {
    what: 'Playback holding full quality until the frames prove it cannot',
    verdict: 'adopted',
    evidence:
      '46 ms a frame against a 20 ms budget still plays 44 of 50 frames a second, because unrenderable frames are skipped rather than queued',
    where: 'README, "Video, so far"',
  },
  {
    what: 'Capturing the composite from the canvas it already renders into',
    verdict: 'adopted',
    evidence:
      'Costs nothing detectable; the alternative, copying the texture into a buffer and rebuilding a frame from the bytes, costs 1.4 ms a frame at 1080p and a de-padding loop',
    where: 'tools/video-bench, measurement 5',
  },
  {
    what: 'mediabunny driving the encoder as well as writing the container',
    verdict: 'adopted',
    evidence:
      'Costs 0.26 ms a frame, 5%, and 18.0 KB gzipped inside a chunk only a clip export fetches, against owning codec strings, backpressure, flush ordering and the muxer’s first packet',
    where: 'src/platform/export/clip-sink.ts',
  },
  {
    what: 'A bitrate for a clip export, rather than the encoder’s default quality level',
    verdict: 'adopted',
    evidence:
      'A qualitative level resolves to a quantizer, which asked for 30 Mbit/s where the same level as a bitrate asked for 12, at identical speed',
    where: 'tools/video-bench, measurement 5',
  },
  {
    what: 'latencyMode realtime for the export encoder',
    verdict: 'rejected',
    evidence:
      'Slower at both sizes, a reproducible three-second stall at 720p, and the mode is permitted to drop frames, which for an export is a corrupt file',
    where: 'tools/video-bench, measurement 5',
  },
  {
    what: 'Writing Matroska as well as MP4',
    verdict: 'rejected',
    evidence:
      '8.5 KB gzipped for a second container writer, where QuickTime is 11 bytes, and it carries codecs whose encode has not been measured here',
    where: 'tools/video-bench, measurement 6',
  },
  {
    what: 'Putting the container writer in the video chunk',
    verdict: 'rejected',
    evidence:
      '42.8 KB gzipped, the size of the entire application bundle, paid by everyone who opens a video rather than by everyone who exports a clip',
    where: 'tools/video-bench, measurement 6',
  },
  {
    what: 'React for the interface',
    verdict: 'rejected',
    evidence:
      '59.5 KB gzipped against Preact’s 6.1 KB, for an application whose interface is a canvas and eight buttons',
    where: 'README, "How it is put together"',
  },
  {
    what: 'A WebGL2 fallback path',
    verdict: 'rejected',
    evidence:
      'Doubles the shader surface permanently, to serve browsers that will have WebGPU before it is finished',
    where: 'README, "How it is put together"',
  },
  {
    what: 'Web Workers for export',
    verdict: 'rejected',
    evidence:
      'Measured 50% SLOWER than the main thread: moving a full-resolution image across the boundary costs more than the parallelism returns',
    where: 'README, "How it is put together"',
  },
  {
    what: 'Bundling the segmentation model',
    verdict: 'rejected',
    evidence: '36 MB in the initial download for a feature most sessions never touch; code-split instead',
    where: 'README, "Selecting an object"',
  },
  {
    what: 'WebM and Matroska support',
    verdict: 'rejected',
    evidence:
      '15.4 KB gzipped for a second demuxer carrying codecs whose decode has never been measured here',
    where: 'tools/video-bench, "The demuxer"',
  },
  {
    what: 'Sharing Rotyl’s GPUDevice with the inference runtime',
    verdict: 'rejected',
    evidence:
      'The execution provider’s device option fails session creation with and without matched features and limits, in 1.27.0',
    where: 'tools/video-bench, measurement 1',
  },
  {
    what: 'The runtime’s older JSEP backend',
    verdict: 'rejected',
    evidence: 'The mask decoder is silently wrong on it: no error, an all-zero confidence, the wrong object',
    where: 'src/platform/perception/edgetam-engine.ts',
  },
  {
    what: 'Growing the memory bank as a clip plays',
    verdict: 'rejected',
    evidence:
      'A graph shape per frame, and a pipeline recompile with each; padding and masking costs nothing',
    where: 'tools/edgetam-export, "The memory bank is fixed-size"',
  },
  {
    what: 'Half precision for the memory encoder',
    verdict: 'rejected',
    evidence:
      'Its worst element moves by half the signal, and that output conditions every later frame, so the error compounds',
    where: 'tools/video-bench, measurement 2',
  },
  {
    what: 'Half precision for memory attention',
    verdict: 'adopted',
    evidence: '59 ms to 38 ms and 70 MB to 35 MB, for a worst-case error of 3% of the signal',
    where: 'tools/video-bench, measurement 2',
  },
  {
    what: 'Dropping the quality tier during playback',
    verdict: 'rejected',
    evidence:
      'On a small clip at high detail both tiers are the same render anyway, and on a large one no tier saves it; it made the output look like a cheap filter while it moved',
    where: 'README, "Video, so far"',
  },
  {
    what: 'Skipping the style chain while nothing is selected',
    verdict: 'rejected',
    evidence:
      'Only helps before a selection exists, and moves the cost to the first brush stroke on each frame, where a 105 ms stall is worse',
    where: 'README, "Measured"',
  },
  {
    what: 'Commands applying to their own frame alone',
    verdict: 'rejected',
    evidence:
      'Built that way first: with nothing able to produce the missing frames it trades a selection that drifts for no selection at all',
    where: 'README, "Video, so far"',
  },
  {
    what: 'A scalar guide for mask refinement',
    verdict: 'rejected',
    evidence:
      'Two regions of equal lightness and different hue are exactly the case it cannot see; the guide is the photograph in Oklab',
    where: 'README, "Selecting an object"',
  },
  {
    what: 'Half-precision statistics in the guided filter',
    verdict: 'rejected',
    evidence: 'At half precision the variance carries noise the same order as the regularisation constant',
    where: 'src/core/mask/mask-refiner.ts',
  },
  {
    what: 'A palette applied at its own coordinates',
    verdict: 'rejected',
    evidence:
      'A hazy photograph has a lightness spread of 0.136 against a palette’s 0.23 to 0.29, so it reads through two and a half of five stops and comes out one colour',
    where: 'tools/style-bench, measurement 3',
  },
  {
    what: 'A gradient map as the only way to impose colour',
    verdict: 'rejected',
    evidence:
      'Indexed by lightness alone it cannot keep two things apart: a red tail light and a grey wall of the same lightness take the same colour',
    where: 'src/core/style/wgsl/palette.wgsl',
  },
  {
    what: 'Hard quantisation antialiased against fwidth alone',
    verdict: 'rejected',
    evidence:
      'p99 of 23 codes and 1.7% of pixels visibly flickering on a fixed camera, against 3.2 for comic',
    where: 'tools/style-bench, measurement 2',
  },
  {
    what: 'A difference of Gaussians for the poster outline',
    verdict: 'rejected',
    evidence:
      'It reads the photograph, so it answers to contrast wherever it finds it and inks smog and sensor noise, and the threshold that stops it also stops it drawing the faint boundary that mattered. What ships measures contrast too, in the flattened picture, which is where those three have already gone',
    where: 'src/core/style/poster/wgsl/poster.wgsl',
  },
  {
    what: 'An anisotropic Kuwahara for the poster flatten',
    verdict: 'rejected',
    evidence:
      'O(radius²) and 119 ms at 720p; a separable bilateral iterated three times is O(radius) and 1.1',
    where: 'tools/style-bench, measurement 1',
  },
  {
    what: 'Masking before the style chain rather than at the composite',
    verdict: 'rejected',
    evidence:
      'Cheaper, and wrong: kernels sample outside their own pixel, so pixels just inside the selection would be computed from zeroed neighbours and draw a halo',
    where: 'src/core/render/wgsl/composite.wgsl',
  },
  {
    what: 'Rendering a full style chain in the Dawn unit suite',
    verdict: 'rejected',
    evidence:
      'One added render took a file from 0 aborts in 12 runs to 10 in 12; the coverage moved to Playwright, where a browser has no such limit',
    where: 'README, "Known limits"',
  },
  {
    what: 'Playwright’s bundled Chromium for GPU tests',
    verdict: 'rejected',
    evidence: 'It falls back to SwiftShader, which reports success while producing different pixels',
    where: 'playwright.config.ts',
  },
  {
    what: 'Shipping shader comments',
    verdict: 'rejected',
    evidence: '17 KB gzipped, a quarter of the application bundle, for prose no user reads',
    where: 'vite.config.ts',
  },
  {
    what: 'Limited versus full range video',
    verdict: 'open',
    evidence:
      'Never exercised: both 4:2:0 probes produced identical values and Chrome reported fullRange false for both, including the one tagged pc',
    where: 'tools/video-bench, measurement 4',
  },
  {
    what: 'Learned edge detection, and neural style transfer',
    verdict: 'open',
    evidence:
      'Roughly 700 KB and 7 MB respectively; neither has been run on the WebGPU execution provider, and neither is temporally measured',
    where: 'tools/style-bench, "What follows"',
  },
];
