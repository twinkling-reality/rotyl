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
    what: 'Fetching a private project release through its browser download URL with a bearer token',
    verdict: 'rejected',
    evidence:
      'The empty-cache proof received 404 on the first asset even though the local GitHub session was authenticated. The authenticated release-assets API then obtained and verified all 91,280,555 decompressed bytes. Public releases can still use the direct URL; private builds resolve the same named assets through the API and never send the project token to a source override',
    where: 'tools/model-assets/prepare.mjs and /research/model-delivery.html',
  },
  {
    what: 'VITE_TRACKING_HOST as a permanent deployment decision',
    verdict: 'rejected',
    evidence:
      'It was the honest answer while the project distributed no tracking assets: a missing setting removed the button, because the wrong setting failed after a large fetch at the moment Track was pressed. Ownership changes the premise. The verified tracking release is 22.24 MB served and every deployment contains it now, so the environment variable would preserve a way to build a partial product and a way to bypass the project release. Build preparation may obtain the complete release from another directory or origin, but the manifest stays fixed and runtime always uses the application origin',
    where: 'models/edgetam/README.md and /research/model-delivery.html',
  },
  {
    what: 'Leaving object selection on the third-party model host after tracking moved',
    verdict: 'rejected',
    evidence:
      'It would close only half the dependency and leave two features sharing one encoder from different authorities. The owned half-precision selection files are 18.57 MB served, the first page makes zero model requests, and moving the loader behind first use takes the application control from 51.3 KB to 49.8 KB gzipped. There is no first-load price for putting both features under one release, while a third-party outage and silent replacement remain real prices for leaving one behind',
    where: 'src/platform/perception/model-assets.ts and /research/model-delivery.html',
  },
  {
    what: 'Serving the ONNX files uncompressed and relying on the static host to recognise them',
    verdict: 'rejected',
    evidence:
      'ONNX is normally application/octet-stream and a portable build cannot assume its host will compress it. The complete model directory is 91.28 MB raw against 78.19 MB as the explicit gzip files the build emits. A half-precision session using selection and tracking is 50.37 MB raw against 40.81 MB served. Explicit decompression takes 123 ms for selection and 166 ms for tracking on the measurement machine, paid once before the model runs, in exchange for 9.56 MB less origin traffic in that session',
    where: 'tools/model-assets/vite.ts and /research/model-delivery.html',
  },
  {
    what: 'Checking model digests only at build',
    verdict: 'rejected',
    evidence:
      'The build check covers the release input and costs 74 ms for all 91.28 MB, but it cannot cover the deployment origin response or Cache Storage that exist afterwards. The fetch check costs 17 ms for half-precision selection and 26 ms for tracking, and closes both later boundaries before ONNX Runtime receives a byte. A versioned URL prevents intended replacement; a digest refuses accidental or hostile replacement under that URL',
    where: 'src/platform/perception/model-store.ts and /research/model-delivery.html',
  },
  {
    what: 'Checking model digests only after fetch',
    verdict: 'rejected',
    evidence:
      'It would eventually protect a user and still allow a deployment containing a missing or wrong file to be published. Hashing the whole release during build costs 74 ms and turns that mistake into no deployment at all. The browser repeats the check because it owns a different boundary, not because either hash is distrusted',
    where: 'tools/model-assets/vite.ts and /research/model-delivery.html',
  },
  {
    what: 'Using the Dawn process exit as the unit-test gate',
    verdict: 'rejected',
    evidence:
      'Measured over 32 unchanged suites, 29 exited cleanly and 3 native workers exited with no failed assertion, so an exit-only gate rejects 9.38% of unchanged runs. One carried a report proving all 284 assertions passed and two left cases pending, which also rules out accepting the native exit by signature. Assertion completion is the proof and the exit is not',
    where: 'tools/ci-bench/results.json and /research/ci.html',
  },
  {
    what: 'Rerunning the whole unit suite after any nonzero exit',
    verdict: 'rejected',
    evidence:
      'It reruns 279 or 283 assertions already proved in the two incomplete observations and would rerun a real failure too, which is how a flaky gate hides a flaky test. The report names the one incomplete file. Only that file gets a fresh Dawn process, and no failed assertion is retried. Three total processes come from the observed 1.17% per-Dawn-process exit rate: the estimated residual is 0.0013% of suites, below one in 77,000',
    where: 'tools/ci/run-tests.mjs and /research/ci.html',
  },
  {
    what: 'An occlusion as a field on the command, rather than on the run that produced it',
    verdict: 'adopted',
    evidence:
      'The model answers per frame whether the object is in it, the tracker acts on that three times, and the answer then reached nobody: what got into the log was an applyMask with an empty mask, which is the same shape as a selection erased down to nothing. A run is a thing that happened once in a session that ends and the question is asked of a document that was saved and reloaded, so the run was the wrong carrier. On the command it is 14 bytes on each of the 300 commands that carry it, 4.1 KB of a 64 MB ten-minute document, and it makes hasAnyCoverage exact for that case rather than approximate. The whole chapter is 0.60 KB gzipped on an application bundle whose size decided this project’s framework, and it adds no button',
    where: 'src/core/document/selection-command.ts, and "What the tracker knew and the log could not say"',
  },
  {
    what: 'A smaller end-to-end occlusion clip, by resolution or by quality, so the fixture stays tiny',
    verdict: 'rejected',
    evidence:
      'The occlusion scene draws a new background on every frame, so there is no temporal redundancy in it at all and the clip is twenty-eight independent pictures rather than two seconds of video: a megabyte at the quality the tracker needs, and fifteen times the other clip in that directory for less than half the frames. Ten encodes from 2.1 MB to 89 KB were run through the real tracker. Every one of them reported the object absent on all eight frames the bar covers and missed none, so the assertion is not delicate; what moved is whether the run ever found the object again. Two never did, at 240,185 and 158,298 bytes, and it is a band rather than a floor because the two coarser rows below it recover. Halving the resolution, at 99,574 bytes, does not recover either. The clip is committed at the size it was drawn at and four quality steps clear of the nearest failure, because a clip inside that band would be what the test measured',
    where: 'e2e/fixtures/README.md',
  },
  {
    what: 'Asserting the frame the object comes back on, which is the frame a reader would look at',
    verdict: 'rejected',
    evidence:
      'It is a five per cent sliver of a disc and the model’s own score sits within a tenth of a per cent of zero on it, which /research/the-host.html already says makes a run’s answer there a coin flip. Two things already in this repository land on opposite sides of it: the PyTorch reference is a frame late, which is its reacquisition_delay of 1, and the numpy host in host.py is not. Two more were found by running it. Encoding the same frames differently moves it, and so does the seed: the same clip seeded from the square inscribed in the disc rather than from its bounding box reports one more frame than the bounding box does. So the end-to-end test asserts the frames the bar covers and the frames the whole disc is in view on, and says nothing about the slivers at either end. An assertion on the flip would fail on somebody else’s GPU for a reason that is not a defect',
    where: 'e2e/editor.spec.ts',
  },
  {
    what: 'Falling back to the head’s predicted IoU when a mask decoder has no object score',
    verdict: 'rejected',
    evidence:
      'A silent wrong answer, and the only one of the two outputs the re-exported decoder exists for that had one: a missing object_pointer throws on the first frame because it is read like everything else, and a missing object_score_logits fell back to a different quantity compared against the same zero. A predicted IoU is essentially always positive, so such a graph would track perfectly and report the object present on every frame of every clip, including the ones it is behind something on. Asked of the session’s output names at load instead, and refused by the name of whichever is missing. What the first version of this entry got wrong is which file that was: asked of the published decoder at the pinned revision, in both precisions, it declares object_score_logits and no object_pointer, so serving it has always failed loudly rather than silently. The silent shape is one no release contains, which is the argument for checking names rather than recognising a file, and what the check buys for the mistake somebody actually makes is a sentence at load instead of an exception mid-gesture',
    where: 'src/platform/perception/edgetam-tracker.ts',
  },
  {
    what: 'A stop as an exception thrown out of a tracking run, which is what it was',
    verdict: 'rejected',
    evidence:
      'A stop keeps everything it found and is a button somebody pressed, so the only caller had to recognise the exception in order to say nothing about it. What made throwing defensible was that a stopped run had nothing to hand back; it has, which is how far it got and what it found, and that is what the interface owes anybody who pressed Stop. It is a field on the result instead and one catch arm shorter',
    where: 'src/core/perception/tracking-job.ts',
  },
  {
    what: 'An Inspect mode, off by default, showing what the perception layer knows',
    verdict: 'rejected',
    evidence:
      'It answers the wrong question by putting five unlike facts behind one switch. What a head scored and what a candidate covers are the same on every file anybody opens; where a tracked object went behind something is a numbered frame of THIS clip that somebody has to act on. The first belongs on /research/ and the second belongs where per-frame facts already are, which is a mark on a track that costs no button. A mode is also the one shape that cannot be judged: nobody turns it on, so nothing about it is ever wrong in front of anybody',
    where: '"What the tracker knew and the log could not say"',
  },
  {
    what: 'The model’s confidence in the interface, on the candidates or anywhere else',
    verdict: 'rejected',
    evidence:
      'Re-asked rather than assumed, and the answer written in docs/selection.md holds: confidence is not a quantity anyone can see, so it decides which of three silhouettes is drawn first and the candidates are offered smallest first, which is the axis a person chooses along. Two readings agreeing to within a tenth are shown as one for the same reason. A number beside a silhouette invites somebody to pick the higher one, which is the model’s own preference rendered as advice',
    where: 'src/core/perception/mask-candidates.ts',
  },
  {
    what: 'Drawing the candidates orderCandidates dropped, and what each one covers',
    verdict: 'rejected',
    evidence:
      'Two are dropped per click at most, one for covering less than 0.0005 of the frame, which is a head that produced nothing rather than a small object, and one for landing within 0.9 IoU of a better answer, which is the same answer twice. Both are the picker refusing to offer a choice that is not there. Area survives as the ORDER, which is the visible form of it: a candidate list already sorted by size says what the numbers would say and needs no digits',
    where: 'src/core/perception/mask-candidates.ts',
  },
  {
    what: 'PerceptionStore.promptPoints, a public getter with no consumer outside its own test',
    verdict: 'rejected',
    evidence:
      'Deleted rather than drawn. The prompt is the QUESTION and the candidates are the answer, and this product has argued since object selection landed that what it offers is the answer; the points also end on the next brush stroke, so nothing about them survives long enough to be in a document. One test read it, to check which of two overlapping clicks won, and reads what the engine was asked instead',
    where: 'src/core/perception/perception-store.ts',
  },
  {
    what: 'A cost display: frames dropped, the quality tier in use, and whether the preview is a downscale',
    verdict: 'rejected',
    evidence:
      'All three are known. Playback counts advanced and skipped over each twenty-frame window and uses them only to move the tier, and the tier is a public getter whose comment says the dev console reads it. They are facts about the tool rather than about the document: the same clip on a faster machine reports different numbers and is the same work. The one that is about the file, that a preview over 4096 px is a downscale of the export, is a property of its dimensions, which the row beside the file’s name already gives',
    where: 'src/core/render/rotyl-engine.ts',
  },
  {
    what: 'A style declaring named views, so its structure tensor and streamlines can be drawn as a flow field',
    verdict: 'rejected',
    evidence:
      'Re-argued against the entry above it rather than around it, and it loses on the same sentence: src/core/style/style.ts holds that nothing upstream knows what a cel band or a halftone dot is. A declared view is a weaker breach than handing out a working buffer and it is the same breach, because the names ARE what a style does. It also has no reader: an orientation field is a fact about the chain and identical on every photograph anybody opens, which is a figure on a research page rather than a thing to put over somebody’s work',
    where: 'src/core/style/style.ts',
  },
  {
    what: 'Drawing the occlusion on the canvas, where the user is actually looking',
    verdict: 'rejected',
    evidence:
      'The display pass carries two floats in a uniform buffer that is exactly full at 48 bytes, and it lifts and contours rather than drawing anything with an edge of its own. Saying "the object is behind something here" means a glyph, and src/core is compiled with no dom lib, so an atlas would have to be made in platform and handed in as a texture. The product has never written on the picture and has no dialogs; a sentence about a frame goes where sentences already are',
    where: 'src/core/render/display-renderer.ts',
  },
  {
    what: 'Drawing a tracked run’s occluded frames as a gap in the bar rather than as a faint one',
    verdict: 'rejected',
    evidence:
      'A gap is indistinguishable from the run not having reached those frames, which is the one thing it must not be confused with: a run that stopped and a run that got there and found nothing want opposite reactions from the user. Both facts have to survive at once, so the bar is continuous and the stretch is drawn at 0.28 opacity',
    where: 'src/app/Timeline.tsx',
  },
  {
    what: 'One tracked object per model answer the selection is made of, read back out of the command log',
    verdict: 'adopted',
    evidence:
      'The engine has taken a list of seeds since tracking landed and the interface passed one, so the missing half was never the loop: it was a way to say WHICH objects, in a product with one selection and no set of them. The log had been recording it since object selection landed. A fresh prompt writes its own applyMask and a refinement replaces one, so two clicks on two things leave two commands and two clicks on one leave one. Reading that back is one core function and 0.56 KB gzipped on the bundle, with no new gesture, no mode and no ninth button, and a selection with fewer than two answers in it comes back as the single seed it has always been. Driven end to end against the real model on the fixture clip where one disc goes behind a bar for eight frames and an identical one stands beside it: the first is reported absent on the frames the bar covers and the second on none, and the timeline draws no faint stretch at all, because a frame is empty only where every object is missing from it',
    where: 'src/core/perception/tracking-seeds.ts',
  },
  {
    what: 'A set of selections in the interface, so a run can be told which objects to follow',
    verdict: 'rejected',
    evidence:
      'It was the obvious answer to the one thing multi-object tracking was missing, which was never the loop: runTracking has taken a list of seeds since it landed, N tracks advance against one embedding so two objects are 226 ms a frame rather than 270, and the first writes replace while the rest add. What a set costs is a way to start one, a way to see which is active, a way to switch and a way to undo one separately, in a product whose interface is a canvas and eight buttons. None of it is needed. SelectIntent’s first value is `object`, documented as "a different thing; starts a fresh prompt", and a fresh prompt writes its own applyMask where shift-click and alt-click replace the last one. So the log has recorded which objects somebody pointed at since object selection landed, and reading it back is one core function, no new state and no ninth button',
    where: 'src/core/perception/tracking-seeds.ts',
  },
  {
    what: 'Splitting a selection into connected components, so two blobs are two objects',
    verdict: 'rejected',
    evidence:
      'The other way to get several objects out of one selection, and it cannot tell the two cases apart that matter: two cars are two components and one car behind a lamppost is also two, so it over-splits exactly where a seed is already hard. It also needs a threshold and a minimum area that nothing in the log justifies, where the answers a model gave are a partition somebody actually made. Kept in mind for the case the answers cannot express, which is two brushed blobs, and that case is in known limits rather than solved',
    where: 'src/core/perception/tracking-seeds.ts',
  },
  {
    what: 'A track of its own for coverage no model answer claims, rather than giving it to the first object',
    verdict: 'rejected',
    evidence:
      'It changes what Track does for people who never asked for several objects. A brushed region beside a clicked one would become a second object where today the whole selection is one seed, so a single-object run would silently start following two things and costing 226 ms a frame instead of 135. Given to the first object instead, a selection with no answers in it is one seed of the whole coverage, which is byte for byte every run this product had made',
    where: 'src/core/perception/tracking-seeds.ts',
  },
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
      'Nothing to fix. A ten-minute log folds to one command per object followed, because the fold cuts at the last command that decides a frame by itself and a run replaces for its first seed only, and the fold plus unpacking those masks is 0.3 ms following one object and 0.9 following three. A cache would be a second source of truth in the one structure this architecture exists to have exactly one of, in exchange for a third of a millisecond an object',
    where: 'tools/video-bench, measurements 12 and 15',
  },
  {
    what: 'Adding an objects dimension to the measurements the four per-object figures came from',
    verdict: 'rejected',
    evidence:
      'The same mistake this harness has already priced once. The four figures that turned out to be per object are quoted from three different results files, and taking the question inside any of them re-takes that measurement: asked inside measurement 12 the previous time, a ten-minute write and read that three documents quote moved from eleven and twelve to ten and ten, and measurement 8’s unpacking figure moved from 10.5 ms to 11.0, on code paths neither question touches. Topical fit is the argument FOR folding two measurements together, which is what makes it the wrong one. Measurement 15 has its own command and its own file, and takes its own one-object control rather than quoting theirs',
    where: 'tools/video-bench/objects.ts',
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
      'Measured before it was built, on a clip where five cars move against a city that does not. Half of the last frame improves the residue from 3.6 codes to 2.0, which is the number everybody quotes, and costs 55.1 codes of deviation in the band a car has just left, 48.5 on the car itself and 13% of the gradient energy inside it. On the clip with no moving grain, where the residue is already at the codec floor, it makes the residue worse and costs the same fifty-five codes. It also ends "a render is a function of its frame"',
    where: 'tools/style-bench, measurement 5',
  },
  {
    what: 'Averaging each frame against the one before it on the way INTO the chain',
    verdict: 'rejected',
    evidence:
      'One pass, no motion estimation on a fixed camera, and it takes the input down about a fifth and the styled output down with it. It also makes the amplification WORSE wherever it was above one: poster on a brick wall 1.36 to 1.54, on foliage 1.46 to 1.63, comic at full detail 1.75 to 2.15. What it removes is the part these chains attenuate hardest, so it reports less flicker rather than causing less',
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
    what: 'A floor under the comic flatten’s apparent scale, so raising detail cannot shrink it away',
    verdict: 'rejected',
    evidence:
      'The mechanism known limits named, and it is not one. Measured at four floors on a perturbation of six codes, it takes a brick wall from 29 codes out to 9 and takes a frame of film from 17 UP to 22 on the way: a wider ellipse spans more structure, so a sector that flips costs more codes. There is no radius that is right for both pictures, which is what the control is for',
    where: '"What raising detail was doing to a clip", the interventions',
  },
  {
    what: 'Holding the comic ink’s tau at its detail-0 value, so a flat region keeps a margin against the threshold',
    verdict: 'rejected',
    evidence:
      'The best number of anything tried short of removing the sector weighting: the wall goes from 29 codes out to 15 and the film from 17 to 9, on every picture and at every setting, none made worse. It also erases the contour around every window at detail 1, which is what the top of the control is for, and moves 5.8% of the reference scene. tau is not a side effect of detail, it is how detail inks',
    where: 'src/core/style/comic/comic-params.ts',
  },
  {
    what: 'Averaging the eight Kuwahara sectors rather than weighting them by variance',
    verdict: 'rejected',
    evidence:
      'It is the amplifier, and this is what removing it is worth: a brick wall goes from 29 codes out of 6 to 8 at detail 1 and from 7 to 1 at detail 0, and a frame of film from 17 to 5. It is also the style. An anisotropic Kuwahara that does not choose its sector is a blur, and the choosing is the difference between painterly and smooth',
    where: 'src/core/style/comic/wgsl/anisotropic-kuwahara.wgsl',
  },
  {
    what: 'Bounding the comic flatten’s buffer below the picture, so the downsample in front of it is always an average',
    verdict: 'adopted',
    evidence:
      'A buffer derived to hold a radius can ask for 1356 px of a 720 px frame, and clamping that at the frame turned this chain’s only grain rejection into a copy. Bounded a root two below it, a brick wall goes from 2.00 times its input to 1.75 on a clip and the film’s exterior from 2.28 to 1.82, the apparent scale moves by nothing, and the chain is three times cheaper at 720p. It costs 6.9% of the reference scene’s gradient energy at detail 1 and 1.0% at the default, and detail 0 is byte for byte the render it was. A factor of two buys five more codes on the wall and moves 1.2% of that scene at the BOTTOM of the control',
    where: 'src/core/style/comic/comic-params.ts',
  },
  {
    what: 'Closing the gap between the comic chain at full detail and the same chain at none',
    verdict: 'open',
    evidence:
      'What is left is the sector weighting itself, which is a steep power of a variance estimated from a few dozen samples and is the amplifier at every setting rather than only at the top: a brick wall reads 1.75 at detail 1 against 0.63 at detail 0, and 8 codes out of 6 with the weighting removed against 25 with it. Every way of not taking that decision measured so far is a blur',
    where: 'docs/limits.md',
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
      'Unpacking alone was 10.5 ms of a 33 ms frame across the three hundred masks a ten-second tracked run folds to, all but the last of them discarded by the next. Three hundred commands become one, and eighteen thousand become one. One per object once a run could follow several, since the cut lands on the seed that replaces and the rest add',
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
      'A qualitative level resolves to a quantizer, which asked for 23 Mbit/s where the same level as a bitrate asked for 6, at identical speed, and which is not repeatable to the tenth because constant quality prices the picture rather than the setting',
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
    what: 'Bundling the segmentation model into the initial application',
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
      'O(radius²) and 40 ms at 720p, which was 119 before its buffer was bounded below the picture; a separable bilateral iterated three times is O(radius) and 1.2',
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
    what: 'A colour path of its own for full-range video',
    verdict: 'rejected',
    evidence:
      'Nothing it could do. Where the hardware decoder gets the clip the flag is already applied and the full-range encode lands within a code of the limited-range one; where the software decoder gets it the flag is ignored and the picture is thirteen codes contrast-stretched, and nothing in the frame says which happened. VideoFrame.colorSpace reports fullRange false in both cases. A correction needs to know whether the decoder acted, and that is the one thing that cannot be read. It is in docs/limits.md instead',
    where: 'tools/video-bench, measurement 16',
  },
  {
    what: 'Getting a decoded frame onto the GPU through a 2D canvas rather than directly',
    verdict: 'rejected',
    evidence:
      'It is right on the probes and wrong on footage, and the eleven codes it avoids were never the browser\u2019s. The upload converts from the transfer the file DECLARES, which every probe here left unspecified and the browser defaults to bt709: the same patches encoded three ways come back 1 code from what was drawn when the file says sRGB and 11 out when it says BT.709, one picture and one encode with the declaration as the only variable. On a probe that says BT.709 and IS BT.709, against ffmpeg converting the same file, the upload is a median of 1 code over the grey ramp and 17 at worst in the shadows, where a 2D canvas applies nothing at all and is a median of 11. And it is not free: drawing the frame into a canvas and uploading that adds 1.2 ms a frame at 1080p over the direct copy, which is the 1.4 ms measurement 5 already rejects for the readback path. So it costs a millisecond a frame to be wrong on every clip that means what it says',
    where: 'tools/video-bench, measurement 17',
  },
  {
    what: 'Reading VideoFrame.format to tell which of the two decoders produced a frame',
    verdict: 'rejected',
    evidence:
      'It works here and it is not a signal. The same file comes back NV12 off the hardware decoder and I420 off the software one, which is the only readable difference between them measured anywhere in this harness and would be exactly what a correction for either of their two colour disagreements needs. It is a fact about this platform rather than anything the specification promises, and the field names a chroma layout rather than a decoder, so a colour decision taken on it is reading one thing in order to learn another and is silently wrong on the first machine whose software decoder hands back NV12',
    where: 'tools/video-bench, measurement 17',
  },
  {
    what: 'Asking the decoder for prefer-hardware, so the range flag is always applied',
    verdict: 'open',
    evidence:
      'It works, and it is the only thing measured that does: a 320x180 full-range clip told to prefer hardware lands 0 codes from its limited-range twin where the browser’s own choice puts it 13 out. What is not measured is what it costs elsewhere. hardwareAcceleration prefer-hardware can fail configuration outright on a machine with no hardware H.264 decode, which would turn a narrow colour error into no video at all, and no fallback has been built or timed',
    where: 'src/platform/video/frame-provider.ts',
  },
  {
    what: 'Deciding anything from VideoFrame.colorSpace',
    verdict: 'rejected',
    evidence:
      'It is a default rather than a reading. fullRange is false on a file whose own SPS flag is 1, and primaries and transfer are reported bt709 on a bitstream declaring 2, "unspecified", for both. One of its four fields, matrix_coefficients, is a value anybody wrote down. A branch taken on it is taken on a value the file contradicts, and there is nothing to gain by taking one: the conversion is driven by what the bitstream declares, and this object is not a reading of that. Measurement 17 is the same object being right for the wrong reason, reporting bt709 transfer on a clip whose transfer is bt709 because it reports bt709 on everything',
    where: 'tools/video-bench, measurement 16',
  },
  {
    what: 'Learned edge detection, and neural style transfer',
    verdict: 'open',
    evidence:
      'Roughly 700 KB and 7 MB respectively; neither has been run on the WebGPU execution provider, and neither is temporally measured',
    where: 'tools/style-bench, "What follows"',
  },
];
