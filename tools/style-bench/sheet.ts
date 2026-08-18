// Tiling renders into one picture, so a comparison is a comparison rather than
// two files a reader has to hold in their head.
//
// Shared by the control sweep, which tiles one style across a grid of its own
// settings, and by the figures the research pages carry, which tile several
// styles across the same frame.

/** Box-downsample by two, in the encoded values, which is what a contact sheet is. */
export function halve(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const w = width >> 1;
  const h = height >> 1;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const at = (dx: number, dy: number): number => rgba[((y * 2 + dy) * width + x * 2 + dx) * 4 + c] ?? 0;
        out[(y * w + x) * 3 + c] = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) >> 2;
      }
    }
  }
  return out;
}

export interface Sheet {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

/**
 * Lay tiles of one size out in a grid, row by row, with a hairline between.
 *
 * The gutter is mid grey rather than white because one of the things being
 * compared is a print style on warm paper, and a white gutter against it is not
 * a gutter. Two pixels is enough to say "these are four pictures" and not
 * enough to be a design element.
 */
export function tile(
  tiles: readonly Uint8Array[],
  tileWidth: number,
  tileHeight: number,
  columns: number,
  gutter = 2,
): Sheet {
  const rows = Math.ceil(tiles.length / columns);
  const width = tileWidth * columns + gutter * (columns - 1);
  const height = tileHeight * rows + gutter * (rows - 1);
  const rgb = new Uint8Array(width * height * 3).fill(0xd4);

  for (const [index, source] of tiles.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    for (let y = 0; y < tileHeight; y++) {
      const from = y * tileWidth * 3;
      const to = ((row * (tileHeight + gutter) + y) * width + column * (tileWidth + gutter)) * 3;
      rgb.set(source.subarray(from, from + tileWidth * 3), to);
    }
  }

  return { width, height, rgb };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In chunks: String.fromCharCode with a few million arguments overflows the
  // call stack, and it is the same string either way.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
