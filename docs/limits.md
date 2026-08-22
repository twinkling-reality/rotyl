[Rotyl](../README.md) / Known limits

# Known limits

Nothing here is a bug report. Each of these is a decision, or the honest edge of
one, and the measurement behind it is on `/research.html`.

- **Tracking depends on derivative graphs this project has to maintain.**
  `memory_attention_shared_fp16.onnx`, `memory_encoder.onnx`, the tracked mask
  decoder and `parameters.json` are in no published EdgeTAM ONNX release.
  `tools/edgetam-export` produces them, and Rotyl's versioned model release now
  puts their exact digests, Apache-2.0 licence and modified-file notice into
  every deployment. That closes the missing feature, not the maintenance cost:
  moving to another checkpoint means re-exporting, re-verifying and publishing
  the complete release rather than changing a runtime URL.
- **The fixture clips had to be rebuilt before they could price the host's
  mistakes end to end.** `host.py` puts every piece of the host's arithmetic
  against the reference's own tensors and is unambiguous either way; running the
  whole tracker with and without each mistake needs a clip carrying a moment
  where the mistake can cost something, which the ten-frame clips this project
  started with did not. Length alone does not supply one either: a memory bank
  kept from the frame the user pointed at is insurance against the recent frames
  being wrong, and a control that merely converged and stayed close moved it by
  nothing at all over twenty-two frames of divergence. Rebuilt, all four
  separate every correction in the right order. What is still missing is a clip
  on which any of these makes the tracker take the wrong object at all: they
  differ in where a mask sits on the hardest single frame, not in what they
  followed.
- **The seed a run starts from is the command log's coverage, not the model's
  own logits, and that is the one deliberate difference from the reference.**
  Given the reference's mask, this tracker reproduces the PyTorch tracker
  exactly, frame for frame, on all four clips. Given the same selection through
  the log, it agrees to between 0.91 and 0.99, because the coverage ramp puts
  its own decision boundary at a logit of one rather than at zero and the seed
  arrives very slightly eroded. It is kept, because a seed genuinely is a
  coverage mask by the time a run starts, the user may have brushed it, and
  measured against the fixtures' ground truth the eroded seed is a shade better
  rather than worse.
- **An object the model says is not in a frame gets an empty mask on that
  frame**, which is the reference's behaviour and means a tracked clip shows no
  selection at all while the subject is behind something. That is still what
  happens and it is no longer silent: the command carries the model's own
  verdict, so the timeline draws those frames as a faint stretch inside the run
  rather than as more of it, and a run that finished says on how many frames the
  object was behind something. What it cannot do is put a selection there.
  Nothing in the product invents a mask for a frame the model was asked about
  and answered, and the alternative, holding the last one forward across the
  gap, is the drift tracking exists to remove.
- **Coming back from an occlusion is a marginal decision, and re-encoding the
  same footage can put it on the wrong side.** The end-to-end fixture is a clip
  in which a disc is behind a bar for eight known frames, and it was encoded ten
  ways, from 2.1 MB down to 89 KB, and tracked through each. Every one of them
  reported the object absent on all eight and missed none, so the verdict itself
  is not delicate. Whether the run ever finds the object again afterwards is a
  different question with a different answer: two of the ten never do, and stay
  absent through to the end of the clip. It is a band rather than a quality
  floor, because the two coarser encodes below it recover, and no mechanism for
  it has been established here. What it means for somebody with real footage is
  that a clip this tracker is marginal about is a clip whose re-encode it may
  follow differently. `e2e/fixtures/README.md` has the ladder.
- **The timeline cannot say WHICH of several objects went behind something, and
  the line beside it can only count them.** The first track's command replaces
  and the rest add, so an empty mask from the first blanks the frame and an
  empty mask from any other is a no-op. The timeline answers a frame the way the
  fold does, which is right: a stretch is faint only where every object is
  missing from it. A run hands back one absence count per object, so the report
  can say two of three went behind something and on how many frames each, and
  neither it nor the track can say which two. A track is six hundred pixels
  wide, and naming them would need names, which is the thing this feature
  deliberately does not have.
- **Two brushed blobs are one object, and there is no way to say otherwise.** A
  run follows one object per answer the model gave to a prompt somebody started,
  because that is what the log records; a brush stroke and a dragged rectangle
  are regions somebody drew, and nothing anywhere says whether two of them are
  two things. They go to the first object, which is what already happened when
  there was only ever one seed. Two things that have to be followed separately
  therefore have to be clicked separately, with the Object or Box tool, which is
  the gesture that says "a different thing" in the first place.
