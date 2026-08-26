import { describe, expect, it } from 'vitest';
import { illustratedStatus, readIllustratedJob } from '../src/core/illustrated/request.ts';
import { ILLUSTRATED_TERMS_VERSION } from '../src/core/illustrated/terms.ts';

const still = {
  mime: 'image/jpeg',
  data: 'aaaa',
};

describe('illustrated job request', () => {
  it('refuses a still that has not accepted the current terms', () => {
    expect(readIllustratedJob({ image: still }).ok).toBe(false);
    expect(
      readIllustratedJob({
        consent: { version: 'illustrated-v0', accepted: true },
        image: still,
      }).ok,
    ).toBe(false);
    expect(
      readIllustratedJob({
        consent: { version: ILLUSTRATED_TERMS_VERSION, accepted: false },
        image: still,
      }).ok,
    ).toBe(false);
  });

  it('accepts a JPEG or PNG with the current consent', () => {
    const read = readIllustratedJob({
      consent: { version: ILLUSTRATED_TERMS_VERSION, accepted: true },
      image: still,
    });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.image.mime).toBe('image/jpeg');
  });

  it('says the host is closed when no key is configured', () => {
    const status = illustratedStatus(false);
    expect(status.available).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.reason).toMatch(/not configured/);
  });
});
