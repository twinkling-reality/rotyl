[Rotyl](../README.md) / Deployment

# Deployment

Rotyl's production contract lives in `.openai/hosting.json` and
`worker/index.ts`. The application remains a static Vite build. The worker is
its explicit Cloudflare entry point. The Sites build stages deployable files
under an internal asset-binding path so public requests reach the worker. The
worker maps each public path to its file and applies the cache, content type and
security policy to the response. Internal HTML files use transport-neutral
names so the host cannot redirect a binding fetch before that policy is set.

```bash
pnpm site:build
pnpm site:check
```

The first command produces the client and worker output Sites deploys. The
second verifies the complete model release again in that final layout, refuses
a duplicate or publicly matching copy, and checks that the built worker makes
versioned model and code paths immutable. HTML is explicitly revalidated, so
an application release can move immediately while an existing model version
cannot change.

The project release in `models/edgetam/manifest.json` is only a build input. A
deployed browser never reaches through to it: all runtime requests stay on the
Sites origin. Replacing model bytes requires a new manifest version and a new
project model release. An application release that uses the same bytes leaves
the model version alone.

Every production deployment is a saved Sites version built from the exact
source commit. GitHub's Verify job runs both the portable build and the Sites
layout check before that commit can enter `main`. Its ordinary unit assertions
run in Node and its WGSL assertions run in installed Chrome; the hosted-runner
measurement behind that split is generated at `/research/hosted-ci.html`.
