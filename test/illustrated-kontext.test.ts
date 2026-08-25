import { describe, expect, it } from 'vitest';
import { readField } from '../src/core/illustrated/request.ts';
import {
  FAL_FLUX2_EDIT,
  FAL_KONTEXT_PRO,
  handleIllustrated,
  runFalFlux2Edit,
  runFalKontext,
} from '../worker/illustrated.ts';
import { ILLUSTRATED_TERMS_VERSION } from '../src/core/illustrated/terms.ts';

function requestHref(url: Parameters<typeof fetch>[0]): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  if (url instanceof Request) return url.url;
  return '';
}

describe('illustrated kontext eval helper', () => {
  it('does not change the product PhotoMaker POST', async () => {
    const calls: string[] = [];
    await handleIllustrated(
      new Request('http://rotyl.local/api/illustrated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consent: { version: ILLUSTRATED_TERMS_VERSION, accepted: true },
          image: { mime: 'image/jpeg', data: 'aaaa' },
        }),
      }),
      {
        FAL_KEY: 'test-key',
        fetch: async (url, init) => {
          const href = requestHref(url);
          calls.push(`${init?.method ?? 'GET'} ${href}`);
          if (href === 'https://rest.fal.ai/storage/upload/initiate') {
            return new Response(
              JSON.stringify({
                upload_url: 'https://fal.example/upload/1',
                file_url: 'https://fal.example/file/1',
              }),
              { status: 200 },
            );
          }
          if (href.startsWith('https://fal.example/upload/')) {
            return new Response(null, { status: 200 });
          }
          if (href === 'https://queue.fal.run/fal-ai/photomaker') {
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
            return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
              headers: { 'Content-Type': 'image/jpeg' },
            });
          }
          return new Response('unexpected', { status: 500 });
        },
      },
    );
    expect(calls.some((entry) => entry.includes('flux-pro/kontext'))).toBe(false);
    expect(calls).toContain('POST https://queue.fal.run/fal-ai/photomaker');
  });

  it('uploads the still and edits it on Kontext', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const calls: string[] = [];
    const images = await runFalKontext({
      still: jpeg,
      mime: 'image/jpeg',
      prompt: 'Redraw this photograph as a cel-animation illustration.',
      host: {
        FAL_KEY: 'test-key',
        fetch: async (url, init) => {
          const href = requestHref(url);
          calls.push(`${init?.method ?? 'GET'} ${href}`);
          if (href === 'https://rest.fal.ai/storage/upload/initiate') {
            return new Response(
              JSON.stringify({
                upload_url: 'https://fal.example/upload/1',
                file_url: 'https://fal.example/file/1',
              }),
              { status: 200 },
            );
          }
          if (href.startsWith('https://fal.example/upload/')) {
            return new Response(null, { status: 200 });
          }
          if (href === `https://queue.fal.run/${FAL_KONTEXT_PRO}`) {
            const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
            expect(readField(body, 'image_url')).toBe('https://fal.example/file/1');
            expect(readField(body, 'prompt')).toMatch(/cel-animation/);
            expect(readField(body, 'image_archive_url')).toBeUndefined();
            return new Response(
              JSON.stringify({
                request_id: 'job-k',
                status_url: 'https://queue.fal.run/fal-ai/flux-pro/requests/job-k/status',
                response_url: 'https://queue.fal.run/fal-ai/flux-pro/requests/job-k',
              }),
              { status: 200 },
            );
          }
          if (href === 'https://queue.fal.run/fal-ai/flux-pro/requests/job-k/status') {
            return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
          }
          if (href === 'https://queue.fal.run/fal-ai/flux-pro/requests/job-k') {
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
    });
    expect(images).toHaveLength(1);
    expect(calls).toContain(`POST https://queue.fal.run/${FAL_KONTEXT_PRO}`);
    expect(calls.filter((entry) => entry.includes('/status'))[0]?.startsWith('GET ')).toBe(true);
  });

  it('edits the still on FLUX.2 Pro with image_urls', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const images = await runFalFlux2Edit({
      still: jpeg,
      mime: 'image/jpeg',
      prompt: 'Redraw this photograph as a cel-animation illustration.',
      host: {
        FAL_KEY: 'test-key',
        fetch: async (url, init) => {
          const href = requestHref(url);
          if (href === 'https://rest.fal.ai/storage/upload/initiate') {
            return new Response(
              JSON.stringify({
                upload_url: 'https://fal.example/upload/1',
                file_url: 'https://fal.example/file/1',
              }),
              { status: 200 },
            );
          }
          if (href.startsWith('https://fal.example/upload/')) {
            return new Response(null, { status: 200 });
          }
          if (href === `https://queue.fal.run/${FAL_FLUX2_EDIT}`) {
            const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
            expect(readField(body, 'image_urls')).toEqual(['https://fal.example/file/1']);
            expect(readField(body, 'image_size')).toBe('auto');
            return new Response(
              JSON.stringify({
                request_id: 'job-2',
                status_url: 'https://queue.fal.run/fal-ai/flux-2-pro/requests/job-2/status',
                response_url: 'https://queue.fal.run/fal-ai/flux-2-pro/requests/job-2',
              }),
              { status: 200 },
            );
          }
          if (href === 'https://queue.fal.run/fal-ai/flux-2-pro/requests/job-2/status') {
            return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
          }
          if (href === 'https://queue.fal.run/fal-ai/flux-2-pro/requests/job-2') {
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
    });
    expect(images).toHaveLength(1);
  });
});