- **How many objects the button promises comes from the log, so it can be one
  more than the run follows.** It counts the answers in the fold, which is the
  same source and the same known inexactness as the coverage question below: a
  click whose whole region was later erased away still counts, because answering
  exactly would mean reading the mask back on the render path. The run sees the
  coverage and drops such an object. Whenever it says anything at all it says
  how many it followed, so the correction is there in every case but one: a run
  left with a single object that it found on every frame says nothing, which is
  the rule everywhere else here, and that is the case where the difference goes
  unmentioned.
- **Tracking fetches a mask decoder of its own, which is thirty megabytes rather
  than nineteen.** The published decoder does not expose `object_pointer`, the
  token that carries an object's identity between frames, so a tracker built on
  it came back from an occlusion late and with no mask at all on the frames it
  was late by. `tools/edgetam-export` re-exports that decoder with the pointer
  on it, at half precision, which is 11 MB on top of the 19 the two memory
  graphs cost. Everything the published pair does for a click is unchanged: the
  re-export is only ever used for a tracked frame. Which decoder a host actually
  served is asked of the graph at load and refused by name if it is the wrong
  one. This page used to say the published decoder is also missing the model's
  own account of whether the object is in a frame. It is not: asked of the file
  at the pinned revision, in both precisions, it declares `object_score_logits`
  and no `object_pointer`, so serving it has always failed loudly on the first
  tracked frame. The silent failure the check also closes, a graph carrying the
  pointer and no object score falling back to the best head's predicted IoU and
  reporting the object present on every frame of every clip, is a shape no
  release has. What the check buys for the mistake somebody would actually make
  is a sentence before a run starts rather than an exception part way through
  one.
- **A tracked run holds one mask per frame PER OBJECT in the command log**, so
  every figure in this entry is per object, and none of them said so for as long
  as there could only be one. Held plainly a mask is 64 KB, 20 MB for ten
  seconds and 1.2 GB for ten minutes; packed, which is how they are held, it is
  3.4 KB and 62 MB for ten minutes. Two objects is twice that and three is three
  times it, taken on the file rather than multiplied out of that one: ten
  minutes following one thing is a 65 MB document and following three is 196.
  Folding the log is still free, at 0.3 ms for one object's eighteen thousand
  commands and 0.7 for three objects' fifty-four thousand, and the fold is still
  what keeps a replay cheap. What changed there is the shape rather than the
  number: the cut lands at the last command that decides the frame by itself,
  which a run writes for its FIRST object and not for the rest, so a replay
  unpacks one mask per object rather than all of them. What is left is a clip
  long enough that 62 MB an object matters, which is about ten times longer than
  anything measured here and no longer bounded by the export, since an export
  given a file to write into holds nothing.
- A tracked frame is 135 ms and playback's is thirty-three, so tracking is a job
  rather than something the playhead drives. Seven tracked frames a second means
  a three-hundred-frame run is three quarters of a minute, which the interface
  is honest about and can be stopped part way through. The figure this was
  designed around was 90, summed from the four graphs a frame runs; the
  difference is not a graph but the arithmetic between them, which is 18 ms of
  JavaScript a frame over five passes of a million elements each.
- **A small full-range clip is decoded as though it were limited range, and
  nothing here can tell.** Most footage is limited range, where black is luma 16
  and white is 235. A clip that declares itself full range puts them at 0 and
  255, and this browser's hardware H.264 decoder acts on that declaration while
  its software decoder ignores it. Which one a clip gets is decided by frame
  size, so the same picture comes back exact at 1280x720 and thirteen codes
  contrast-stretched at 320x180, over the whole frame. The flag is readable out
  of the bitstream; whether the decoder acted on it is not, and
  `VideoFrame.colorSpace` reports the clip as limited range in both cases, so
  there is no signal to correct from. It is narrow, because full range on H.264
  is mostly screen recordings and synthetic output and it has to be small as
  well, and it is not invisible: thirteen codes is a contrast error somebody
  would see and would have no way to explain.
