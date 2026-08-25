import { describe, expect, it } from 'vitest';
import { crc32, zipStore } from '../src/core/illustrated/zip.ts';

describe('illustrated zip', () => {
  it('matches the textbook CRC-32 of 123456789', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a stored archive PhotoMaker can be handed', () => {
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
    const zip = zipStore('id.jpg', payload);
    const named = zip.subarray(30, 36);
    expect(String.fromCharCode(...named)).toBe('id.jpg');
    expect(zip.subarray(36, 36 + payload.length)).toEqual(payload);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip.length).toBeGreaterThan(payload.length + 60);
  });
});
