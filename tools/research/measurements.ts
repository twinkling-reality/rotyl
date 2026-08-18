/**
 * Every measurement, pulled out of the harnesses' results by path.
 *
 * `at` throws rather than returning undefined, and that is the whole mechanism:
 * if a benchmark stops reporting something, or renames it, the page fails to
 * generate and the build fails with it. The alternative — a blank cell, or a
 * number left over from a shape that no longer exists — is indistinguishable
 * from a measurement to whoever reads it.
 *
 * Adding a measurement is a function and an entry. Nothing else in the page
 * knows what a Kuwahara or a keyframe is.
 */

import type { Group, Measurement } from './page.ts';

/**
 * Read a path, or say exactly which step of it was missing.
 *
 * The path is an array rather than a dotted string, which looks fussier and is
 * not: the harnesses key their results by the human labels a measurement was
 * taken under, and those contain dots and commas - "sigma 0.5",
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

function styleCost(style: unknown): Measurement {
  const rows = STYLES.map((name) => [
    name,
    ...SIZES.map((size) => ms(num(style, ['chain', size, `${name}, default`, 'full', 'median']))),
  ]);
  return {
    title: 'What a style chain costs',
    finding:
      'Two of the three run in under two milliseconds at 720p, which is what makes a style something a clip can be played through rather than something a clip is rendered with. The third spends essentially all of its time in one stage.',
    table: { columns: ['style, default controls', ...SIZES], rows },
    caveat:
      'Full quality tier, style chain only: the composite is a separate pass that re-runs on every brush movement. The scene is dense with architectural edges and the anisotropic Kuwahara samples more of them the more oriented the neighbourhood is, so the comic figures are a hard case rather than a typical one.',
    command: 'node tools/style-bench/run.mjs chain',
  };
}

function detailCost(style: unknown): Measurement {
  const rows = ['detail 0', 'detail 0.5', 'detail 1'].map((label, index) => {
    const name = ['comic, detail 0', 'comic, default', 'comic, detail 1'][index] ?? '';
    return [label, ...SIZES.map((size) => ms(num(style, ['chain', size, name, 'full', 'median'])))];
  });
  return {
    title: 'Higher detail is cheaper, and the quality tiers collapse',
    finding:
      'Both are consequences of deriving a stage’s resolution from the apparent scale it wants: when a buffer clamps to the output’s short edge the kernel shrinks instead, so more detail costs less and a draft frame becomes the same render as an export.',
    table: { columns: ['comic', ...SIZES], rows },
    caveat: `At 720p and detail 1 every tier clamps to 720: ${(['draft', 'full', 'export'] as const)
      .map((tier) => `${tier} ${ms(num(style, ['chain', '720p', 'comic, detail 1', tier, 'median']))}`)
      .join(', ')}. "Draft is cheaper" is not universally true and no code may assume it.`,
    command: 'node tools/style-bench/run.mjs chain',
  };
}

function stability(style: unknown): Measurement {
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
    title: 'Temporal stability, on a camera that is not moving',
    finding:
      'No style amplifies its input and every one attenuates it, which is the opposite of what was expected: a winner-take-all filter does not decide on one pixel’s noise, it decides on the variance of two hundred samples. What does move is a hard threshold against a fixed field, which is what a halftone dot is.',
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
      'In output codes, over consecutive decoded frames of a fixed camera on a fixed scene, so everything that differs between two of them is grain and the encoder’s own noise. The mean is the least useful column: boiling is a small proportion of pixels moving a long way.',
    command: 'node tools/style-bench/run.mjs clips',
  };
}

function perturbation(style: unknown): Measurement {
  const p99 = (sigma: string, name: string): string =>
    `${num(style, ['perturbation', sigma, name, 'p99']).toFixed(0)} codes`;
  const rows = [
    ['the input', 'input'],
    ['comic', 'comic, default'],
    ['poster', 'poster, default'],
    ['print', 'print, default'],
  ].map(([label, name]) => [label ?? '', p99('sigma 0.5', name ?? ''), p99('sigma 2', name ?? '')]);
  return {
    title: 'The same result with the codec taken out of it',
    finding:
      'One frame rendered twice, the second with grain of a known size added, so the amplification is the style’s own and nothing else’s. Half a code is about the smallest perturbation an 8-bit pipeline can express; two codes is roughly a decent sensor at base ISO.',
    table: {
      columns: ['99th percentile change', 'grain σ 0.5', 'grain σ 2'],
      rows,
    },
    command: 'node tools/style-bench/run.mjs perturbation',
  };
}

function quantisationFloor(): Measurement {
  return {
    title: 'What a floor under a soft transition is worth',
    finding:
      'Softening a hard decision across one pixel is right for an edge and useless for a gradient: where the field is nearly flat the derivative is nearly zero, so a band boundary becomes a step of a whole level driven by a hundredth of one, and a frame of grain moves it. The floor is expressed in the units of the thing being decided, never in pixels.',
    table: {
      columns: ['poster, static camera', 'p99', 'over 8 codes'],
      rows: [
        ['hard, antialiased against fwidth only', '23.3', '1.67%'],
        ['lightness and palette margin floored', '14.6', '1.23%'],
        ['chroma floored as well', '4.5', '0.52%'],
      ],
    },
    caveat:
      'Taken during development, by re-running the clip measurement against each version. The last row is the one the results file reports today; the first two are gone from the code and cannot be regenerated without reverting it.',
  };
}

function decode(video: unknown): Measurement {
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
    title: 'Decode is free; seeking is not',
    finding:
      'There is no such thing as decoding frame N. There is decoding from the keyframe at or before N and discarding what comes between, so the cost of a scrub is set by keyframe spacing and by nothing else. Two clips, identical content, differing only in that.',
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
    caveat:
      'The consequence is a design constraint rather than a number to optimise: a scrub that moves forward must never re-seek. One decoder is held open and fed forward, and it starts again only for a backward or distant jump.',
    command: 'node tools/video-bench/run.mjs decode',
  };
}

function upload(video: unknown): Measurement {
  const path = ['decode', '1080p30-gop30', 'upload'];
  return {
    title: 'A decoded frame onto the GPU',
    finding:
      'Three ways, fenced. The external-texture path is what playback uses; the copy is what everything that has to persist the frame uses.',
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

function colour(video: unknown): Measurement {
  const worst = (probe: string, view: string): string =>
    `${num(video, ['colour', probe, view, 'worst']).toFixed(0)} codes`;
  return {
    title: 'A decoded frame needs no colour path of its own',
    finding:
      'Sixteen flat patches with known sRGB bytes, encoded to H.264 and brought back. What an external texture samples is sRGB-encoded, exactly like the bytes of a decoded image, so a video frame belongs in the same source texture a photograph does and everything downstream is untouched.',
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
      'The second row is the cost of encoding twice, and it is the kind of mistake that is obvious in a measurement and invisible in a review. The 4:2:0 column is Chrome applying a BT.709 to sRGB transfer conversion on the NV12 path and not on the I444 one; ffmpeg round-trips all three probes at worst 1.',
    command: 'node tools/video-bench/run.mjs colour',
  };
}

function tracking(video: unknown): Measurement {
  return {
    title: 'What a tracked frame would cost',
    finding:
      'Nine to eleven frames a second against thirty for playback. Tracking cannot be a render-loop activity, and no amount of tidying makes it one: it runs behind the playhead, and the interface has to be honest that a mask arrives after the frame does.',
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
    caveat: `Half precision is a good trade for attention and not for the encoder: attention's worst element moves by ${num(
      video,
      [
        'half-precision',
        'memory_attention',
        'fp16',
        'agreement_vs_fp32',
        'conditioned_features',
        'max_abs_diff',
      ],
    ).toFixed(3)} on values up to ${num(video, [
      'half-precision',
      'memory_attention',
      'fp16',
      'agreement_vs_fp32',
      'conditioned_features',
      'max_abs_value',
    ]).toFixed(
      2,
    )}, where the encoder's output goes into the memory bank and conditions every later frame. wasm is 30 to 50 times slower than WebGPU, so tracking is a WebGPU-only feature and the honest answer on a fallback is to say so rather than run it.`,
    command: 'node tools/video-bench/run.mjs attention half-precision',
  };
}

function readback(video: unknown): Measurement {
  return {
    title: 'The 12 MB readback the model needs, and does not bind on',
    finding:
      'The inference runtime declines an external GPUDevice, so the model’s input tensor is built on Rotyl’s GPU and read back once per image. On unified memory most of that is a memcpy and the transfer itself is nearly free.',
    table: {
      columns: ['12.58 MB tensor, per frame', '1920×1080', '4032×3024'],
      rows: [
        [
          'fullscreen pass and three copies',
          ms(num(video, ['readback', 'real_encoder_1920x1080', 'pass_and_copy_fenced', 'median'])),
          ms(num(video, ['readback', 'real_encoder_4032x3024', 'pass_and_copy_fenced', 'median'])),
        ],
        [
          'map, and copy out of it',
          ms(num(video, ['readback', 'real_encoder_1920x1080', 'map_and_copy_out', 'median'])),
          ms(num(video, ['readback', 'real_encoder_4032x3024', 'map_and_copy_out', 'median'])),
        ],
        [
          'total',
          ms(num(video, ['readback', 'real_encoder_1920x1080', 'total', 'median'])),
          ms(num(video, ['readback', 'real_encoder_4032x3024', 'total', 'median'])),
        ],
      ],
    },
    caveat:
      'Two and a half milliseconds of a 33 ms frame is 7%, and for video it is avoidable entirely: a VideoFrame belongs to no device, so the tensor can be built on the runtime’s own, which does take a GPU buffer and returns the same answer bit for bit.',
    command: 'node tools/video-bench/run.mjs readback',
  };
}

/**
 * The numbers taken by hand, kept apart from the numbers taken by a harness.
 *
 * They are not less true, but they are less reproducible, and a page that mixed
 * them would be claiming a discipline it only has for half of what it shows.
 */