- **A decoded frame's transfer is converted by the browser, and the two decoders
  disagree about that as well.** A frame is converted from the transfer its
  bitstream declares into the sRGB everything downstream expects, which is right
  and is why a video needs no colour path of its own here. Two things about it
  are not exact, and both were hidden for five chapters behind probes that
  declare no transfer at all. On the hardware decoder the curve applied behaves
  like a pure power where BT.709's has a linear toe, so a clip that declares
  BT.709 and means it comes back within a code of ffmpeg from mid grey up and up
  to seventeen codes crushed in the shadows. On the software decoder, which the
  same frame-size rule picks, nothing is converted at all, so the same clip comes
  back as its stored codes, up to sixteen codes dark across the whole picture.
  The only other path a page has is a 2D canvas, which converts nothing at any
  size and costs 1.2 ms a frame at 1080p to be the second of those everywhere,
  so it is not here. And the eleven codes that [video](video.md) and the decode
  page attributed to the browser for five chapters were the probe rather than the
  browser: an unspecified transfer defaults to BT.709, and every probe this
  project has encoded holds sRGB values.
- **A clip is re-encoded, so outside the selection it is the source pixels
  written again rather than the source bytes.** The composite is still exact
  there, and H.264 is not: measured against the source, a region nobody selected
  comes back three to five codes away on grainy footage. A still export has no
  such step and remains byte-exact. Nothing here can fix that short of a
  lossless codec, which is a file nobody wants.
- **A clip export needs somewhere to put the bytes, and only two browsers can
  give it one.** Chrome and Edge have `showSaveFilePicker`, so a clip asks where
  it goes before it encodes anything and then writes each packet into that file
  as the encoder makes it: measured at 25 minutes of 1080p, the heap grows by
  half a megabyte per thousand frames, which is noise, so the length of the clip
  is not a variable and there is no ceiling to quote. Safari and Firefox have
  no way to let somebody give a page a file, so there the whole file is built in
  the tab. The origin private file system is a writable file in both of them and
  is not an answer: it is storage with a quota rather than a disk, measured here
  refusing a write just past a gigabyte where it reports three, and a file
  staged in it still has to be copied out to the downloads folder afterwards.
- **A soundtrack costs a long export nothing.** Measured over twenty-five
  minutes of 1080p written into a file, with a soundtrack and without: 4.99 ms a
  frame against 5.00, and eight megabytes more peak heap on a two gigabyte file,
  which is the second track's sample table in the index at the front rather than
  anything accumulating. So a clip with sound has the same ceiling as one
  without, which on that path is no ceiling at all.
- **Where it is built in the tab it stops at a budget, and hands over what it
  wrote.** Four times the file has to fit at the moment it is finished, so the
  budget is the browser's own heap limit over four, which is 1048 MB and about
  twelve and a half minutes of 1080p on the machine every number here was taken
  on. Past that the export ends where it got to and says so, which is the same
  thing pressing Stop does. Left to run without a budget it manages twenty
  minutes and fails at twenty-five, at finalize, three and a half minutes in.
- **And that budget is not a guarantee.** How much a tab can hold depends on
  what else the machine is doing, and the blob a download is handed can be
  created and then refuse to be read: in a clean tab this browser gives a byte
  back out of 1.5 GB, and with the buffer the file was assembled in still alive
  beside it, which is what a finished export holds, it refuses at 790 MB. So the
  download path asks for one byte before handing the blob over, and what it says
  when that fails is a sentence rather than a file that never arrives.
- **A stopped export keeps what it wrote**, which is a clip of the part that was
  rendered rather than nothing at all. A stop before the first frame keeps
  nothing, because there is nothing to keep. A page can neither delete a file it
  was handed nor stop a writable stream committing when it closes, so that case,
  and an export that fails part way, both leave a file with a header in it and
  no index where somebody asked for a video. All the product can do about that
  is say so, and it does.
- **Crash recovery keeps one session, and starting to edit a different file
  supersedes it.** The journal is one file rather than one per media, because
  one per media needs a policy for pruning them and a directory that grows
  without one. The drop zone names the file it is waiting for, so opening
  something else is an informed choice, and it is still a choice that discards
  the other session's work.
- **Only one tab journals.** A sync access handle is exclusive, so a second tab
  on the same browser has no crash recovery, and says nothing about it because
  nothing in the interface ever claimed to have it. Both tabs still save, which
  is the way work leaves this browser at all.
- **A recovered session still needs the media supplied again**, for the same
  reason a saved document does: a browser has no paths. A file handle persisted
  in IndexedDB would let a recovery reopen the file itself, and it needs
  `showOpenFilePicker`, which is Chrome and Edge only, so opening a file would
  start to differ by browser where today it does not. It is in the trials ledger
  as open rather than rejected.
