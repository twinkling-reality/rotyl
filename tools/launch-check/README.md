# launch-check

Measures the production boundary after a public deployment. It reads the exact
Sites output already produced by `pnpm site:build`, fetches the canonical origin
without browser credentials, and writes only public response metadata and
derived sizes to `results.json`.

```bash
node tools/launch-check/measure.mjs
```

The check refuses redirects, missing security headers, mutable hashed assets,
mutable model assets, a changed model digest, exposed source maps, exposed
deployment metadata, and a canonical URL that is not HTTPS. It does not write
tokens, DNS records, account identifiers, or private Sites metadata.

The generated research page reads `results.json` after the public launch. A
new application deployment should retake this measurement without changing its
grouping; a model release should also retake the independent model-delivery
measurement.
