# Rotyl's EdgeTAM release

The manifest in this directory is the contract between the exporter, the build,
the deployment and the browser. A build obtains every file from the project
release, verifies its byte length and SHA-256 digest, then emits it under the
manifest version. The browser repeats the same verification before a graph can
reach ONNX Runtime.

The project release is a build input, not a runtime origin. Runtime URLs are
always under `/models/edgetam/<version>/` on the origin that served the
application. The build emits explicit gzip files so their served size does not
depend on whether a static host recognises ONNX; the browser inflates and checks
the original bytes. The licence and notice stay uncompressed beside them.

`pnpm models` fills the local cache. `ROTYL_MODEL_SOURCE` may name a directory or
an HTTP origin while preparing a release, but it changes only where the build
obtains the bytes. It never changes their expected digests or where a deployed
application serves them.

`pnpm dev` and `pnpm build` run that preparation automatically. A clone with an
empty cache obtains the complete release; if it is offline, unauthenticated to a
private project release, or given one wrong byte, the command stops before a
server or deployment exists. `pnpm models:check` performs the same completeness
check without fetching anything.

There is no `VITE_TRACKING_HOST`. That setting protected an optional feature
while the project owned no tracking files, by refusing to guess where they might
be. Keeping it after ownership would preserve both a partial-product build and a
runtime authority outside the manifest. A source override is therefore confined
to preparation and cannot alter runtime URLs.

To replace the release:

1. Pin the checkpoint revisions in `tools/edgetam-export`.
2. Export and verify the tracking files by following that tool's README.
3. Put the published selection files and the exported tracking files in a clean
   directory with `LICENSE.txt` and `NOTICE.txt` from here.
4. Run `pnpm models:manifest -- /that/directory` to print the sizes and digests.
5. Give the manifest a new version and release URL, then run the model delivery
   measurement and both verification suites.
6. Run `pnpm build` and publish the contents of
   `dist/models/edgetam/<version>/` as the assets of the matching project
   release. Build once more from an empty local model cache before moving the
   manifest change to `main`.

An existing version is immutable. Replacing bytes under one version is refused
by the build and by every browser that fetches them.

## Measurement 18: what ownership costs

`node tools/model-assets/measure.mjs` builds the last committed application as
the first-load control, builds the working tree, and prices the release as
served bytes, decompressed cache bytes, invalidation, origin traffic and digest
time. It writes `tools/model-assets/results.json`, which generates
`/research/model-delivery.html`.
