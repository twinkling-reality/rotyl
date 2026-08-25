/**
 * A stored ZIP of one file, for PhotoMaker's identity archive.
 *
 * PhotoMaker wants a zip of identity stills. This product sends one JPEG. A
 * dependency for that would be the wrong size, so the archive is written here
 * with STORE compression and a textbook CRC-32.
 */

const CRC_TABLE = makeCrcTable();

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let entry = index;
    for (let bit = 0; bit < 8; bit++) {
      entry = entry & 1 ? 0xedb88320 ^ (entry >>> 1) : entry >>> 1;
    }
    table[index] = entry >>> 0;
  }
  return table;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** One stored file named `name`, contents `data`. */
function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

export function zipStore(name: string, data: Uint8Array): Uint8Array {
  const filename = asciiBytes(name);
  const crc = crc32(data);
  const size = u32(data.length);
  const local = concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(crc),
    size,
    size,
    u16(filename.length),
    u16(0),
    filename,
    data,
  ]);
  const central = concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(crc),
    size,
    size,
    u16(filename.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    filename,
  ]);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return concat([local, central, end]);
}
