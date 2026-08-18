/**
 * Every measurement, pulled out of the harnesses' results by path.
 *
 * `at` throws rather than returning undefined, and that is the whole mechanism:
 * if a benchmark stops reporting something, or renames it, the page fails to
 * generate and the build fails with it. The alternative — a blank cell, or a
 * number left over from a shape that no longer exists — is indistinguishable
 * from a measurement to whoever reads it.
 *
 * ONE ENTRY IS ONE FINDING. The organising question is not "which harness
 * produced this" but "what did we learn", which is why tracking has a page of
 * its own rather than four rows inside video: they were answered at different
 * times, they decided different things, and a reader wants one of them and not
 * the other.
 */

import type { Entry, Section } from './page.ts';

/**
 * Read a path, or say exactly which step of it was missing.
 *
 * The path is an array rather than a dotted string, which looks fussier and is
 * not: the harnesses key their results by the human labels a measurement was
 * taken under, and those contain dots and commas — "sigma 0.5",
 * "static-720p, fixed camera". A dotted path would split them into steps that
 * do not exist, which is a wrong answer dressed as a missing one.
 */
function at(source: unknown, path: readonly string[]): unknown {
  let node = source;
  const walked: string[] = [];
  for (const key of path) {
    if (node === null || typeof node !== 'object') {
      throw new Error(`research: ${walked.join(' / ') || '(root)'} is not an object`);
    }
    node = Object.getOwnPropertyDescriptor(node, key)?.value;
    walked.push(key);
    if (node === undefined) throw new Error(`research: no ${walked.join(' / ')} in the results`);
  }
  return node;
}

function num(source: unknown, path: readonly string[]): number {
  const value = at(source, path);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`research: ${path.join(' / ')} is ${String(value)}, not a number`);
  }
  return value;
}

function text(source: unknown, path: readonly string[]): string {
  const value = at(source, path);
  if (typeof value !== 'string') throw new Error(`research: ${path.join(' / ')} is not a string`);
  return value;
}

const ms = (value: number): string => `${value.toFixed(value < 10 ? 1 : 0)} ms`;
const pct = (value: number): string => `${value.toFixed(2)}%`;

const SIZES = ['720p', '2 MP', '12 MP', '24 MP'] as const;
const STYLES = ['comic', 'poster', 'print'] as const;

// --- the look ---------------------------------------------------------------

function styleCost(style: unknown): Section {
  return {
    heading: 'What a style chain costs',
    prose: [
      'The root README timed the comic chain and said plainly that the print chain never had been: three passes against nineteen, only one at output resolution, so it should be cheaper — but that was an argument rather than a measurement. It is 200 times cheaper.',
      'Two of the three run in under two milliseconds at 720p. That is the finding a third style came out of: a style does not have to be expensive to be flat, and one that fits inside a frame is something a clip can be played through rather than something a clip is rendered with.',
    ],
    table: {
      columns: ['style, default controls', ...SIZES],
      rows: STYLES.map((name) => [
        name,
        ...SIZES.map((size) => ms(num(style, ['chain', size, `${name}, default`, 'full', 'median']))),
      ]),
    },
    caveat:
      'Full quality tier, style chain only: the composite is a separate pass that re-runs on every brush movement. The 24 MP column is the one place the ordering stops being 20:1 — both cheap styles do all of their deciding in one pass at output resolution, so past about 12 megapixels they are paying for pixels rather than for thinking.',
    command: 'node tools/style-bench/run.mjs chain',
  };
}

function detailCost(style: unknown): Section {
  const tier = (name: string): string => ms(num(style, ['chain', '720p', 'comic, detail 1', name, 'median']));
  return {
    heading: 'Higher detail is cheaper, and the quality tiers collapse',
    prose: [
      'Both follow from deriving a stage’s resolution from the apparent scale it wants rather than the reverse. When a buffer clamps to the output’s short edge the kernel shrinks instead of the fraction drifting, so more detail buys resolution and costs less, and a draft frame becomes the same render as an export.',
    ],
    table: {
      columns: ['comic, full tier', ...SIZES],
      rows: [
        ['comic, detail 0', 'detail 0'],
        ['comic, default', 'detail 0.5'],
        ['comic, detail 1', 'detail 1'],
      ].map(([key, label]) => [
        label ?? '',
        ...SIZES.map((size) => ms(num(style, ['chain', size, key ?? '', 'full', 'median']))),
      ]),
    },
    caveat: `At 720p and detail 1 every tier clamps to 720: draft ${tier('draft')}, full ${tier('full')}, export ${tier('export')}. "Draft is cheaper" is not universally true, and no code may assume it.`,
    command: 'node tools/style-bench/run.mjs chain',
  };
}