- **A tab killed mid-append loses the record it was writing.** The journal is
  read forward and stops where the bytes stop, so everything in front of the
  fragment is kept and the fragment is not. What that costs is at most one
  command, and what it buys is that a half-written journal is a session rather
  than a refusal.
- **A saved selection references its media and cannot address it.** A browser
  has no paths, so a document names the file it was made on and somebody
  supplies that file again. What it can check is the shape, which the loader
  read anyway, and a digest of the first megabyte, the last megabyte and the
  length. A file of a different shape is refused, because frame 1043 may not
  exist and a stroke may be off the image. A file of the same shape and
  different bytes opens with a sentence beside its name, because it replays
  perfectly and may be a re-encode of the same clip. What neither can see is a
  file that agrees at both ends and in length and differs in the middle, which
  on media is a re-encode with the same container layout and the same byte
  count. Digesting the whole file is the answer to that and is not available
  here: `crypto.subtle.digest` takes a buffer and the platform has no streaming
  form of it, so two gigabytes of clip would have to be resident to be hashed.
- **A document dropped onto a session with unsaved edits is refused rather than
  taken.** Loading a selection replaces the one that is open and cannot be made
  undoable cheaply, because the fold is sorted by frame rather than by the order
  edits were made, so the commands underneath cannot be left in place behind a
  clear. The line says to save what is open or close the file first, both of
  which are one click, and the cost is that going back to a saved selection
  while holding unsaved work is three steps rather than one.
- **A document does not contain the media, so it is not a way to move work
  between machines by itself.** The other half has to travel with it. Embedding
  it would make one feature a four megabyte file on a photograph and a two
  gigabyte one on a clip, and writing the second means holding it, which is the
  ceiling the streaming clip export exists to have removed.
- **A document carries the style and its controls, and opening one adopts
  them.** That is the opposite of what closing a file does, on purpose: closing
  is the absence of information and opening a document is the presence of it.
  The cost is real and is stated rather than hidden. Opening somebody else's
  document changes the palette this tool is set to.
- **A saved selection is refused if it came from a newer build**, by version,
  before anything in it is parsed, which is the rule HEIC and Matroska follow on
  the way in. There is one version, so there is no reader table yet, and adding
  one is where the second version goes.
- Exporting the frame on screen is never asked where to go, and takes the
  downloads folder in every browser. It is a couple of megabytes with no ceiling
  in sight, so a dialog in front of it would buy nothing and cost an interaction
  this product has always had.
- Exporting a clip writes H.264 in MP4 and nothing else, and re-encodes the
  picture while copying the sound. HEVC and AV1 encode in some browsers and have
  been measured in none here, and the codec list is one array waiting for
  somebody with the numbers.
- **A clip's sound is copied across rather than re-encoded, and two packets of
  it can go missing.** The audio is written as the packets it arrived as, so
  what comes out is bit-identical to what went in, which is the one thing about
  a clip export that is exact. What that costs is the two edges. An AAC track
  begins with a priming packet at a negative timestamp, whose samples a decoder
  throws away, and MP4 has no way to say "before zero" except an edit list this
  muxer only writes for positive offsets, so it is dropped. And a range's in
  point lands inside a packet rather than between two, so the packet holding it
  is dropped as well. Each is at most 21 ms at 48 kHz, which is less than a
  frame at 30, and everything kept is at exactly the moment it was at in the
  source. The alternative is re-encoding the first packet, which is exact and
  is also the only thing that would stop the sound being the source's own bytes.
- **A soundtrack an MP4 cannot carry is dropped, and said before the work rather
  than after it.** QuickTime holds mu-law and MP4 does not, so a `.mov` off an
  older camera is an ordinary file whose sound has nowhere to go. Which codecs
  survive is decided from the track and the format alone while the file is
  merely open, so it is in the row beside the file's name and in the export
  button's own sentence, minutes before the encoding rather than after it. There
  is no second container to offer instead: writing QuickTime costs eleven bytes
  and has been measured on nothing.
- Playback has no sound. What an export carries and what the editor plays are
  separate questions, and a preview that played audio would need a clock the
  render loop deliberately does not have: playback drops frames rather than
  running slow, and sound cannot.