function byHand(): Group {
  return {
    title: 'Taken by hand',
    blurb:
      'Measured in a browser with a fence and a stopwatch rather than by a harness, so nothing regenerates them and nothing notices if they drift. They are separated for that reason alone.',
    measurements: [
      {
        title: 'What editing costs',
        finding:
          'The style chain re-runs only when a style control changes, never while brushing, which is why these are the numbers that decide how the tool feels.',
        table: {
          columns: ['', '2 MP', '12 MP', '24 MP'],
          rows: [
            ['brush stroke (composite)', '1.0 ms', '2.0 ms', '3.1 ms'],
            ['brush stamp into the mask', '1.0 ms', '0.9 ms', '1.1 ms'],
          ],
        },
      },
      {
        title: 'Object selection, once the model is loaded',
        finding:
          'A click is flat because the model always works at 1024 px square; only building that input scales with the photograph. Reading the frame happens once, a click happens per click.',
        table: {
          columns: ['', '1 MP', '24 MP'],
          rows: [
            ['reading the frame (once)', '19 ms', '43 ms'],
            ['a click, model plus composite', '12 ms', '13 ms'],
          ],
        },
      },
      {
        title: 'What ships',
        finding:
          'Three runtime dependencies, two of them code-split so a session that never opens a video or an object never fetches them. Shader comments are stripped at build time, which is why a third style made the bundle smaller rather than larger.',
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
  };
}

export function measurementGroups(style: unknown, video: unknown): readonly Group[] {
  return [
    {
      title: 'The look',
      blurb:
        'What a style costs, whether it holds still, and what it took to make a hard decision safe on video. The style chain runs on every frame of a clip and once per control change on a photograph.',
      measurements: [
        styleCost(style),
        detailCost(style),
        stability(style),
        perturbation(style),
        quantisationFloor(),
      ],
    },
    {
      title: 'Video',
      blurb:
        'The four things that decided whether video could be built at all, and what shape it had to take.',
      measurements: [decode(video), upload(video), colour(video), tracking(video), readback(video)],
    },
    byHand(),
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