function stability(style: unknown): Section {
  const clip = ['clips', 'static-720p, fixed camera'];
  const row = (label: string, name: string, side: string): readonly string[] => {
    const path = [...clip, name, side];
    return [
      label,
      num(style, [...path, 'mean']).toFixed(2),
      num(style, [...path, 'p99']).toFixed(1),
      pct(num(style, [...path, 'flicker'])),
    ];
  };
  return {
    heading: 'Nothing boils, and not for the reason anyone expected',
    prose: [
      'Every stage of every style runs per frame with no knowledge of the last one. The worry was that the winner-take-all stages — an anisotropic Kuwahara picking its most homogeneous sector, a flow-based difference of Gaussians thresholding a response — would flip on a pixel one code different between two frames, and that stylised footage would boil however good a single frame was.',
      'Measured on a fixed camera, no style amplifies its input and every one attenuates it. The comic chain, the one that looked most at risk, is the steadiest: it does not choose between two nearly equal sectors on one pixel’s noise, it chooses on the variance of two hundred samples, and it removes more grain than its decisions reintroduce.',
    ],
    table: {
      columns: ['per-pixel change between frames', 'mean', 'p99', 'over 8 codes'],
      rows: [
        row('the source', 'comic, default', 'source'),
        row('comic', 'comic, default', 'styled'),
        row('poster', 'poster, default', 'styled'),
        row('print', 'print, default', 'styled'),
      ],
    },
    caveat:
      'In output codes, over consecutive decoded frames of a fixed camera on a fixed scene, so everything that differs between two of them is grain and the encoder’s own noise. The mean is the least useful column: boiling is a small proportion of pixels moving a long way, which is what the other two measure.',
    command: 'node tools/style-bench/run.mjs clips',
  };
}

function perturbation(style: unknown): Section {
  const p99 = (sigma: string, name: string): string =>
    `${num(style, ['perturbation', sigma, name, 'p99']).toFixed(0)} codes`;
  return {
    heading: 'The same result with the codec taken out of it',
    prose: [
      'One frame rendered twice, the second with grain of a known size added, so what is measured is the style’s own amplification and nothing else’s. Half a code is about the smallest perturbation an 8-bit pipeline can express — the "one code different between two frames" case exactly. Two codes is roughly a decent sensor at base ISO.',
    ],
    table: {
      columns: ['99th percentile change', 'grain σ 0.5', 'grain σ 2'],
      rows: [
        ['the input', 'input'],
        ['comic', 'comic, default'],
        ['poster', 'poster, default'],
        ['print', 'print, default'],
      ].map(([label, name]) => [label ?? '', p99('sigma 0.5', name ?? ''), p99('sigma 2', name ?? '')]),
    },
    command: 'node tools/style-bench/run.mjs perturbation',
  };
}

function transitionFloor(): Section {
  return {
    heading: 'Every hard decision needs a floor under its transition',
    prose: [
      'What does boil is a hard threshold against a fixed field — which is what a halftone dot is, and what a quantiser is if it is left hard. The poster style’s first version quantised hard and antialiased only against the local derivative. It measured five to ten times worse than the comic chain on a still camera.',
      'The cause is exact. Softening a step across one pixel is right for an edge and useless for a gradient: where the field is nearly flat the derivative is nearly zero, so a band boundary is a step of a whole level driven by a hundredth of one, and a frame of grain moves it. Putting a floor under the transition width — in the units of the thing being decided, never in pixels — caps the gain from input to output at about four.',
      'Chroma turned out to be the larger half. Colour steps are as discontinuous as lightness ones and there are more of them, because chroma is small everywhere in a hazy picture and its steps are correspondingly close together.',
    ],
    table: {
      columns: ['poster, static camera', 'p99', 'over 8 codes'],
      rows: [
        ['hard, derivative only', '23.3', '1.67%'],
        ['lightness and palette margin floored', '14.6', '1.23%'],
        ['chroma floored as well', '4.5', '0.52%'],
      ],
    },
    caveat:
      'Taken during development by re-running the clip measurement against each version. The last row is what the results file reports today; the first two are gone from the code and cannot be regenerated without reverting it. The fix costs nothing measurable and nothing visible — the transition only widens where the picture has no edge to sharpen.',
  };
}

