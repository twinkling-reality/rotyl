import { describe, expect, it } from 'vitest';
import { handleIllustrated } from '../worker/illustrated.ts';
import { readField } from '../src/core/illustrated/request.ts';
import { ILLUSTRATED_TERMS_VERSION } from '../src/core/illustrated/terms.ts';

function requestHref(url: Parameters<typeof fetch>[0]): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  if (url instanceof Request) return url.url;
  return '';
}

function headerValue(headers: HeadersInit | undefined, name: string): unknown {
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find((entry) => entry[0].toLowerCase() === name.toLowerCase());
    return found?.[1];
  }
  return headers && typeof headers === 'object' ? Reflect.get(headers, name) : undefined;
}

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

  it('sends a consented still through PhotoMaker and returns the layer', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const calls: string[] = [];
    const response = await post(
      {
        consent: { version: ILLUSTRATED_TERMS_VERSION, accepted: true },
        image: { mime: 'image/jpeg', data: 'aaaa' },
      },
      {
        FAL_KEY: 'test-key',
        fetch: async (url, init) => {
          const href = requestHref(url);
          calls.push(`${init?.method ?? 'GET'} ${href}`);
          if (href === 'https://rest.fal.ai/storage/upload/initiate') {
            const name = calls.filter((entry) => entry.includes('upload/initiate')).length;
            return new Response(
              JSON.stringify({
                upload_url: `https://fal.example/upload/${String(name)}`,
                file_url: `https://fal.example/file/${String(name)}`,
              }),
              { status: 200 },
            );
          }
          if (href.startsWith('https://fal.example/upload/')) {
            return new Response(null, { status: 200 });
          }
          if (href === 'https://queue.fal.run/fal-ai/photomaker') {
            expect(headerValue(init?.headers, 'Authorization')).toBe('Key test-key');
            expect(headerValue(init?.headers, 'X-Fal-Store-IO')).toBe('0');
            const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
            expect(readField(body, 'base_pipeline')).toBe('photomaker-style');
            expect(readField(body, 'style')).toBe('(No style)');
            expect(readField(body, 'num_inference_steps')).toBe(100);
            expect(readField(body, 'style_strength')).toBe(40);
            expect(String(readField(body, 'prompt'))).toContain('img');
            expect(String(readField(body, 'image_archive_url'))).toMatch(/^https:\/\/fal\.example\/file\//);
            expect(String(readField(body, 'initial_image_url'))).toMatch(/^https:\/\/fal\.example\/file\//);
            return new Response(JSON.stringify({ request_id: 'job-1' }), { status: 200 });
          }
          if (href.endsWith('/requests/job-1/status')) {
            return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
          }
          if (href.endsWith('/requests/job-1')) {
            return new Response(
              JSON.stringify({
                images: [{ url: 'https://fal.example/out.jpg', content_type: 'image/jpeg' }],
              }),
              { status: 200 },
            );
          }
          if (href === 'https://fal.example/out.jpg') {
            return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
          }
          return new Response('unexpected', { status: 500 });
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
    expect(calls).toContain('POST https://queue.fal.run/fal-ai/photomaker');
    expect(calls.filter((entry) => entry === 'POST https://rest.fal.ai/storage/upload/initiate')).toHaveLength(2);
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
