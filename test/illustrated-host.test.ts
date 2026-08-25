import { describe, expect, it } from 'vitest';
import { handleIllustrated } from '../worker/illustrated.ts';
import { readField } from '../src/core/illustrated/request.ts';
import { ILLUSTRATED_TERMS_VERSION } from '../src/core/illustrated/terms.ts';

function post(body: unknown, host: Parameters<typeof handleIllustrated>[1]): Promise<Response> {
  return handleIllustrated(
    new Request('http://rotyl.local/api/illustrated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    host,
  );
}

describe('illustrated host', () => {
  it('reprints the terms without calling Fal on GET', async () => {
    let called = false;
    const response = await handleIllustrated(new Request('http://rotyl.local/api/illustrated'), {
      FAL_KEY: 'test-key',
      fetch: async () => {
        called = true;
        return new Response('no');
      },
    });
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(readField(body, 'available')).toBe(true);
    expect(readField(readField(body, 'terms'), 'version')).toBe(ILLUSTRATED_TERMS_VERSION);
    expect(called).toBe(false);
  });

  it('does not send a still to Fal without current consent', async () => {
    let called = false;
    const response = await post(
      { image: { mime: 'image/jpeg', data: 'aaaa' } },
      {
        FAL_KEY: 'test-key',
        fetch: async () => {
          called = true;
          return new Response('no');
        },
      },
    );
    expect(response.status).toBe(400);
    expect(called).toBe(false);
    const error = readField(await response.json(), 'error');
    expect(typeof error === 'string' ? error : '').toMatch(/terms/);
  });

  it('refuses a consented still when the host has no key', async () => {
    let called = false;
    const response = await post(
      {
        consent: { version: ILLUSTRATED_TERMS_VERSION, accepted: true },
        image: { mime: 'image/jpeg', data: 'aaaa' },
      },
      {
        fetch: async () => {
          called = true;
          return new Response('no');
        },
      },
    );
    expect(response.status).toBe(503);
    expect(called).toBe(false);
  });
});
