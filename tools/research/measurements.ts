/**
 * Every measurement, pulled out of the harnesses' results by path.
 *
 * `at` throws rather than returning undefined, and that is the whole mechanism:
 * if a benchmark stops reporting something, or renames it, the page fails to
 * generate and the build fails with it. The alternative, a blank cell, or a
 * number left over from a shape that no longer exists, is indistinguishable
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
 * taken under, and those contain dots and commas. "sigma 0.5",
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
/**
 * Bytes below a kilobyte, because one of these is twelve of them and "0.0 KB"
 * reads as a rounding error rather than as the finding it is.
 */
const asBytes = (count: number): string =>
  count < 1024 ? `${count.toFixed(0)} bytes` : `${(count / 1024).toFixed(1)} KB`;
const pct = (value: number): string => `${value.toFixed(2)}%`;

const SIZES = ['720p', '2 MP', '12 MP', '24 MP'] as const;
const STYLES = ['comic', 'poster', 'print'] as const;

// --- the look ---------------------------------------------------------------

function styleCost(style: unknown): Section {
  return {
    heading: 'What a style chain costs',
    prose: [
      'Two of the three styles run in under two milliseconds at 720p. The third takes 140, and spends essentially all of it in a single stage.',
      'The print chain had never been timed before this. It was argued to be cheaper, on the grounds that it is three passes against nineteen with only one at output resolution. It is 200 times cheaper.',
      'A style does not have to be expensive to be flat. That is what the third style came out of: one that fits inside a frame is something a clip can be played through, rather than something a clip is rendered with.',
    ],
    table: {
      columns: ['style, default controls', ...SIZES],
      rows: STYLES.map((name) => [
        name,
        ...SIZES.map((size) => ms(num(style, ['chain', size, `${name}, default`, 'full', 'median']))),
      ]),
    },
    caveat:
      'Full quality tier, style chain only: the composite is a separate pass that re-runs on every brush movement. The 24 MP column is the one place the ordering stops being 20:1. Both cheap styles do all of their deciding in one pass at output resolution, so past about 12 megapixels they are paying for pixels rather than for thinking.',
    command: 'node tools/style-bench/run.mjs chain',
  };
}

