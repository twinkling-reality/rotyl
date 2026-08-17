# Rotyl

Select part of an image and transform only that part. Everything else stays byte-identical.

Runs entirely on your machine. Nothing is uploaded.

## Running it

```bash
pnpm install
pnpm dev
```

Needs a browser with WebGPU (Chrome/Edge 113+, Safari 26+, recent Firefox).

```bash
pnpm verify   # typecheck, lint, format, unit tests, production build
pnpm e2e      # Playwright, real Chrome
```

## How it is put together

```
src/core/      the engine — no DOM, no framework
src/platform/  browser adapters: decode, texture upload, encode
src/app/       Preact UI
```

`core` never imports from `platform` or `app`. That is enforced by
`tsconfig.core.json`, which compiles `src/core` with `"lib": ["es2023"]` and no
`dom` — so a stray `window` or `HTMLElement` fails the build rather than being
caught in review. The payoff is concrete: every shader is unit-tested by running
it for real through Dawn in Node, with no browser and no mocks.

### The render path

```
source ──┬─────────────────────────────────────────────┐
         │                                             │
         └─► flatten (small buffer)                    │
               └─► ink (medium buffer)                 │
                     └─► cel + ink ──► styled ──┐      │
                                                ▼      ▼
                                     composite: mix(source, styled, mask)
                                                ▼
                                         ┌──────┴──────┐
                                    export file   display pass
                                                  (view + overlay)
```

Three things follow from this shape:

**Unselected pixels are untouched.** The composite is the only pass that reads
the mask, and `mix(source, styled, 0)` returns the source value exactly. Source
textures are sampled through an sRGB view and the composite writes through one,
so the hardware does the decode and encode and the byte round trip is exact.

**Export is not a second code path.** It is the same renderer with the same
parameters, stopping at the same pass. The selection overlay lives in the
display pass, which export never reaches, so a UI affordance cannot leak into a
saved file.

**Boundaries have no seam.** Every stage before the composite runs over the
whole image. Masking earlier would be cheaper but wrong: the flatten and ink
kernels sample well outside their own pixel, so pixels just inside the selection
would be computed from zeroed neighbours and draw a halo.

### Resolution is derived, not configured

The flatten (anisotropic Kuwahara) and ink (flow-based DoG) stages each have a
characteristic radius. Written the obvious way that radius is a pixel count
which must grow with resolution to keep the look constant — and cost then grows
with the _fourth_ power of resolution.

So it is inverted: each stage declares the apparent scale it wants as a fraction
of the image, and its buffer resolution is derived to hold the radius near a
constant. Cost becomes linear in pixels, and "more detail" buys resolution
rather than kernel width. Because every length is a fraction of the image and
never of the output buffer, preview and export compose identically — that is a
property of `comic-params.ts` alone, and it is tested there exactly.

### The selection is a command log

Strokes, not pixels, are the source of truth. Replaying the log rebuilds the
mask, which makes undo, redo, and export-at-a-different-resolution the same
operation, and means no edit ever costs a full-resolution snapshot. Stroke
coordinates and radii are in source pixels, so a brush edge exported at 6000 px
is the shape that was drawn rather than a magnified approximation.

`applyMask` is the one route by which a mask produced outside the brush can
reach the renderer. It exists, is exercised by tests, and is where a
segmentation engine would eventually connect — deliberately, and undoably.

## Measured

Apple M3 Pro, Chrome. Medians over repeated runs, GPU-fenced.

|                          | 2 MP   | 12 MP  | 24 MP  |
| ------------------------ | ------ | ------ | ------ |
| brush stroke (composite) | 1.0 ms | 2.0 ms | 3.1 ms |
| brush stamp into mask    | 1.0 ms | 0.9 ms | 1.1 ms |
| full style chain         | 88 ms  | 79 ms  | 119 ms |

The style chain only re-runs when a style control changes, never while brushing
— which is why the numbers that matter for feel are the first two rows. During a
slider drag the chain drops to a draft tier: 8.9 ms at default detail on a 12 MP
image, 27 ms at maximum detail.

Bundle: 84 KB of JavaScript (29 KB gzipped), plus 31 KB of subset fonts. One
runtime dependency.

## Type and fonts

Geist and Geist Mono, SIL OFL 1.1 (see `public/fonts/LICENSE.txt`). Subset to
latin and clamped to the weights actually used — 23.2 KB and 8.1 KB. Regenerate
from the `geist` npm package with:

```bash
fonttools varLib.instancer Geist[wght].ttf wght=300:500 -o _geist.ttf
pyftsubset _geist.ttf --output-file=public/fonts/geist-latin-300-500.woff2 \
  --flavor=woff2 --unicodes="U+0000-00FF,U+2000-206F,U+2122,U+2212" \
  --layout-features="kern,liga,tnum,case,frac,ss03" --no-hinting --desubroutinize
```

Icons are eight Lucide paths inlined into `src/app/icons.tsx` (ISC). A kilobyte
of geometry did not justify a dependency.

## Known limits

- Images only. The renderer takes a source texture rather than an image, which
  is the seam video would arrive through, but no video pipeline exists.
- Brush selection only. No segmentation model ships; `applyMask` is the seam.
- Preview is capped at 4096 px on the long edge to bound memory. Export always
  renders at full resolution, so for larger images the preview is a downscale of
  the export rather than identical to it.
- A lost GPU device asks for a reload. The command log makes real recovery
  cheap to add, but it is not implemented.
- Erasing away an entire selection without pressing Clear leaves the selection
  overlay on, because coverage is inferred from the command log rather than read
  back from the GPU.
- Export flattens transparency, matching the preview canvas, which is opaque.
- HEIC is rejected by signature with a specific message, in every browser.
- The unit suite runs shaders through Dawn's Node bindings, which do not survive
  running the full style chain more than once per process. The GPU tests are
  scoped accordingly; browsers have no such limit.
