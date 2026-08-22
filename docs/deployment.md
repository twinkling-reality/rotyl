[Rotyl](../README.md) / Deployment

# Deployment

The canonical application is <https://rotyl.glendonchin.com/>. The hostname is
attached directly to the Sites project. It is not a redirect: the canonical
hostname remains in the address bar, terminates with the platform-managed
certificate, and reaches the same worker and same-origin assets as the Sites
address.

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

## Release boundary

An application release is the commit that passed the required Verify job, the
saved Sites version built from that commit, and the tag placed on that same
commit. The `v0.1.0` application release continues to use the independently
versioned `edgetam-v1` model release. An application tag never renames or
replaces model assets.

The custom domain points at the Sites project, not at one saved version. A new
production deployment is therefore atomic for both the Sites address and the
canonical address. HTML revalidates while hashed application assets and
versioned model assets remain immutable.

## Rollback

1. Select the most recent known-good saved Sites version whose source commit
   passed the required Verify job.
2. Deploy that saved version directly. Do not rebuild it and do not move a tag.
3. Leave the custom-domain and DNS records in place. They point at the project,
   so the restored version reaches both production hostnames together.
4. From a signed-out browser, verify the canonical hostname, reload, object
   selection, Track, model integrity, and the cache and security headers.
5. Record the incident and the restored version on the launch measurement page
   before preparing a corrected release.

If a suspect release must be removed before a known-good version is ready,
make the Sites project private, restore and verify the saved version as the
owner, then return the project to public access. An outage is preferable to
serving a build whose integrity is in doubt.
