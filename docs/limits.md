[Rotyl](../README.md) / Known limits

# Known limits

Nothing here is a bug report. Each of these is a decision, or the honest edge of
one, and the measurement behind it is on `/research.html`.

- **Tracking has an engine and no weights.** The loop that follows a selection
  forward through a clip is built, DOM-free and tested; the two ONNX graphs it
  needs are not in the published EdgeTAM release and are not hosted anywhere, so
  nothing in the product can start a run. `tools/edgetam-export` produces them
  in one command and lists the three checkpoint parameters and the position
  encoding a host has to supply alongside. Until they are hosted, a selection
  held across a moving subject still drifts off it and has to be corrected by
  selecting again further along.
- A tracked run holds one mask per frame in the command log, at 64 KB each: 20 MB
  for ten seconds and 1.2 GB for ten minutes. Folding them is free, measured at
  0.2 ms for eighteen thousand commands, so the log is the right place for them.
  The masks are not compressed, and coverage is nearly binary, so a run-length
  encoding by row would take each one to about 4 KB. That is the fix when clips
  get longer than the clip export already fails on.
- What is known about building tracking is measured.
  `tools/video-bench` puts memory attention at 60 ms a frame on WebGPU and 38 at
  half precision, which with the encoder and the decoder makes a tracked frame
  around 90 ms, so tracking runs behind the playhead rather than in the render
  loop. The graphs it needs are produced by `tools/edgetam-export`, which also
  demonstrates them holding a mask across ten frames, mask-for-mask identical to
  the PyTorch tracker.
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
- **The poster style's outline boils on detailed footage, and this one does want
  fixing.** It is drawn where the quantised colour here differs from the
  quantised colour a line's width away, and a quantised colour flips a whole
  band on an infinitesimal change, so an outline can appear at full strength
  between one frame and the next. On a photograph of a brick wall the chain
  amplifies its input five times where the drawn reference scene reports it
  attenuating by two; without the outline it is 0.95. Three shapes of fix were
  measured and rejected, which is on the trials page: the quantity being
  thresholded is discrete, so no transition width resolves it, and the answer is
  a different outline operator rather than a tuning pass. Until then a clip of
  fine detail through the poster style will flicker along its lines.
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
