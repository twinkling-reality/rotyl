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
    // Judged to clear the bar on the six sheets the product path produces at
    // full size. The limits that survive that judgement are in the ledger.
    expect(ILLUSTRATED_TERMS.publishReady).toBe(true);
    expect(ILLUSTRATED_TERMS.privacy.length).toBeGreaterThan(40);
    expect(ILLUSTRATED_TERMS.cost.length).toBeGreaterThan(20);
    expect(ILLUSTRATED_TERMS.latency.length).toBeGreaterThan(20);
    expect(ILLUSTRATED_TERMS.retention.length).toBeGreaterThan(20);
    expect(ILLUSTRATED_TERMS.path).toMatch(/Nano Banana Pro/);
    // A bigger picture leaves the machine at v4, so the cost and the wait the
    // terms quote have to be the ones that were measured at that size.
    expect(ILLUSTRATED_TERMS.cost).toMatch(/thirty cents/);
    expect(ILLUSTRATED_TERMS.latency).toMatch(/forty to a hundred seconds/);
    // Two models see the still now, so the privacy sentence has to say so.
    expect(ILLUSTRATED_TERMS.privacy).toMatch(/two models see it/);
  });

  it('accepts only a current, explicit consent', () => {
    expect(consentMatches({ version: ILLUSTRATED_TERMS_VERSION, accepted: true })).toBe(true);
    expect(consentMatches({ version: ILLUSTRATED_TERMS_VERSION, accepted: false })).toBe(false);
    expect(consentMatches({ version: 'illustrated-v0', accepted: true })).toBe(false);
    expect(consentMatches({})).toBe(false);
    expect(consentMatches(null)).toBe(false);
  });
});