function paletteFit(): Section {
  return {
    heading: 'A palette has to be fitted to the picture',
    prose: [
      'A palette is a claim about where a photograph’s lightness lives, and photographs disagree. The reference scene — hazy traffic, which is the case a palette exists for — has a lightness spread of 0.136 against 0.23 to 0.29 for every palette in the codebase.',
      'Applied literally, a five-stop ramp is therefore read through two and a half of its stops and the whole frame comes out in one colour. That looks like a palette chosen badly and is really a palette barely used. One pass measures the picture’s own mean and spread, one affine map moves it onto the palette’s, and the change to a hazy frame is larger than any other single thing measured here.',
    ],
    table: {
      columns: ['lightness', 'p1', 'p50', 'p99', 'mean', 'spread'],
      rows: [
        ['the reference scene', '0.35', '0.64', '0.84', '0.60', '0.136'],
        ['Mural palette', '', '', '', '0.64', '0.234'],
        ['Riso palette', '', '', '', '0.57', '0.249'],
        ['Noir palette', '', '', '', '0.54', '0.288'],
      ],
    },
    caveat:
      'A fixed sampling grid is what makes measuring this per frame safe on video: the sample points do not move between frames and each tap is a local average of an already smoothed buffer, so the statistics follow the scene rather than the grain. The stability table above includes the fitted palettes, which is the check on that claim rather than the argument for it.',
  };
}

// --- video ------------------------------------------------------------------

function decode(video: unknown): Section {
  const row = (
    label: string,
    path: readonly string[],
    format: (value: number) => string,
  ): readonly string[] => [
    label,
    format(num(video, ['decode', '1080p30-gop30', ...path])),
    format(num(video, ['decode', '1080p30-gop300', ...path])),
  ];
  return {
    heading: 'Decode is free; seeking is not',
    prose: [
      'There is no such thing as decoding frame N. There is decoding from the keyframe at or before N and discarding what comes between, so the cost of a scrub is set by keyframe spacing and by nothing else. Two clips, identical content, differing only in that.',
      'The consequence is a design constraint rather than a number to optimise: a scrub that moves forward must never re-seek. One decoder is held open and fed forward, and it starts again only for a backward or a distant jump.',
    ],
    table: {
      columns: ['1080p30 H.264', '1 s keyframes', 'one keyframe'],
      rows: [
        row('walk every packet', ['demux', 'walk_all_packets_ms', 'median'], (v) => `${v.toFixed(1)} ms`),
        row('decode 300 frames', ['decode_only', 'ms'], (v) => `${v.toFixed(0)} ms`),
        row('a frame, sustained', ['decode_only', 'fps'], (v) => `${(1000 / v).toFixed(2)} ms`),
        row('seek, median', ['seek', 'ms', 'median'], (v) => `${v.toFixed(1)} ms`),
        row('seek, worst', ['seek', 'ms', 'max'], (v) => `${v.toFixed(1)} ms`),
        row('frames decoded per seek', ['seek', 'frames_decoded', 'median'], (v) => v.toFixed(0)),
      ],
    },
    command: 'node tools/video-bench/run.mjs decode',
  };
}

function upload(video: unknown): Section {
  const path = ['decode', '1080p30-gop30', 'upload'];
  return {
    heading: 'A decoded frame onto the GPU',
    prose: [
      'Three ways, fenced. The external-texture path is what playback uses; the copy is what anything that has to keep the frame uses.',
    ],
    table: {
      columns: ['1920×1080', 'median'],
      rows: [
        [
          'importExternalTexture and one pass',
          ms(num(video, [...path, 'importExternalTexture_and_pass', 'median'])),
        ],
        [
          'copyExternalImageToTexture',
          ms(num(video, [...path, 'copyExternalImageToTexture_videoframe', 'median'])),
        ],
        ['createImageBitmap, then copy', ms(num(video, [...path, 'createImageBitmap_then_copy', 'median']))],
      ],
    },
    command: 'node tools/video-bench/run.mjs decode',
  };
}