- **An export range is a range on the export and not a trim of the document.**
  In and Out mark which frames a clip export writes; every command in the log
  keeps its own absolute frame number, so a selection made before the range
  starts still applies to it and the timeline still means what it meant. What
  that does not give you is a trim: there is no way to cut the middle out of a
  clip, or to write two ranges into one file, and both would be reasonable
  things to want.
- Clear and Invert act from the frame being shown onward, like every other
  command. There is no way to say "this frame only" or "the whole clip", and
  both would be reasonable things to want.
- Playback has no loop, and drops frames rather than running slow
  when the style chain cannot keep up. Which it only does for the comic style:
  the other two are around a millisecond a frame at 720p.
- The print style twinkles on video. 3% of pixels move more than 8 codes
  between consecutive frames of a fixed camera, against 0.1% for comic. A dot
  appears or disappears when the density crosses the spot function, and that is
  a hard threshold against a screen that does not move with the picture. It may
  not want fixing; a print is allowed to look like a print.
- **The residue that is left is the input, and it is not going to be filtered
  out.** Every stage runs per frame, so a chain is a pure function of its frame
  and invents nothing: on a clip with no moving grain every chain answers the
  codec floor. Two answers to the remaining flicker were measured before either
  was built, and neither is here. Averaging frames on the way in takes the input
  down a fifth and the output with it, and makes the amplification worse
  wherever it was above one, because what it removes is the part these chains
  attenuate hardest. Blending the previous stylised frame in improves the number
  everybody quotes by two fifths and costs fifty-five codes of deviation around
  anything that moves, thirteen per cent of the detail inside it, and this
  product's promise that a render is a function of its frame. What is left is in
  one stage of one chain, which is the entry below and the one after it.
- **The comic chain still amplifies a brick wall at full detail, by three
  quarters, and it used to be by two.** At detail 0 it attenuates by 0.63 and at
  detail 1 it amplifies by 1.75, on the same photograph; the drawn scene reports
  0.56 and says nothing about it, for the third time. What is left is the
  anisotropic Kuwahara's own sector weighting, which is the amplifier at every
  setting rather than only at the top: average the eight sectors instead of
  choosing between them and the same wall goes from 25 codes out of six to 8 at
  detail 1 and from 7 to 1 at detail 0, and a frame of film from 17 to 5. That
  is not available. A Kuwahara that does not choose its sector is a blur, and
  the choosing is the difference between painterly and smooth. Somebody who
  wants the steadiest comic frame should still turn detail down, which is a
  smaller sentence than it was.
- **The reason written here for that was the wrong one, which took an
  intervention to find out.** This page said the Kuwahara radius shrinks with
  detail until the flatten stops flattening. Measured by holding each of the
  three things detail moves and taking the number again, a floor under that
  radius takes a brick wall from 29 codes out of six to 9 and takes a frame of
  film from 17 UP to 22 on the way, because a wider ellipse spans more structure
  and a sector that flips then costs more codes. There is no radius that is
  right for both pictures. What was actually happening is that the flatten's
  buffer resolution is derived to hold its radius, at detail 1 that derivation
  asks for 1356 pixels of a 720 pixel frame, and clamping the request at the
  frame turned the box downsample in front of the Kuwahara into a copy. The
  downsample is this chain's only grain rejection. It is bounded a root two
  below the picture now, which restores it at every setting, moves the apparent
  scale by nothing, and makes the chain three times cheaper at 720p. What it
  costs is detail, which is what the control is named after: 6.9% of the
  reference scene's gradient energy at detail 1 and 1.0% at the default, against
  a quarter off the amplification on the wall and a half off it on the film.
  Detail 0 is byte for byte the render it was.
- **One of the two film shots was never the chain at all.** Both amplify as
  clips, including at detail 0 where the flatten is at its widest, and a clip of
  a film has actors in it. Rendered as stills, one frame twice with grain of a
  known size added the second time, the exterior amplifies 1.33 where its clip
  says 1.39 and the interior attenuates 0.50 where its clip says 1.11. So the
  exterior's figure is the chain and the interior's is the actors, and one page
  had been reading them as one thing.
