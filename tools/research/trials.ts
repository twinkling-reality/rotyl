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