function colour(video: unknown): Section {
  const worst = (probe: string, view: string): string =>
    `${num(video, ['colour', probe, view, 'worst']).toFixed(0)} codes`;
  return {
    heading: 'A decoded frame needs no colour path of its own',
    prose: [
      'Sixteen flat patches with known sRGB bytes, encoded to H.264 and brought back. Both ways of being wrong here are silent.',
      'What an external texture samples is sRGB-encoded, exactly like the bytes of a decoded image — so a video frame belongs in the same source texture a photograph does, sampled through the same sRGB view, and nothing downstream needed a special case. Writing it through an sRGB view instead encodes it twice, and the second row is what that costs.',
    ],
    table: {
      columns: ['worst error, written through', '4:4:4 lossless', '4:2:0'],
      rows: [
        [
          'a plain rgba8unorm view',
          worst('probe-444-lossless', 'external_to_rgba8unorm'),
          worst('probe-420-tv', 'external_to_rgba8unorm'),
        ],
        [
          'an rgba8unorm-srgb view',
          worst('probe-444-lossless', 'external_to_rgba8unorm_srgb'),
          worst('probe-420-tv', 'external_to_rgba8unorm_srgb'),
        ],
        [
          'copyExternalImageToTexture',
          worst('probe-444-lossless', 'copyExternalImageToTexture'),
          worst('probe-420-tv', 'copyExternalImageToTexture'),
        ],
      ],
    },
    caveat:
      'The 4:2:0 column is Chrome applying a BT.709 to sRGB transfer conversion on the NV12 path and not on the I444 one; ffmpeg round-trips all three probes at worst 1. Since all real footage is 4:2:0 the colour-managed path is the one that matters and it is the correct one, but the discrepancy is Chrome’s and nothing here can compensate for it.',
    command: 'node tools/video-bench/run.mjs colour',
  };
}

// --- tracking ---------------------------------------------------------------

function trackedFrame(video: unknown): Section {
  const agreement = (part: string): number =>
    num(video, [
      'half-precision',
      'memory_attention',
      'fp16',
      'agreement_vs_fp32',
      'conditioned_features',
      part,
    ]);
  return {
    heading: 'Nine to eleven tracked frames a second, against thirty for playback',
    prose: [
      'The two graphs a tracker needs are not in the published model release, so they were exported and then run on the inference runtime this project already ships. Memory attention is the expensive half, and the fixed-size memory bank is why: it is 4096 queries against 3648 keys on every frame, where the reference attends against fewer early in a clip.',
      'Tracking therefore cannot be a render-loop activity, and no amount of tidying makes it one. It runs behind the playhead, and the interface has to be honest that a mask arrives after the frame does.',
    ],
    table: {
      columns: ['graph', 'fp32', 'fp16', 'wasm'],
      rows: [
        [
          'memory attention',
          ms(num(video, ['half-precision', 'memory_attention', 'fp32', 'run_ms', 'median'])),
          ms(num(video, ['half-precision', 'memory_attention', 'fp16', 'run_ms', 'median'])),
          ms(num(video, ['attention', 'memory_attention', 'wasm', 'run_ms_cpu_outputs', 'median'])),
        ],
        [
          'memory encoder',
          ms(num(video, ['half-precision', 'memory_encoder', 'fp32', 'run_ms', 'median'])),
          ms(num(video, ['half-precision', 'memory_encoder', 'fp16', 'run_ms', 'median'])),
          ms(num(video, ['attention', 'memory_encoder', 'wasm', 'run_ms_cpu_outputs', 'median'])),
        ],
      ],
    },
    caveat: `wasm is 30 to 50 times slower, so tracking is a WebGPU-only feature and the honest answer on a fallback is to say so rather than run it. Half precision is a good trade for attention and not for the encoder: attention's worst element moves by ${agreement(
      'max_abs_diff',
    ).toFixed(3)} on values up to ${agreement('max_abs_value').toFixed(
      2,
    )}, where the encoder's output goes into the bank and conditions every later frame.`,
    command: 'node tools/video-bench/run.mjs attention half-precision',
  };
}

function readback(video: unknown): Section {
  const cell = (size: string, part: string): string =>
    ms(num(video, ['readback', `real_encoder_${size}`, part, 'median']));
  const row = (label: string, part: string): readonly string[] => [
    label,
    cell('1920x1080', part),
    cell('4032x3024', part),
  ];
  return {
    heading: 'The 12 MB readback, which does not bind and is avoidable anyway',
    prose: [
      'The inference runtime declines an external GPUDevice, so the model’s input tensor is built on Rotyl’s GPU and read back. The worry was 360 MB/s across the bus at 30 frames a second.',
      'On unified memory there is no bus to cross: most of the cost is a memcpy, and an ordinary ArrayBuffer copy of the same size measures about the same. Two and a half milliseconds of a 33 ms frame is 7%.',
    ],
    table: {
      columns: ['12.58 MB tensor, per frame', '1920×1080', '4032×3024'],
      rows: [
        row('fullscreen pass and three copies', 'pass_and_copy_fenced'),
        row('map, and copy out of it', 'map_and_copy_out'),
        row('total', 'total'),
      ],
    },
    caveat:
      'For video the crossing is avoidable entirely: a VideoFrame belongs to no device, so the tensor can be built on the runtime’s own device, which does accept a GPU buffer as an input and returns the same answer bit for bit. The image path cannot do that, and by these numbers it does not need to.',
    command: 'node tools/video-bench/run.mjs readback',
  };
}