- **The poster style's outline is steady on detailed footage now, and it is
  still not as steady as no outline at all.** It used to be drawn where the
  quantised colour here differed from the quantised colour a line's width away,
  and a quantised colour flips a whole band on an infinitesimal change, so a
  stroke could appear at full weight between one frame and the next: on a
  photograph of a brick wall that chain amplified its input 5.7 times where the
  drawn reference scene reports it attenuating by two. It compares the flattened
  colour instead now, unrounded, and a stroke's weight is that distance ramped
  up to the threshold, which takes the same clip to 1.36 against 0.95 for the
  same chain with the outline switched off. The gap that is left is not the
  quantiser. The flatten's own edge contrast moves under grain, and an outline
  whose weight follows contrast follows that too, so a perturbation of six codes
  comes out at fifteen where switching the outline off gives eight. Widening the
  ramp closes it in proportion and greys every line on the way, which is a worse
  picture in exchange for a number nobody watching a clip would find.
- WebM and Matroska are refused, by signature, with a message that says so.
  They are a second demuxer at 15 KB and mostly carry codecs whose decode has
  not been measured here.
- The print screen's pitch is a fraction of the image, not a distance in pixels,
  because that is what makes the preview and the export the same picture. At
  100% zoom on a very large photograph the dots are correspondingly large.
- Object selection needs the network once, to fetch the code-split runtime and
  the model. On half-precision hardware its model files are 18.57 MB served and
  20.59 MB in Cache Storage. The image never leaves the machine; the checked
  model arrives from the same Rotyl deployment. Tracking adds 22.24 MB served
  and 29.78 MB cached. A cold session using both therefore transfers 40.81 MB
  of model data. The full-precision selection alternative costs more and is
  carried for hardware that cannot compile half precision; the complete table
  is on `/research/model-delivery.html`.
- Object selection only ever adds. Alt-click is a negative point, a statement
  about the object, answered by the model, not a subtraction from the mask, so
  removing a region that is already selected is still the eraser's job.
- Object selection runs on the inference runtime's own WebGPU device, not
  Rotyl's: it declines to accept an external one, and asked again against
  1.27.0 it still does. The execution provider's `device` option fails session
  creation whether or not the device is built with the features the runtime
  asks for. The consequence is that the model's input crosses back through
  system memory, 12 MB per image, which is 2.4 ms and not the bottleneck it
  looked like. Its 17 MB of embeddings do not cross, which is the number that
  would have mattered. For video the crossing is avoidable entirely: a
  VideoFrame belongs to no device, so the tensor can be built on the runtime's
  own device, which does take a GPU buffer as an input and returns the same
  answer bit for bit.
- The mask decoder is silently wrong on that runtime's older JSEP backend,
  no error, an all-zero confidence, and a mask of the wrong object, so the
  build is pinned. See `edgetam-engine.ts`.
- Preview is capped at 4096 px on the long edge to bound memory. Export always
  renders at full resolution, so for larger images the preview is a downscale of
  the export rather than identical to it.
- A lost GPU device is rebuilt around, but object selection pays for it: the
  inference runtime's own device goes with ours, so the model is loaded again on
  the next click. Its weights are in Cache Storage, so nothing is re-downloaded.
- Erasing away an entire selection without pressing Clear leaves the selection
  overlay on, because coverage is inferred from the command log rather than read
  back from the GPU.
- Export flattens transparency, matching the preview canvas, which is opaque.
- HEIC is rejected by signature with a specific message, in every browser.
- The unit suite runs shaders through Dawn's Node bindings, which do not survive
  running the full style chain more than once per process, and can abort while
  native objects are being torn down. The GPU tests are scoped accordingly,
  each such file renders once and asserts many times, and browsers have no such
  limit. Across 32 unchanged suites, 29 processes exited cleanly, one exited
  after all 284 assertions passed, and two stopped with one shader file still
  pending. The gate therefore reads Vitest's assertion report: a complete
  passing report passes regardless of native teardown, a failed assertion never
  retries, and only an incomplete file gets another Dawn process within the
  measured bound. The evidence and residual estimate are on `/research/ci.html`.
  The cost is steep enough to shape what is worth testing here: a single
  `RotylEngine.render` in a file that already builds several engines took one
  file from none in twelve to ten in twelve, measured back to back. What that
  test covered is covered in Playwright instead, where a browser has no limit.
- **The end-to-end suite covers the object tool's interaction but not the
  model**, because downloading the release in every browser loop would make the
  suite depend on network traffic rather than the deployment under test. That
  path is verified by hand in a browser. Tracking is no longer guarded by a
  build option: the suite always asserts that Track exists, and its three real
  model cases use the same verified, same-origin release every build contains.
  Playwright remains a separate real-Chrome command rather than part of the CI
  unit gate, because it is evidence about the browser and GPU it actually ran
  on.