function detailCost(style: unknown): Section {
  const tier = (name: string): string => ms(num(style, ['chain', '720p', 'comic, detail 1', name, 'median']));
  return {
    heading: 'Higher detail is cheaper, and the quality tiers collapse',
    prose: [
      'Turning detail up makes the comic chain four times faster at 720p, and a draft frame there is the same render as an export. Both of those sound like bugs and are consequences of one decision.',
      'Each stage declares the apparent scale it wants and derives its own resolution to hold it. When that resolution clamps to the output’s short edge, the kernel shrinks rather than the fraction drifting. Cost falls, and the tiers converge.',
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
    heading: 'Nothing boils here, and not for the reason anyone expected',
    prose: [
      'On this picture no style amplifies its input, every one attenuates it, and the chain that looked most at risk is the steadiest of the three. Two of those three claims survived a photograph unchanged and the poster row did not: see what survived a real picture, which re-takes this table against four of them and a film, and which is where the outline this row depends on was rebuilt.',
      'The worry was reasonable. Every stage runs per frame with no knowledge of the last one, and two of them are winner-take-all decisions on a noisy field: a Kuwahara picking its most homogeneous sector, a difference of Gaussians thresholding a response. A pixel one code different between two frames could flip either.',
      'It does not, because neither decides on one pixel. The Kuwahara chooses on the variance of two hundred samples, and the chain removes more grain than its decisions reintroduce.',
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
      'In output codes, over consecutive decoded frames of a fixed camera on a fixed scene, so everything that differs between two of them is grain and the encoder’s own noise. The mean is the least useful column: boiling is a small proportion of pixels moving a long way, which is what the other two measure. The scene is drawn rather than photographed, which is why every row here is read against the page that re-takes it on four that are not.',
    command: 'node tools/style-bench/run.mjs clips',
  };
}

function perturbation(style: unknown): Section {
  const p99 = (sigma: string, name: string): string =>
    `${num(style, ['perturbation', sigma, name, 'p99']).toFixed(0)} codes`;
  return {
    heading: 'The same result with the codec taken out of it',
    prose: [
      'The finding survives without a codec in the way. One frame is rendered twice, the second with grain of a known size added, so what is measured is the style and nothing else.',
      'Half a code is about the smallest perturbation an 8-bit pipeline can express, which is the "one code different between two frames" case exactly. Two codes is roughly a decent sensor at base ISO.',
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
      'What does boil is a hard threshold against a fixed field. A halftone dot is one. So is a quantiser, if it is left hard: the poster style’s first version measured five to ten times worse than the comic chain on a still camera.',
      'The cause is exact. Softening a step across one pixel is right for an edge and useless for a gradient, because where the field is nearly flat the local derivative is nearly zero. A band boundary then becomes a step of a whole level driven by a hundredth of one, and a frame of grain moves it.',
      'The fix is a floor under the transition width, expressed in the units of the thing being decided rather than in pixels. It caps the gain from input to output at about four. Chroma was the larger half: colour steps are as discontinuous as lightness ones and there are more of them, because chroma is small everywhere in a hazy picture.',
    ],
    table: {
      columns: ['poster, static camera', 'p99', 'over 8 codes'],
      rows: [
        ['hard, derivative only', '23.3', '1.67%'],
        ['lightness and palette margin floored', '14.6', '1.23%'],
        ['chroma floored as well', 'the row above', 'the row above'],
      ],
    },
    caveat:
      'Taken during development by re-running the clip measurement against each version. The last row is whatever the table above reports today; the first two are gone from the code and cannot be regenerated without reverting it. The fix costs nothing measurable and nothing visible: the transition only widens where the picture has no edge to sharpen. What it did not reach is the outline, which took its decision against a NEIGHBOUR’s rounded colour and so had no derivative to floor. That is the defect the real-picture page found, and what answered it there was a different operator rather than another floor.',
  };
}

function paletteFit(): Section {
  return {
    heading: 'A palette has to be fitted to the picture',
    prose: [
      'A hazy photograph uses two and a half of a palette’s five stops, and comes out in one colour. That looks like a palette chosen badly. It is a palette barely used.',
      'A palette is a claim about where a photograph’s lightness lives, and photographs disagree. The reference scene has a spread of 0.136 against 0.23 to 0.29 for every palette in the codebase.',
      'The fix is one pass measuring the picture’s own mean and spread, and one affine map moving it onto the palette’s. On a hazy frame it changes more than anything else measured here. The claim was re-taken against four photographs afterwards, because a scene drawn to be hazy is a poor witness to haze; it holds on all four, by less than the scene implies.',
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
    figure: {
      name: 'palettes',
      caption: 'The same frame, flattened the same way, under no palette and two of the five.',
    },
    caveat:
      'A fixed sampling grid is what makes measuring this per frame safe on video: the sample points do not move between frames and each tap is a local average of an already smoothed buffer, so the statistics follow the scene rather than the grain. The stability table above includes the fitted palettes, which is the check on that claim rather than the argument for it.',
  };
}

// --- a real picture ---------------------------------------------------------

const REAL_PICTURES = ['facade', 'foliage', 'fog', 'portrait'] as const;
const REAL_CLIPS = [
  ['the synthetic scene', 'the synthetic scene, fixed camera'],
  ['facade', 'facade, fixed camera'],
  ['foliage', 'foliage, fixed camera'],
  ['fog', 'fog, fixed camera'],
  ['portrait', 'portrait, fixed camera'],
  ['a film, exterior', 'Tears of Steel, exterior'],
  ['a film, interior', 'Tears of Steel, interior'],
] as const;

function realInputs(): Section {
  return {
    heading: 'The input a benchmark cannot commit',
    prose: [
      'Every temporal and cost number on the page before this was taken against a scene drawn by a script, and that harness says plainly that a script cannot produce a photograph’s texture statistics. The headline finding on it, that no style amplifies its input, is the whole argument for why per-frame stylisation is acceptable at all. It had never been put to a picture a camera took.',
      'Real footage cannot be checked in, so there were two honest ways to take this. Fetch a known input by URL and pin it by hash, or publish the number with a note saying nobody can reproduce it. The second is worse than it sounds: the measurement it applies to is the one the design rests on, and a number nobody can re-take is a number nobody can contradict.',
      'So it is fetched, and pinned by SHA-256 before anything is derived from it. That leaves one failure the synthetic scene does not have, a URL that stops resolving, and removes the one that matters. If the bytes at the far end change, the script refuses to run rather than quietly measuring a different picture.',
      'Three kinds of input, because no one of them settles it. The scene itself, re-taken in the same run rather than quoted from the page next door. Four photographs put through exactly the recipe that made the scene’s clip, so the picture is the only thing that differs. And two shots of a film, stream copied rather than re-encoded, which carry real sensor grain and real codec noise and also real subject motion, the one thing a fixed camera was isolating and no real shot can be without.',
    ],
    table: {
      columns: ['input', 'what it is there for'],
      rows: [
        ['the synthetic scene', 'the control, re-taken in the same run'],
        ['facade', 'strong directional structure, near monochrome, high contrast'],
        ['foliage', 'fine and isotropic: the other end of the axis'],
        ['fog', 'hazy distance and thin road markings: what the scene was drawn to imitate'],
        ['portrait', 'skin, and large out-of-focus areas'],
        ['a film', 'real grain, real codec noise, real motion, CC-BY, hash pinned'],
      ],
    },
    caveat:
      'The photographs are CC0 from Wikimedia Commons. The film is Tears of Steel, CC-BY 3.0, (CC) Blender Foundation. Nothing fetched is committed or redistributed. The film’s two shots are the quietest in it, found by scanning every frame for the window whose worst consecutive-frame difference is smallest; neither is locked off, because no real shot is.',
    command: './tools/style-bench/fetch-real.sh',
  };
}

function realCost(real: unknown): Section {
  const cell = (picture: string, size: string, name: string): string =>
    ms(num(real, ['real-chain', picture, size, name, 'full', 'median']));
  // Computed rather than typed, like every other figure here: a percentage in
  // prose is exactly as capable of going stale as one in a table.
  const at720 = (picture: string): number =>
    num(real, ['real-chain', picture, '720p', 'comic, default', 'full', 'median']);
  const scene = at720('the synthetic scene');
  const cheaper = (picture: string): string => `${(((scene - at720(picture)) / scene) * 100).toFixed(0)}%`;
  const cheapest = REAL_PICTURES.reduce((a, b) => (at720(a) < at720(b) ? a : b));
  const dearest = REAL_PICTURES.reduce((a, b) => (at720(a) > at720(b) ? a : b));
  return {
    heading: 'Content barely moves the cost table, and not the way it was meant to',
    prose: [
      'This was expected to move. The anisotropic Kuwahara’s sample bound grows with local anisotropy, so a frame of architecture should cost more than a frame of foliage, and the harness that took the original figures carries a caveat telling readers to treat the comic column as a hard case rather than a typical one.',
      `The prediction does not appear. Foliage is the dearest of the four photographs and a brick wall is not, which is the ordering backwards. What does appear is a smaller effect running the other way: the portrait is the cheapest of the five, ${cheaper(
        'portrait',
      )} below the scene, and large out-of-focus areas are exactly where anisotropy is low.`,
      `So the caveat was right that the scene is not typical and wrong about how much that matters. Every photograph here is cheaper than it, by ${cheaper(
        dearest,
      )} to ${cheaper(
        cheapest,
      )}, which puts it at the top of a narrow range rather than in a class of its own. Cost is set by the stage resolutions, and those are derived from the output’s short edge and from nothing in the picture.`,
    ],
    table: {
      columns: ['comic, default, full tier', ...SIZES],
      rows: [
        ['the synthetic scene', ...SIZES.map((size) => cell('the synthetic scene', size, 'comic, default'))],
        ...REAL_PICTURES.map((picture) => [
          picture,
          ...SIZES.map((size) => cell(picture, size, 'comic, default')),
        ]),
      ],
    },
    caveat: `The two cheap chains are flat across content as well: poster runs ${cell('facade', '720p', 'poster, default')} on the wall and ${cell('foliage', '720p', 'poster, default')} on the leaves. Photographs are cropped to the ladder’s aspect rather than stretched into it, because stretching one axis by up to two is a change to local anisotropy, which is the thing under test.`,
    command: 'node tools/style-bench/run.mjs real-chain',
  };
}

function realStability(real: unknown): Section {
  const cell = (clip: string, name: string): string =>
    num(real, ['real-clips', clip, name, 'amplification', 'p99']).toFixed(2);
  return {
    heading: 'The comic chain held. The poster chain had to be rebuilt.',
    prose: [
      'Half of the original finding survived a photograph untouched. The comic chain really is steadier than its input, on a photograph as on a drawing, which is the part that was surprising and the part the design leans on.',
      'The other half was false, and it was the poster chain. On a brick wall it amplified by 5.7 and on foliage by 4.9, where the synthetic scene reports it attenuating by two. That is not a small drift in a number: it is the opposite sign, on the measurement that says whether stylised video is worth shipping, and it was invisible for as long as the input was drawn rather than photographed. The two sections below are what it turned out to be and what replaced it. This table is taken afterwards, and the wall now reads 1.36.',
      'The two rows that are not fixed cameras are read differently and are here for a different reason. An actor moving is a large honest change and it lands in the source column, so the ratio is the only thing those rows can say. What they said before the change was that the poster chain was four times its input on real footage while the other two were near one; what they say now is that all three sit between one and two.',
    ],
    table: {
      columns: ['styled change over source change, p99', 'comic', 'poster', 'poster, no outline', 'print'],
      rows: REAL_CLIPS.map(([label, clip]) => [
        label,
        cell(clip, 'comic, default'),
        cell(clip, 'poster, default'),
        cell(clip, 'poster, no line'),
        cell(clip, 'print, default'),
      ]),
    },
    caveat:
      'Twenty-four consecutive frames, in output codes, at the 99th percentile of the per-pixel change between one frame and the next. One means the style is exactly as steady as what it was given. The fourth column is the same chain with the outline switched off, which is the floor the third column is trying to reach and the diagnostic the next section is about.',
    command: 'node tools/style-bench/run.mjs real-clips',
  };
}

function realOutline(real: unknown): Section {
  const p99 = (picture: string, name: string): string =>
    num(real, ['real-perturbation', picture, 'sigma 2', name, 'p99']).toFixed(0);
  return {
    heading: 'It was the outline, and the quantiser inside it',
    prose: [
      'With the codec, the camera and the subject all taken out, the same result appeared and it had one cause. One picture is rendered twice with grain of a known size added the second time, so what is measured is the style and nothing else. On the wall a perturbation whose 99th percentile is six codes came out the far side at seventy-eight. Turned the outline off and it came out at eight.',
      'The mechanism is exact. The outline compared the quantised colour here against the quantised colour a line away, and a quantised colour is what round() returns: it flips a whole band on an infinitesimal change, the flip moved the comparison by a fifth of the Oklab range, that crossed the line threshold, and a stroke appeared at full weight. The scene could not show it. It was drawn with large near-flat regions, so almost no pixel in it sits near a band edge, and the population that flickers is exactly that one. A brick wall is nothing but marginal boundaries.',
      'What the quantiser was contributing was the flicker and nothing else. Two sides in different bands returned a whole band however far apart the picture had them, so which pixels along a faint boundary got a stroke was decided by where the band grid happened to fall: a faint line was drawn as a dotted one rather than as a fainter one. The outline now measures the flattened colour itself and its weight is that distance, ramped up to the threshold. The table is after that change, and the row it was written for reads fifteen against a floor of eight.',
    ],
    table: {
      columns: ['grain σ 2, p99 out', 'input', 'comic', 'poster', 'poster, no outline', 'print'],
      rows: [['the synthetic scene', ...REAL_PICTURES] as const]
        .flat()
        .map((picture) => [
          picture,
          p99(picture, 'input'),
          p99(picture, 'comic, default'),
          p99(picture, 'poster, default'),
          p99(picture, 'poster, no line'),
          p99(picture, 'print, default'),
        ]),
    },
    caveat:
      'The remainder is not the quantiser and does not look like it: the map that real-flicker writes no longer traces the ink but scatters through the texture, which is the flatten’s own edge contrast moving under the grain and being read through the ramp. Five codes above the floor on the two worst pictures in this set is where that leaves it. The section below is the four tuning passes tried before the operator was replaced, and why none of them could have worked.',
    command: 'node tools/style-bench/run.mjs real-perturbation',
  };
}

function outlineAttempts(): Section {
  return {
    heading: 'Four tuning passes, and why the answer was a different operator',
    prose: [
      'The old outline compared two quantised colours and thresholded the distance between them, so there were exactly two hard decisions in it and each could be softened independently. All four combinations were measured against the worst picture, and the useful result is the one that says none of them works.',
      'Softening the neighbour probe buys about a fifth and costs the look, because a soft probe reduces the distance at a genuine boundary as much as it reduces the noise at a marginal one. Centring the threshold’s transition rather than opening at it is free and buys nothing on its own. The two together get within three times of the floor and no closer, and the floor is the same picture with the outline switched off.',
      'What that pattern means is not a tuning problem. The quantity being thresholded is a distance between two rounded colours and is therefore discrete: with a hard probe it takes a handful of values and a transition width has nothing to resolve, and with a soft probe the signal and the noise are the same quantity and softening moves both. So the probe stopped rounding. Reading the flattened colour instead makes the strength continuous in the picture by construction, and it stays a region boundary rather than becoming a difference of Gaussians because of WHICH picture it reads: the bilateral’s piecewise-constant answer, which is where smog, grain and the inside of foliage have already gone.',
    ],
    table: {
      columns: ['what was changed, grain σ 2, p99 out of 6 in', 'facade', 'foliage'],
      rows: [
        ['nothing, as it was', '85', '61'],
        ['the probe softened', '69', '46'],
        ['the threshold centred, half width 0.02', '85', '54'],
        ['the threshold centred, half width 0.12', '59', '37'],
        ['both, half width 0.06', '34', '27'],
        ['both, half width 0.10', '25', '21'],
        ['the probe unrounded, a ramp to the threshold', '15', '16'],
        ['no outline at all', '8', '7'],
      ],
    },
    caveat:
      'Taken during development by re-running the perturbation against each version; five of the eight rows are gone from the code and cannot be regenerated without reverting it, which is the same footing the transition-floor table on the look page is on. The last two are what the table above reports today. Every one of them was checked against the look as well as against the number, by rendering the reference scene through both chains and differencing: the shipped operator moves 7.8% of that picture more than eight codes, and what moves is the outlines the old one drew on the quantiser’s grid rather than on the picture.',
    command: 'node tools/style-bench/run.mjs real-flicker',
  };
}

function realLightness(real: unknown): Section {
  const of = (picture: string, key: string): string =>
    num(real, ['real-lightness', 'pictures', picture, key]).toFixed(3);
  const palette = (name: string, key: string): string =>
    num(real, ['real-lightness', 'palettes', name, key]).toFixed(3);
  return {
    heading: 'A photograph does use less of a palette than a palette assumes',
    prose: [
      'This one survives, and it is worth saying because it was the claim most at risk. The levels pass exists because the scene occupies about half the lightness range every palette assumes, and the scene was drawn hazy. Measuring the property an input was built to have is not a measurement.',
      'Every photograph here is narrower than every palette. The closest, a portrait at 0.213 against the narrowest palette’s 0.234, still reaches only nine tenths of it; the fog, which is the case the fitting was written for, sits at 0.196 against 0.288 for the widest.',
      'The scene does overstate it. At 0.135 it is narrower than any of the four, so the fitted map moves it further than it moves a photograph. The stage earns its place on all five, by less on real pictures than the argument for it implied.',
    ],
    table: {
      columns: ['Oklab lightness', 'p1', 'p50', 'p99', 'mean', 'spread'],
      rows: [
        ...['the synthetic scene', ...REAL_PICTURES].map((picture) => [
          picture,
          of(picture, 'p1'),
          of(picture, 'p50'),
          of(picture, 'p99'),
          of(picture, 'mean'),
          of(picture, 'spread'),
        ]),
        ...['Mural', 'Noir'].map((name) => [
          `${name} palette`,
          '',
          '',
          '',
          palette(name, 'mean'),
          palette(name, 'spread'),
        ]),
      ],
    },
    caveat:
      'Read from the sRGB bytes the chain is handed, through the same transfer function the hardware applies, at 720p. The palettes’ own figures come from the product’s function rather than from a copy of the numbers, so a palette edited in the codebase moves this table.',
    command: 'node tools/style-bench/run.mjs real-lightness',
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
      'The next frame costs 0.46 ms. A seek costs 12 ms, or 88 on the same content encoded with one keyframe instead of thirty.',
      'There is no such thing as decoding frame N. There is decoding from the keyframe at or before N and discarding what comes between, so the cost of a scrub is set by keyframe spacing and by nothing else.',
      'That is a design constraint rather than a number to optimise. A scrub that moves forward must never re-seek: one decoder is held open and fed forward, and it starts again only for a backward or a distant jump.',
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
      'A video frame belongs in the same source texture a photograph does, sampled through the same sRGB view. Nothing downstream needed a special case, and the colour contract survived video with no shader changes at all.',
      'Both ways of being wrong here are silent, so it was measured rather than assumed: sixteen flat patches with known sRGB bytes, encoded to H.264 and brought back. What an external texture samples turns out to be sRGB-encoded, exactly like the bytes of a decoded image.',
      'Writing it through an sRGB view instead encodes it twice. The second row is what that costs, and it is the kind of mistake that is obvious in a measurement and invisible in a review.',
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
      'A tracked frame costs about 90 ms against the 33 a playing clip has, summing the four graphs it is made of. Tracking cannot be a render-loop activity, and no amount of tidying makes it one.',
      'It runs behind the playhead instead, and the interface has to be honest that a mask arrives after the frame does. That is a product decision taken from a number, before any of it was built.',
      'Memory attention is the expensive half, and the fixed-size memory bank is why: 4096 queries against 3648 keys on every frame, where the reference attends against fewer early in a clip.',
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
      'Two and a half milliseconds of a 33 ms frame is 7%. The readback that looked like the binding constraint is not one.',
      'The inference runtime declines an external GPUDevice, so the model’s input tensor is built on Rotyl’s GPU and read back: 12.58 MB per frame, and a worry about 360 MB/s across the bus at 30 frames a second.',
      'On unified memory there is no bus to cross. Most of the cost is a memcpy, and an ordinary ArrayBuffer copy of the same size measures about the same.',
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

function tracksWhat(tracking: unknown): Section {
  const SCENES = ['crossing', 'occlusion', 'blur', 'lighting'] as const;
  const of = (scene: string, key: string): unknown => at(tracking, [`${scene}, with pointers`, key]);
  const iou = (scene: string, key: string): string =>
    num(tracking, [`${scene}, with pointers`, key]).toFixed(3);
  const swapped = (scene: string): string => {
    const list = of(scene, 'swapped');
    return Array.isArray(list) && list.length > 0 ? `frames ${list.join(', ')}` : 'never';
  };
  return {
    heading: 'It survives the three things the fixture did not have',
    prose: [
      'The clip these graphs were verified against was two lookalikes on converging paths, and the harness that drew it said plainly what it left out: no occlusion, no motion blur and no lighting change, which are the three things a memory bank exists for. Passing it was therefore weak evidence for the claim it was quoted for.',
      'Three more clips, each changing exactly one of those and keeping the paths and the seed. Nothing takes the wrong object on any of them. The one that costs something is motion blur, which is also the one nobody was worried about: a smeared boundary is genuinely ambiguous, and seven points of IoU is the tracker declining to guess where a smear ends rather than losing the thing.',
      'An illumination ramp of a stop and a half costs almost nothing, which is worth knowing because a memory entry encodes appearance and the obvious worry is that appearance from eight frames ago stops matching. It does not, at that size.',
    ],
    table: {
      columns: ['clip', 'worst IoU against truth', 'took the distractor'],
      rows: SCENES.map((scene) => [scene, iou(scene, 'worst_iou'), swapped(scene)]),
    },
    caveat:
      'Worst over the frames where the object is wholly visible, from a single click on frame zero and no further input. A frame showing a sliver of an object scores badly however well a tracker is doing, so the partial frames either side of the occlusion are reported separately in the results rather than folded in here. The masks are identical to the PyTorch reference on every frame of every clip, which is the other half of what this run checks.',
    command: 'python tools/edgetam-export/verify.py --sweep',
  };
}

function pointers(tracking: unknown): Section {
  /**
   * How late it was back, and "never" is a real answer.
   *
   * The harness reports null when the object was never picked up again, which
   * is a possible outcome now the occlusion outlasts the memory bank and is the
   * one worth being able to print. Reading it through `num` would fail the
   * build on the most interesting result this table can produce.
   */
  const delay = (which: string): string => {
    const value = at(tracking, [`occlusion, ${which}`, 'reacquisition_delay']);
    if (value === null) return 'never';
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`research: reacquisition_delay for ${which} is ${JSON.stringify(value)}`);
    }
    return value.toFixed(0);
  };
  const worst = (scene: string, which: string): string =>
    num(tracking, [`${scene}, ${which}`, 'worst_iou']).toFixed(3);
  return {
    heading: 'Object pointers cost the frames it matters most to have',
    prose: [
      'The published mask decoder does not expose `object_pointer`, the token that carries an object’s identity between frames, so a first implementation either re-exports the decoder or goes without. Measured on the old fixture, going without cost nothing, and that result was published with a warning attached to it: pointers exist for re-identification after occlusion, and the fixture had none.',
      'With an occlusion in the clip the cost appears, and it is exactly where the warning said it would be. It is not a swap and it is not drift: without pointers the tracker produces no mask at all on the frame the object comes back on, and finds it again some frames later. The occlusion is eight frames long, which is more than the seven a memory bank holds, so by the time the object returns nothing in that bank has ever seen it and re-identification is the only thing that could work.',
      'Every average hides that. The worst IoU over whole frames is a shade better without pointers on every clip, because a run that skips the hardest frame is not scored on it. What lengthening the occlusion from three hidden frames to eight adds is that both numbers grew and the gap between them did not: pointers buy back one frame either way, and the frame the object first shows again is a five per cent sliver that nothing segments well. Coming back late from a re-entry is a small thing on a fixture and a visible thing on a clip somebody exports, and it is the reason to re-export the decoder rather than a reason not to.',
    ],
    table: {
      columns: ['', 'with pointers', 'without'],
      rows: [
        ['frames late returning from an occlusion', delay('with pointers'), delay('no pointers')],
        ['worst IoU, occlusion', worst('occlusion', 'with pointers'), worst('occlusion', 'no pointers')],
        ['worst IoU, crossing', worst('crossing', 'with pointers'), worst('crossing', 'no pointers')],
        ['worst IoU, motion blur', worst('blur', 'with pointers'), worst('blur', 'no pointers')],
      ],
    },
    caveat:
      'One occlusion on one synthetic clip, now long enough to outlast the bank rather than merely to interrupt it. What it still does not say is how the cost grows with the number of objects, which is the other half of what pointers are for.',
    command: 'python tools/edgetam-export/verify.py --sweep',
  };
}

// --- what a tracked frame costs, now that there is one -----------------------

const TRACKED_CLIPS = ['720p30-gop30', '1080p30-gop30'] as const;

/**
 * One run out of the list, by clip and by how many objects it followed.
 *
 * A list rather than a keyed object because the harness reports what it ran
 * rather than what somebody expected it to run, and finding a row by its two
 * fields is what makes an added configuration cost nothing here.
 */
function trackedRun(tracked: unknown, clip: string, objects: number): unknown {
  const runs = at(tracked, ['tracked-frame', 'runs']);
  if (!Array.isArray(runs)) throw new Error('research: tracked-frame has no runs');
  const found = runs.find(
    (run: unknown) =>
      typeof run === 'object' &&
      run !== null &&
      Object.getOwnPropertyDescriptor(run, 'clip')?.value === clip &&
      Object.getOwnPropertyDescriptor(run, 'objects')?.value === objects,
  );
  if (found === undefined) {
    throw new Error(`research: no tracked-frame run for ${clip} with ${String(objects)} objects`);
  }
  return found;
}

const trackedMs = (tracked: unknown, clip: string, objects: number): number =>
  num(trackedRun(tracked, clip, objects), ['frame_ms', 'median']);

function trackedCost(tracked: unknown): Section {
  const cell =
    (objects: number): ((clip: string) => string) =>
    (clip) =>
      ms(trackedMs(tracked, clip, objects));
  const derived = (clip: string): number => trackedMs(tracked, clip, 2) - trackedMs(tracked, clip, 1);
  const perSecond = Math.round(1000 / trackedMs(tracked, TRACKED_CLIPS[0], 1));
  return {
    heading: `${String(perSecond)} tracked frames a second, where the sum said nine to eleven`,
    prose: [
      'The figure this project designed tracking around was summed from four graphs measured separately, and published saying plainly that nothing had been run end to end because there was nothing to run. There is now, so this drives the product’s own code: the two engines it loads, the scene it walks, the loop it runs, writing into a real command log.',
      'The conclusion survives and gets firmer. Playback is thirty frames a second and this is seven, so tracking is a job, the playhead is free to ignore it, and no amount of tidying makes it a render-loop activity.',
      'Frame size does not enter into it, exactly as predicted: the vision encoder always works at 1024 square, and 720p and 1080p differ by two tenths of a millisecond.',
    ],
    table: {
      columns: ['a tracked frame', '720p', '1080p'],
      rows: [
        ['one object', ...TRACKED_CLIPS.map(cell(1))],
        ['two objects', ...TRACKED_CLIPS.map(cell(2))],
        ['a second object, by difference', ...TRACKED_CLIPS.map((clip) => ms(derived(clip)))],
        [
          'reading the frame, by difference',
          ...TRACKED_CLIPS.map((clip) => ms(trackedMs(tracked, clip, 1) - derived(clip))),
        ],
      ],
    },
    caveat:
      'The split is derived rather than timed, and that is not fussiness. A run has two seams and a stopwatch on each of them does not add up to a frame: the segmentation engine asks for gpu-buffer outputs, so its run returns before the GPU has finished and reading a frame measures seven milliseconds, with the rest landing in whatever asks for those outputs next. A second tracked object is exactly one more advance and not one more read, so the difference between one object and two is an advance and what is left over is the read. Both are fenced by construction.',
    command: 'node tools/video-bench/run.mjs tracked-frame',
  };
}

function trackedArithmetic(tracked: unknown): Section {
  const each = (name: string): number => num(tracked, ['tracked-frame', 'arithmetic', name, 'median']);
  const row = (label: string, name: string, times: number): readonly string[] => [
    label,
    ms(each(name)),
    `×${String(times)}`,
  ];
  const perObject =
    each('to_channel_major') * 2 +
    each('to_token_major') +
    each('at_memory_resolution') +
    each('mask_for_memory');
  return {
    heading: 'The missing forty-five milliseconds are not in a graph',
    prose: [
      'Five passes over a million elements of JavaScript run per tracked object, and not one of them is a model, which is exactly why none of them was in the sum. With the three graphs an advance is 38 plus 19 plus 13, which is 70; plus these and a four-megabyte readback of the conditioned map it is 91, to within the noise.',
      'So the sum was not wrong about the graphs. It was a sum of graphs, in a frame that is a third something else. That is the general shape of the finding rather than a detail of this one: a cost model built out of the expensive parts is a lower bound, and the arithmetic between them is where the rest lives.',
      '`toChannelMajor` runs twice because attention answers token-major and both the memory encoder and the mask decoder want the other way round. One of the two is avoidable, since the memory encoder’s input is the vision encoder’s own layout with one constant subtracted, and it is being rebuilt from a transpose of itself. It is four per cent of a frame, so it is written down rather than done.',
    ],
    table: {
      columns: ['the arithmetic between the graphs', 'per call', 'a frame'],
      rows: [
        row('toChannelMajor', 'to_channel_major', 2),
        row('toTokenMajor', 'to_token_major', 1),
        row('atMemoryResolution', 'at_memory_resolution', 1),
        row('maskForMemory', 'mask_for_memory', 1),
        ['all of it, per tracked object', ms(perObject), ''],
      ],
    },
    caveat: `The vision position encoding is ${ms(
      each('vision_position_encoding'),
    )} and runs once a session rather than once a frame, which is the whole of what computing four megabytes costs against shipping them: a third of the shared attention graph's entire download, for five milliseconds, once.`,
    command: 'node tools/video-bench/run.mjs tracked-frame',
  };
}

// --- the host, against the reference ----------------------------------------

const SCENES_MEASURED = ['crossing', 'occlusion', 'blur', 'lighting'] as const;

/**
 * The worst a stage was over the four clips.
 *
 * Worst rather than mean, and over every clip rather than the one the export
 * was verified against, because what these say is "this piece of arithmetic
 * agrees with the reference", and one clip where it does not is the whole
 * finding.
 */
function worstStage(host: unknown, stage: string): number {
  return Math.max(...SCENES_MEASURED.map((scene) => num(host, [scene, 'stages', stage])));
}

/** A difference measured as an absolute error, at the scale it lives on. */
const absoluteError = (value: number): string => (value === 0 ? 'exact' : value.toExponential(1));

function hostArithmetic(host: unknown): Section {
  const row = (label: string, stage: string): readonly string[] => [
    label,
    absoluteError(worstStage(host, stage)),
  ];
  return {
    heading: 'The tracker is the reference, and three of the pieces were not',
    prose: [
      'Two graphs of a tracked frame were exported here and verified against the modules they came from. The other half of a tracked frame is not in any graph: it is two published graphs either side of them, four transposes between four sessions, the layout of the memory bank and the arithmetic the memory encoder is fed. All of it is host code, and every one of those fails by producing a plausible mask of roughly the right object rather than by producing an error.',
      'So each piece is run against the reference’s own inputs and its answer compared with the reference’s own. Teacher-forced on purpose: a free-running tracker diverges a little on every frame, and then every later stage is being compared against a slightly different frame, which turns several sharp answers into one blurred one.',
      'Three of them were wrong when this was taken, and two of the three are in the table below this one. The bank was the third, and it is the one that is now exact: laid out from the entries the memory encoder produced, it reproduces the reference’s own bank to the bit, all 233,472 floats of it, on every frame of every clip.',
    ],
    table: {
      columns: ['what the host computes', 'worst against the reference'],
      rows: [
        row(
          'the frame’s features, token-major, no-memory embedding off',
          "the frame's features, token-major, no-memory off",
        ),
        row('the vision position encoding, computed rather than served', 'vision position encoding'),
        row('the memory bank', "the bank, laid out against the reference's own"),
        row(
          'the bank’s positions, with the temporal row added',
          "the bank's positions, with the temporal row on",
        ),
        row('the conditioned features, off that bank', 'the conditioned features, off a laid-out bank'),
        row('the mask a memory is encoded from', 'the mask a memory is encoded from'),
        row('the mask decoder, given one point labelled -1', 'the published decoder, one point labelled -1'),
      ],
    },
    caveat:
      'Everything above the mask decoder is a graph’s own numerical error rather than the arithmetic’s: the published vision encoder and the reference agree to about 2e-5 on features whose values run to 2.5, and the two exact rows are exact because a permutation of floats either is or is not the same permutation.',
    command: 'python tools/edgetam-export/host.py --sweep',
  };
}

function hostMistakes(host: unknown): Section {
  const row = (label: string, stage: string): readonly string[] => [
    label,
    absoluteError(worstStage(host, stage)),
  ];
  return {
    heading: 'The two that answered, answered plausibly, and answered wrongly',
    prose: [
      'The mask decoder accepts empty `input_points` and empty `input_boxes` together. It was never sent them, because the object-selection path returns early when a prompt has neither, so the tracked-frame path was unexercised. It turns out to run, and to give a different answer from the reference’s.',
      'The reason is one line in the reference: a prompt made of points is padded with a trailing "not a point" token, and the published graph was traced with that padding baked in. So a graph handed zero points appends one and produces ONE such token where the reference has two. What a tracked frame has to send is one point with a label of -1, whose coordinates are then discarded and whose embedding is replaced wholesale. With that, the published decoder is the reference’s decoder to 1e-4.',
      'The second was the mask on its way into the memory encoder, which is 256 px from the decoder and 1024 px in the graph. This resampled it nearest, on the reasoning that the reference upsamples a high-resolution mask it already holds while a host reconstructs a decision. The reference holds no such mask: `pred_masks_high_res` is a bilinear interpolation of exactly these logits and nothing else.',
    ],
    table: {
      columns: ['the same stage, done the way it was written first', 'worst against the reference'],
      rows: [
        row('the mask decoder, given no prompt tensors at all', 'the same, with no prompt tensors at all'),
        row(
          'the mask resampled nearest rather than bilinear',
          'the same, resampled nearest instead of bilinear',
        ),
      ],
    },
    caveat:
      'The second number is on a field the memory encoder receives in the range −10 to 10, so being out by twenty is being out by the whole of it, along every edge of every mask. Neither of these produces an error, a warning or an obviously wrong picture, which is the reason this page exists rather than a screenshot.',
    command: 'python tools/edgetam-export/host.py --sweep',
  };
}

function hostEndToEnd(host: unknown): Section {
  const worstIou = (which: string): number =>
    Math.min(...SCENES_MEASURED.map((scene) => num(host, [scene, 'differences', which, 'worst_iou'])));
  const cell = (which: string, name: string): string =>
    num(host, [name, 'differences', which, 'worst_agreement']).toFixed(4);
  const row = (label: string, which: string): readonly string[] => [
    label,
    ...SCENES_MEASURED.map((scene) => cell(which, scene)),
  ];
  const anchor = (scene: string): number =>
    (num(host, [scene, 'differences', 'as it is built', 'worst_agreement']) -
      num(host, [scene, 'differences', 'a sliding bank, no anchor', 'worst_agreement'])) *
    100;
  return {
    heading: 'What it takes for a clip to price any of this',
    prose: [
      'The obvious way to judge the corrections above is to run the whole tracker with and without each of them and see which masks are better. For a long time that said nothing: every configuration, including three known-wrong ones, landed between 0.91 and 0.99 against the reference with an ordering that was not consistent between clips. That was the clips rather than the corrections, and the fixtures were rebuilt around it. Every one of them now separates every correction, in the right order.',
      `An anchored memory bank is insurance against the recent frames being WRONG, so pricing it needs a clip carrying a moment where the tracker could plausibly go wrong. Length alone does not supply one: a version of the control that merely converged and stayed close moved the sliding bank by nothing at all over twenty-two frames of divergence. Crossing head-on and pulling apart afterwards does supply one, and so does hiding the object for longer than the bank remembers. Keeping the anchor is worth between ${anchor(
        'lighting',
      ).toFixed(2)} and ${anchor('blur').toFixed(2)} points of worst-frame agreement depending on which.`,
      'The absent gate is the one row that moves on a single clip, and that is the row behaving correctly rather than the clip failing: it decides what a frame the object is not in contributes to the bank, and the occlusion is the only fixture with such frames.',
    ],
    table: {
      columns: ['worst-frame agreement with the reference', ...SCENES_MEASURED],
      rows: [
        row('as it is built', 'as it is built'),
        row('with no absent gate', 'no absent gate'),
        row('with a sliding bank', 'a sliding bank, no anchor'),
        row('resampling nearest', 'nearest, not bilinear'),
        row('with no padding point', 'no padding point'),
        row('seeded with raw logits rather than coverage', 'the seed as raw logits'),
      ],
    },
    caveat: `Worst IoU against ground truth tells the same story more coarsely and is in the results file: every configuration sits between ${worstIou(
      'the seed as raw logits',
    ).toFixed(3)} and ${worstIou('a sliding bank, no anchor').toFixed(
      3,
    )} because none of them takes the wrong object on any clip, which is still more than these fixtures can ask. The last row is the one deliberate difference and the strongest result here: seeded with the reference's own mask this tracker reproduces the PyTorch one exactly, frame for frame, on all four clips, so the gap between that row and the first is what the command log's coverage costs, and it buys a shade of IoU back against a hard-edged disc.`,
    command: 'python tools/edgetam-export/host.py --sweep',
  };
}

function download(video: unknown, shrink: unknown): Section {
  const mb = (variant: string): string =>
    `${num(video, ['half-precision', 'memory_attention', variant, 'model_mb']).toFixed(1)} MB`;
  const perFrame = (variant: string): string =>
    `${num(video, ['half-precision', 'memory_attention', variant, 'run_ms', 'median']).toFixed(1)} ms`;
  const duplicated = num(shrink, ['memory_attention', 'duplicated_bytes']) / 1e6;
  const copies = num(shrink, ['memory_attention', 'removed']);
  const hoisted = num(shrink, ['memory_attention', 'hoisted_constants']);
  return {
    heading: 'The download is not halved, it is quartered',
    prose: [
      'The expensive graph exports at 69.6 MB and holds 11.8 MB of weights. Everything else is rotary tables, which the tracer captures once per layer and once per attention block because the module that produces them takes no inputs and can therefore be traced away. Turning constant folding off does not help: they are not folded, they are traced.',
      `Where they sit is the reason the obvious pass finds nothing. They are not initializers. They are ${hoisted.toFixed(
        0,
      )} Constant NODES, each carrying its own copy in an attribute, so a sweep over the graph's initializers reports no duplication at all. Hoisting them into initializers first, then sharing the ones whose bytes match, removes ${copies.toFixed(
        0,
      )} copies and ${duplicated.toFixed(1)} MB.`,
      'It costs nothing on either axis, which had to be checked rather than assumed: a tensor read from six places could plausibly be allocated differently by a WebGPU backend. The outputs are identical to the bit and the median run time moves by less than the run-to-run spread.',
      'So tracking’s marginal download is the shared half-precision attention graph at 12 MB plus the encoder at 6.7, which stays at full precision for the reason above. Nineteen megabytes on top of the twenty already fetched for object selection, against seventy-six.',
    ],
    table: {
      columns: ['memory attention', 'size', 'a frame', 'against fp32'],
      rows: [
        ['as exported', mb('fp32'), perFrame('fp32'), ''],
        ['half precision', mb('fp16'), perFrame('fp16'), '0.074 on values up to 2.53'],
        ['tables shared', mb('shared'), perFrame('shared'), 'identical'],
        ['both', mb('shared fp16'), perFrame('shared fp16'), '0.074, as fp16'],
      ],
    },
    caveat:
      'The memory encoder has no duplication worth removing, 6.7 MB before and after, and half precision is not a safe conversion for it: its worst output element moves by half the signal and that output conditions every later frame. So it ships whole, and it is the smaller of the two anyway.',
    command: 'python tools/edgetam-export/shrink.py --verify --fp16',
  };
}

function commandLog(video: unknown): Section {
  const fold = (frames: string): string =>
    `${num(video, ['log', 'fold', `${frames} frames`, 'at_the_end', 'median']).toFixed(1)} ms`;
  const megabytes = (frames: string): string =>
    `${num(video, ['log', 'fold', `${frames} frames`, 'raw_megabytes']).toFixed(0)} MB`;
  const packed = (frames: string): string =>
    `${num(video, ['log', 'fold', `${frames} frames`, 'packed_megabytes']).toFixed(0)} MB`;
  const size = (mask: string): string =>
    `${(num(video, ['log', 'compression', mask, 'packed_bytes']) / 1024).toFixed(1)} KB`;
  const ratio = (mask: string): string =>
    `${num(video, ['log', 'compression', mask, 'ratio']).toFixed(0)} times`;
  const unpacking = (mask: string): string =>
    `${num(video, ['log', 'compression', mask, 'unpacking_300_ms', 'median']).toFixed(1)} ms`;
  const sparse = (frames: string): string =>
    `${num(video, ['log', 'one_in_thirty', `${frames} frames`, 'packed_megabytes']).toFixed(1)} MB`;
  return {
    heading: 'A tracked clip belongs in the command log, and the mask had to change shape to fit',
    prose: [
      'Tracking contributes one applyMask command per frame it has followed the object to, which is the mechanism the document already has and needs no new command type. Whether that scales is a different question from whether it fits, and the log is what makes undo and device-loss recovery cheap enough to be free.',
      `The objection that looked most likely turns out not to be one. Folding a frame's commands filters and sorts the whole log, which is nothing at ten commands and could have been a per-frame cost at ten thousand. It is not: ${fold(
        '18000',
      )} for a ten-minute clip with a mask on every frame, against a 33 ms frame.`,
      `What did not fit is the bytes. A mask at the engine's own 256 px square is 64 KB held plainly, so ten seconds was ${megabytes(
        '300',
      )} and ten minutes ${megabytes(
        '18000',
      )}, which is the same wall a clip export already meets arriving sooner. Coverage is nearly binary and packs like it: ${size(
        'roughness 0.5',
      )} for a mask this shape, ${ratio(
        'roughness 0.5',
      )} smaller, and the ragged end of the sweep is barely worse because the cost is the perimeter rather than the area. Ten minutes is ${packed(
        '18000',
      )}.`,
      `What the packing does not pay for by itself is the replay. Unpacking is cheap once and is not once: a rebuild of the mask walks every command the frame folded to, and ${unpacking(
        'roughness 0.5',
      )} of a 33 ms frame goes on three hundred masks before any of them reaches the GPU. So the fold cuts at the last command that decides the frame by itself, which a run of replaces makes the last one. Three hundred commands become one, and so does eighteen thousand.`,
    ],
    table: {
      columns: ['a mask on every frame', 'held plainly', 'packed', 'folding one frame'],
      rows: [
        ['10 seconds', megabytes('300'), packed('300'), fold('300')],
        ['100 seconds', megabytes('3000'), packed('3000'), fold('3000')],
        ['10 minutes', megabytes('18000'), packed('18000'), fold('18000')],
      ],
    },
    caveat: `A wide boundary is what costs the packing, not a ragged one, because the engine maps its decision boundary across the whole range and an answer it is unsure about never leaves the ramp: ${ratio(
      'a boundary 6 texels wide',
    )} on one six texels across against ${ratio(
      'roughness 0.5',
    )} on a crisp one. The cheap alternative to all of it was one command a second rather than one a frame, letting the hold-forward rule cover the gap, which is ${sparse(
      '18000',
    )} for ten minutes. It is the wrong trade and worth stating as one: the gap it leaves holding is exactly the drift tracking exists to remove, so it buys memory back from the feature rather than from its representation.`,
    command: 'node tools/video-bench/run.mjs log',
  };
}

// --- writing a clip ---------------------------------------------------------

function pipeline(video: unknown): Section {
  const rung = (size: string, name: string): string =>
    ms(num(video, ['encode', `${size}, ladder (poster)`, name, 'ms_per_frame']));
  const row = (label: string, name: string): readonly string[] => [
    label,
    rung('720p', name),
    rung('1080p', name),
  ];
  return {
    heading: 'The encoder is the pipeline',
    prose: [
      'A VideoEncoder is asynchronous and holds its own queue, so timing one frame answers nothing. What decides whether a clip export is a wait or an ordeal is sustained throughput with everything in flight at once, measured as a ladder where each rung adds exactly one step to the one below it.',
      'It does not add up, and that is the finding. The encoder handed the same picture with the GPU taken out of the loop measures 4.7 ms a frame at 1080p, against 5.0 for the whole thing: every rung below it runs on threads the encoder is not using. At 1080p with a style that fits in a frame there is nothing worth optimising except the encoder.',
      'Writing the packets into a container rather than binning them costs a tenth of a millisecond. Whatever a muxer costs, it is not per frame.',
    ],
    table: {
      columns: ['ms per frame, poster, export tier', '720p', '1080p'],
      rows: [
        row('decode the frame and upload it', 'decode'),
        row('and the style chain and composite', 'composite'),
        row('and capture the canvas as a frame', 'capture, canvas'),
        row('and encode it', 'encode'),
        row('and write it into an MP4', 'mux'),
      ],
    },
    caveat:
      'Ninety frames of a 1080p30 clip, wall clock, at the export quality tier. The alternative to capturing the canvas, copying the composite into a buffer and rebuilding a frame from the bytes, costs 1.4 ms a frame more at 1080p and needs every row de-padded to undo the 256-byte alignment WebGPU imposes on texture-to-buffer copies.',
    command: 'node tools/video-bench/run.mjs encode',
  };
}

function clipThroughput(video: unknown): Section {
  const endToEnd = (size: string, style: string, key: string): number =>
    num(video, ['encode', `${size}, end to end`, style, key]);
  const row = (style: string): readonly string[] => [
    style,
    `${ms(endToEnd('720p', style, 'ms_per_frame'))} (${endToEnd('720p', style, 'frames_per_s').toFixed(0)} fps)`,
    `${ms(endToEnd('1080p', style, 'ms_per_frame'))} (${endToEnd('1080p', style, 'frames_per_s').toFixed(0)} fps)`,
  ];
  return {
    heading: 'What a clip costs to write, per style',
    prose: [
      'Decode, style, composite, capture, encode and mux, end to end. Two of the three styles write a clip several times faster than it plays. The third is the style-cost table again with an encoder underneath it that never has to wait.',
      'A minute of 1080p through the comic chain is five and a half minutes of work. That is what makes progress and a way to stop part of the feature rather than polish on it.',
    ],
    table: {
      columns: ['end to end', '720p', '1080p'],
      rows: [row('poster'), row('print'), row('comic')],
    },
    command: 'node tools/video-bench/run.mjs encode',
  };
}

function rateControl(video: unknown): Section {
  const rate = (name: string, key: string): number =>
    num(video, ['encode', 'rate control (1080p, poster)', name, key]);
  const row = (label: string, name: string): readonly string[] => [
    label,
    ms(rate(name, 'ms_per_frame')),
    `${(rate(name, 'bytes') / 1e6).toFixed(2)} MB`,
    `${rate(name, 'megabits_per_s').toFixed(1)} Mbit/s`,
  ];
  return {
    heading: 'Rate control is a decision about size, not about speed',
    prose: [
      'A qualitative quality level resolves to a quantizer where the codec supports one, which is constant quality and therefore an unbounded file. It is also the default, so a clip export that says nothing about rate control ships five times the bytes for no time at all.',
      'Asking for the same level as a bitrate is a predictable file and a variable picture. Rotyl asks for very-high as a bitrate, which is about 12 Mbit/s at 1080p and scales with resolution.',
    ],
    table: {
      columns: ['what was asked for', 'ms per frame', 'file', 'rate'],
      rows: [
        row('high, as a quantizer', 'high, quantizer'),
        row('high, as a bitrate', 'high, bitrate'),
        row('very-high, as a bitrate', 'very-high, bitrate'),
        row('12 Mbit/s, stated', '12 Mbit/s'),
      ],
    },
    caveat:
      'Ninety frames of styled 1080p, three seconds. Measured on the styled output rather than on the source, because that is what an export encodes and flat areas compress nothing like film grain does.',
    command: 'node tools/video-bench/run.mjs encode',
  };
}

function encodeColour(video: unknown): Section {
  const worst = (who: string): string =>
    `${num(video, ['encode-colour', who, 'round_trip', 'worst']).toFixed(0)} codes`;
  const median = (who: string): string =>
    `${num(video, ['encode-colour', who, 'round_trip', 'median_abs']).toFixed(0)} codes`;
  return {
    heading: 'The encoder is not what moves colour',
    prose: [
      'Colour had been measured on the way in and never on the way out, which is the direction a clip export depends on. Pixels leave through a canvas, become a video frame, are converted to YCbCr by the encoder and come back through the browser’s own conversion, and every one of those steps can apply a transfer function.',
      'The same sixteen patches, put through the real composite at zero coverage, which returns the source byte for byte, then written out and decoded back. All sixteen come back bit-identical to ffmpeg’s round trip, not merely close: the error is entirely the midtone shift Chrome applies on the 4:2:0 decode path, which was already measured and attributed.',
      'The container is tagged correctly too, which matters for every player that is not this one. So there is no export colour path either; there is the colour path, and this is one more thing that already sits in it.',
    ],
    table: {
      columns: ['sixteen patches, round tripped', 'worst error', 'median'],
      rows: [
        ['through Rotyl’s encoder', worst('ours'), median('ours')],
        [
          'through ffmpeg, same decode path',
          worst('ffmpeg, same decode path'),
          median('ffmpeg, same decode path'),
        ],
      ],
    },
    command: 'node tools/video-bench/run.mjs encode-colour',
  };
}

function containerBytes(bundle: unknown): Section {
  const gzip = (name: string): string => asBytes(num(bundle, ['cases', name, 'gzip']));
  const delta = (name: string): string => asBytes(num(bundle, ['deltas', name]));
  return {
    heading: 'Writing a container costs as much as the application',
    prose: [
      'Measured through Rotyl’s own build, so the answer is what this bundler’s tree shaking actually produces rather than what a standalone one would.',
      `Writing costs ${delta('writing, on top of reading')} gzipped on top of a chunk that already reads, which is the size of the entire application bundle to the tenth of a kilobyte. So the writer is its own dynamic import, fetched by an export and by nothing else, the same treatment the demuxer and the model get.`,
      `A second container to write costs ${delta('a second container to write')}: QuickTime is the same muxer with a different brand list, exactly as it is on the read side. The encoder wrapper is ${delta('the encoder wrapper')} of the writer, and driving the encoder by hand instead would save that and cost five per cent a frame.`,
      'Shipped, there are two consumers of one library and the bundler puts what they share in a chunk of its own, so opening a video costs 8.8 KB more than it did for somebody who never exports one. The alternative arrangements are worse: one chunk makes every video session pay for the writer, and no split at all puts it in the application.',
    ],
    table: {
      columns: ['gzipped', 'size'],
      rows: [
        ['read MP4 and QuickTime', gzip('read MP4 QTFF')],
        ['write MP4, from packets', gzip('write MP4, packets only')],
        ['write MP4, encoding as well', gzip('write MP4')],
        ['read MP4 and QuickTime, and write MP4', gzip('read MP4 QTFF + write MP4')],
      ],
    },
    command: 'node tools/video-bench/bundle-size.mjs',
  };
}

// --- entries ----------------------------------------------------------------

/**
 * Every results file the pages read, as one value rather than as an argument
 * each.
 *
 * Four harnesses now write six files between them, and a positional list of
 * them is a shape where adding a measurement edits three call sites and where
 * two `unknown`s can be swapped without the compiler noticing.
 */
export interface Results {
  readonly style: unknown;
  readonly real: unknown;
  readonly video: unknown;
  readonly tracking: unknown;
  readonly tracked: unknown;
  readonly host: unknown;
  readonly shrink: unknown;
  readonly bundle: unknown;
  readonly log: unknown;
}

export function entries(results: Results): readonly Entry[] {
  const { style, real, video, tracking, tracked, host, shrink, bundle, log } = results;
  return [
    {
      slug: 'the-look',
      results: 'tools/style-bench/results.json',
      title: 'What a style costs, and whether it holds still',
      standfirst:
        'Three style chains timed against one picture, and the temporal measurement that contradicted what everyone assumed about per-frame stylisation.',
      harness: 'tools/style-bench',
      lede: [
        'Everything that decides whether a selection is correct was already built and measured. What was not settled was whether what comes out is worth looking at, and, on video, whether it stays worth looking at while it moves.',
        'Three things were unknown, each capable of forcing a different architecture. One of the three was answered backwards.',
      ],
      hero: {
        name: 'styles',
        caption:
          'One frame through each style at full quality: 119 ms, 1.1 ms and 0.5 ms at 720p respectively.',
      },
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
      slug: 'real-footage',
      results: 'tools/style-bench/results-real.json',
      title: 'What survived a real picture, and what did not',
      standfirst:
        'The three style measurements re-taken against four photographs and two shots of a film, fetched by URL and pinned by hash. One finding reversed sign, and cost a style one of its operators.',
      harness: 'tools/style-bench',
      lede: [
        'Everything on the page before this was measured against a scene drawn by a script, including the finding that decided per-frame stylisation was acceptable at all. This is that page again, with the picture changed and nothing else.',
        'Three things came back. The cost table does not depend on the content, which was expected to and was warned about. The comic chain is as steady on a photograph as it is on a drawing. And the poster chain, which the scene reports as the second steadiest of the three, amplified its input by five on a brick wall.',
        'That third one is why the poster style’s outline is a different operator now than it was when this page was first written. The tables below are taken after that change and say so where the old number is worth keeping.',
      ],
      sections: [
        realInputs(),
        realCost(real),
        realStability(real),
        realOutline(real),
        outlineAttempts(),
        realLightness(real),
      ],
    },
    {
      slug: 'video',
      results: 'tools/video-bench/results.json',
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
      slug: 'the-clip',
      results: 'tools/video-bench/results.json',
      title: 'What writing a clip costs',
      standfirst:
        'The export pipeline timed end to end, the two ways of getting the composite to the encoder, what rate control does to a file, and the probe showing the encoder leaves colour alone.',
      harness: 'tools/video-bench',
      lede: [
        'Export had only ever written one frame. Three things stood between that and a clip, all of them capable of forcing a different design: what an encoded frame costs when everything is in flight at once, what a container writer costs in bytes, and whether the colour contract survives being written back out.',
        'A fourth turned up on the way. A canvas is presented rather than read, so capturing one is a claim about when as much as about what, and being one frame out would be invisible in every timing number here.',
      ],
      sections: [
        pipeline(video),
        clipThroughput(video),
        rateControl(video),
        encodeColour(video),
        containerBytes(bundle),
      ],
    },
    {
      slug: 'tracking',
      results: 'tools/edgetam-export/results.json',
      title: 'What tracking would cost, before building it',
      standfirst:
        'The two graphs a tracker needs, exported and run on the runtime that already ships, and the readback that looked like a bottleneck and is not.',
      harness: 'tools/video-bench, tools/edgetam-export',
      lede: [
        'Tracking does not exist yet. These are the numbers that say what it would cost and what shape it would have to take, taken before writing it rather than after.',
      ],
      sections: [
        trackedFrame(video),
        tracksWhat(tracking),
        pointers(tracking),
        download(video, shrink),
        commandLog(log),
        readback(video),
      ],
    },
    {
      slug: 'tracked-frame',
      results: 'tools/video-bench/results-tracked-frame.json',
      title: 'What a tracked frame costs, now that there is one to time',
      standfirst:
        'The end-to-end figure tracking was designed around, taken end to end for the first time. It is 135 ms rather than the 90 that summing four graphs predicted, and the difference is not a graph.',
      harness: 'tools/video-bench',
      lede: [
        'Every number this project has quoted about tracking was taken before a tracked frame existed: four graphs timed one at a time and added up. That was the honest thing to do and it was published saying so. This is the same question asked of the thing itself.',
        'It needs somewhere to fetch two graphs from, so unlike everything else here it is not part of a run anybody can take without setting one up. What it drives is the product’s own code and not a reimplementation of it, which is the only way the number is about the product.',
      ],
      sections: [trackedCost(tracked), trackedArithmetic(tracked)],
    },
    {
      slug: 'the-host',
      results: 'tools/edgetam-export/host.json',
      title: 'The half of a tracked frame that is not in a graph',
      standfirst:
        'Every transpose, the memory bank and the prompt a tracked frame sends, each run against the reference’s own inputs. Three of them were wrong, and none of the three produced an error.',
      harness: 'tools/edgetam-export',
      lede: [
        'The two graphs a tracker needs were exported and checked against the modules they came from. That leaves the other half of a tracked frame, which is host code: two published graphs either side of the exported pair, the transposes between four sessions, the bank’s layout, and the arithmetic the memory encoder is fed either side of it.',
        'None of that is in a graph and all of it fails silently. A transposed field, a bank that forgets the frame the user pointed at, a mask resampled the wrong way and a prompt that is nearly the right prompt all produce a plausible mask of roughly the right object. So none of it is judged by looking at one.',
      ],
      sections: [hostArithmetic(host), hostMistakes(host), hostEndToEnd(host)],
    },
    {
      slug: 'the-editor',
      results: 'tools/research/measurements.ts',
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
            'Reading the frame is expensive and happens once; answering "which object is under this point" is cheap and happens per click. A click is flat in image size because the model always works at 1024 px square. Only building that input scales with the photograph.',
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
            'Three runtime dependencies, all but the framework code-split, so what a session downloads depends on what it opens. A photograph fetches the application and the fonts and nothing else.',
            'Shaders reach the bundle as strings and this codebase comments them as heavily as its TypeScript, so a build-time transform removes the comments and keeps every newline, which is why adding a third style made the bundle smaller rather than larger.',
          ],
          table: {
            columns: ['gzipped', 'size', 'fetched'],
            rows: [
              ['application', '42.5 KB', 'always'],
              ['subset fonts', '31 KB', 'always'],
              ['inference runtime', '36 KB', 'first object click'],
              ['demuxer', '42 KB', 'first video'],
              ['container writer', '32 KB', 'first clip export'],
              ['saved by stripping shader comments', '17 KB', ''],
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
