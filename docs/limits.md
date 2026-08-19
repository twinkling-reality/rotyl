[Rotyl](../README.md) / Known limits

# Known limits

Nothing here is a bug report. Each of these is a decision, or the honest edge of
one, and the measurement behind it is on `/research.html`.

- **Tracking needs somewhere to fetch two graphs from, and there is no default.**
  `memory_attention_shared_fp16.onnx`, `memory_encoder.onnx` and
  `parameters.json` are in no published EdgeTAM release. `tools/edgetam-export`
  produces all three in two commands, and a build points at wherever they were
  put with `VITE_TRACKING_HOST`. Without one there is no Track button, which is
  a deliberate absence rather than a disabled control: a wrong or missing host
  is nineteen megabytes fetched and then a 404, at the moment somebody asked for
  the feature. Until a build has one, a selection held across a moving subject
  still drifts off it and has to be corrected by selecting again further along.
- **The clips a tracker is verified against are too easy to separate its
  mistakes.** `host.py` puts every piece of the host's arithmetic against the
  reference's own tensors and is unambiguous, and running the whole thing end to
  end on the four fixture clips is not: every configuration, including three
  known-wrong ones, lands between 0.91 and 0.99 against the reference, and the
  ordering is not consistent between clips. Ten to sixteen frames of one large
  object on a clean background is not a clip where a tracker has to decide
  anything, and an anchored memory bank and a sliding one do not even differ
  until the eighth tracked frame. What is missing is a longer fixture, and that
  is what the end-to-end table on `/research/the-host.html` says rather than a
  claim it cannot support.
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
  selection at all while the subject is behind something.
- **A tracker has no object pointers, so it comes back from an occlusion one
  frame late.** The published mask decoder does not expose `object_pointer`, the
  token that carries an object's identity between frames, so the bank's pointer
  block stays masked. Measured on a fixture with a three-frame occlusion, the
  cost is exactly one frame: no mask at all on the frame the object reappears,
  picked up on the next. Every average hides it, which is why it is a field in
  the results rather than something to notice. Re-exporting the decoder buys it
  back and is the reason to.
- A tracked run holds one mask per frame in the command log. Held plainly that
  is 64 KB each, 20 MB for ten seconds and 1.2 GB for ten minutes; packed, which
  is how they are held, it is 3.4 KB each and 62 MB for ten minutes. Folding
  them is free, measured at 0.2 ms for eighteen thousand commands, and the fold
  cuts at the last command that decides the frame by itself, so a replay unpacks
  one mask rather than all of them. What is left is a clip long enough that
  62 MB matters, which is longer than the clip export already fails on.
- A tracked frame is 135 ms and playback's is thirty-three, so tracking is a job
  rather than something the playhead drives. Seven tracked frames a second means
  a three-hundred-frame run is three quarters of a minute, which the interface
  is honest about and can be stopped part way through. The figure this was
  designed around was 90, summed from the four graphs a frame runs; the
  difference is not a graph but the arithmetic between them, which is 18 ms of
  JavaScript a frame over five passes of a million elements each.
- **A clip is re-encoded, so outside the selection it is the source pixels
  written again rather than the source bytes.** The composite is still exact
  there, and H.264 is not: measured against the source, a region nobody selected
  comes back three to five codes away on grainy footage. A still export has no
  such step and remains byte-exact. Nothing here can fix that short of a
  lossless codec, which is a file nobody wants.
- A clip is written into memory before it is saved, because that is what puts
  the index at the front of the file. A ten-second 1080p export is about 12 MB;
  a ten-minute one would be closer to a gigabyte, and this has no answer for
  that beyond failing. Streaming it to disk needs a file handle the user grants,
  which is a different feature.
- Exporting a clip writes H.264 in MP4 and nothing else. HEVC and AV1 encode in
  some browsers and have been measured in none here, and the codec list is one
  array waiting for somebody with the numbers.
- Audio is not written. There is no audio anywhere in the product yet, and a
  clip that silently dropped a soundtrack it had been given would be worse than
  one that never had it.
- Clear and Invert act from the frame being shown onward, like every other
  command. There is no way to say "this frame only" or "the whole clip", and
  both would be reasonable things to want.
- Playback has no audio and no loop, and drops frames rather than running slow
  when the style chain cannot keep up. Which it only does for the comic style:
  the other two are around a millisecond a frame at 720p.
- The print style twinkles on video. 3% of pixels move more than 8 codes
  between consecutive frames of a fixed camera, against 0.1% for comic. A dot
  appears or disappears when the density crosses the spot function, and that is
  a hard threshold against a screen that does not move with the picture. It may
  not want fixing; a print is allowed to look like a print.
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
- Object selection needs the network once, to fetch the model, and around 36 MB
  of it. The image never leaves the machine; the model has to arrive on it.
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
  running the full style chain more than once per process, and abort
  intermittently when GPU work is spread across separate cases in one file. The
  GPU tests are scoped accordingly, each such file renders once and asserts
  many times, and browsers have no such limit. Between one run in eight and one
  in four still aborts under load, with and without those tests; the abort
  arrives after every assertion has passed, so it reads as an unexplained crash
  rather than a failure. Run it again before concluding anything from one.
  The cost is steep enough to shape what is worth testing here: a single
  `RotylEngine.render` in a file that already builds several engines took one
  file from none in twelve to ten in twelve, measured back to back. What that
  test covered is covered in Playwright instead, where a browser has no limit.
- The end-to-end suite covers the object tool's interaction but not the model:
  36 MB over the network is the wrong thing to put in a loop that has to be
  reliable. The model path is verified by hand in a browser.