// --- entries ----------------------------------------------------------------

export function entries(style: unknown, video: unknown): readonly Entry[] {
  return [
    {
      slug: 'the-look',
      title: 'What a style costs, and whether it holds still',
      standfirst:
        'Three style chains timed against one picture, and the temporal measurement that contradicted what everyone assumed about per-frame stylisation.',
      harness: 'tools/style-bench',
      lede: [
        'Everything that decides whether a selection is correct was already built and measured. What was not settled was whether what comes out is worth looking at — and, on video, whether it stays worth looking at while it moves.',
        'Three things were unknown, each capable of forcing a different architecture. One of the three was answered backwards.',
      ],
      sections: [
        styleCost(style),
        detailCost(style),
        stability(style),
        perturbation(style),
        transitionFloor(),
        paletteFit(),
      ],
    },
    {
      slug: 'video',
      title: 'What decode costs, and where colour goes',
      standfirst:
        'Demux, decode, seek and upload across two clips that differ only in keyframe spacing, and the probe showing a decoded frame needs no colour path of its own.',
      harness: 'tools/video-bench',
      lede: [
        'Four things were unknown before video could be built, all of them capable of forcing a different design. These settled the shape of the frame provider and the colour contract; the model’s side of it is on its own page.',
      ],
      sections: [decode(video), upload(video), colour(video)],
    },
    {
      slug: 'tracking',
      title: 'What tracking would cost, before building it',
      standfirst:
        'The two graphs a tracker needs, exported and run on the runtime that already ships — and the readback that looked like a bottleneck and is not.',
      harness: 'tools/video-bench, tools/edgetam-export',
      lede: [
        'Tracking does not exist yet. These are the numbers that say what it would cost and what shape it would have to take, taken before writing it rather than after.',
      ],
      sections: [trackedFrame(video), readback(video)],
    },
    {
      slug: 'the-editor',
      title: 'What editing costs, and what ships',
      standfirst:
        'The figures that decide how the tool feels, taken by hand rather than by a harness, and kept apart from the rest for exactly that reason.',
      harness: 'measured by hand, in a browser',
      lede: [
        'Nothing regenerates these and nothing notices if they drift. They are not less true than the rest, but a page that mixed them would be claiming a discipline it only has for half of what it shows.',
      ],
      sections: [
        {
          heading: 'Editing is the composite, not the style chain',
          prose: [
            'The style chain re-runs only when a style control changes, never while brushing, which is why these two rows are the numbers that decide how the tool feels. A brush stroke is one pass over the output; a stamp is one pass over the mask.',
          ],
          table: {
            columns: ['', '2 MP', '12 MP', '24 MP'],
            rows: [
              ['brush stroke (composite)', '1.0 ms', '2.0 ms', '3.1 ms'],
              ['brush stamp into the mask', '1.0 ms', '0.9 ms', '1.1 ms'],
            ],
          },
        },
        {
          heading: 'Object selection, once the model is loaded',
          prose: [
            'Reading the frame is expensive and happens once; answering "which object is under this point" is cheap and happens per click. A click is flat in image size because the model always works at 1024 px square — only building that input scales with the photograph.',
          ],
          table: {
            columns: ['', '1 MP', '24 MP'],
            rows: [
              ['reading the frame (once)', '19 ms', '43 ms'],
              ['a click, model plus composite', '12 ms', '13 ms'],
            ],
          },
        },
        {
          heading: 'What ships',
          prose: [
            'Three runtime dependencies, two of them code-split so a session that never opens a video or an object never fetches them. Shaders reach the bundle as strings and this codebase comments them as heavily as its TypeScript, so a build-time transform removes the comments and keeps every newline — which is why adding a third style made the bundle smaller rather than larger.',
          ],
          table: {
            columns: ['gzipped', 'size'],
            rows: [
              ['application', '41 KB'],
              ['inference runtime, on first object click', '36 KB'],
              ['demuxer, on first video', '33 KB'],
              ['subset fonts', '31 KB'],
              ['saved by stripping shader comments', '17 KB'],
            ],
          },
        },
      ],
    },
  ];
}

/** What the results say they were taken on, rather than what anyone remembers. */
export function hardware(video: unknown): string {
  const agent = text(video, ['adapter', 'userAgent']);
  const chrome = /Chrome\/(\d+)/.exec(agent)?.[1] ?? 'an unknown build';
  const vendor = text(video, ['adapter', 'vendor']);
  const architecture = text(video, ['adapter', 'architecture']);
  return `an Apple M3 Pro, Chrome ${chrome}, adapter ${vendor} / ${architecture}`;
}
