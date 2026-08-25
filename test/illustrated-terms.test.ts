import { describe, expect, it } from 'vitest';
import {
  consentMatches,
  ILLUSTRATED_TERMS,
  ILLUSTRATED_TERMS_VERSION,
} from '../src/core/illustrated/terms.ts';

describe('illustrated terms', () => {
  it('states privacy, cost, latency and retention on the current version', () => {
    expect(ILLUSTRATED_TERMS.version).toBe(ILLUSTRATED_TERMS_VERSION);
    expect(ILLUSTRATED_TERMS.stillsOnly).toBe(true);
    expect(ILLUSTRATED_TERMS.publishReady).toBe(false);
    expect(ILLUSTRATED_TERMS.privacy.length).toBeGreaterThan(40);
    expect(ILLUSTRATED_TERMS.cost.length).toBeGreaterThan(20);
    expect(ILLUSTRATED_TERMS.latency.length).toBeGreaterThan(20);
    expect(ILLUSTRATED_TERMS.retention.length).toBeGreaterThan(20);
    expect(ILLUSTRATED_TERMS.path).toMatch(/PhotoMaker/);
  });

  it('accepts only a current, explicit consent', () => {
    expect(consentMatches({ version: ILLUSTRATED_TERMS_VERSION, accepted: true })).toBe(true);
    expect(consentMatches({ version: ILLUSTRATED_TERMS_VERSION, accepted: false })).toBe(false);
    expect(consentMatches({ version: 'illustrated-v0', accepted: true })).toBe(false);
    expect(consentMatches({})).toBe(false);
    expect(consentMatches(null)).toBe(false);
  });
});
