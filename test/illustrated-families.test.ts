import { describe, expect, it } from 'vitest';
import { readField } from '../src/core/illustrated/request.ts';
import {
  FAL_FLUX2_FLEX_EDIT,
  FAL_GROK_EDIT,
  FAL_NANO_PRO_EDIT,
  FAL_QWEN_EDIT,
  FAL_SEEDREAM5_LITE_EDIT,
  FAL_SEEDREAM5_PRO_EDIT,
  runFalFlux2FlexEdit,
  runFalGrokEdit,
  runFalNanoProEdit,
  runFalQwenEdit,
  runFalSeedream5LiteEdit,
  runFalSeedream5ProEdit,
  type FalKontextJob,
  type PhotomakerImage,
} from '../worker/illustrated.ts';

function requestHref(url: Parameters<typeof fetch>[0]): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  if (url instanceof Request) return url.url;
  return '';
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

/** Answers the upload, queue, status, result and download legs for one model. */
function falStub(model: string, seen: { body?: unknown; calls: string[] }): typeof fetch {
  return async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = requestHref(url);
    seen.calls.push(`${init?.method ?? 'GET'} ${href}`);
    if (href === 'https://rest.fal.ai/storage/upload/initiate') {
      return new Response(
        JSON.stringify({
          upload_url: 'https://fal.example/upload/1',
          file_url: 'https://fal.example/file/1',
        }),
        { status: 200 },
      );
    }
    if (href.startsWith('https://fal.example/upload/')) return new Response(null, { status: 200 });
    if (href === `https://queue.fal.run/${model}`) {
      seen.body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      return new Response(
        JSON.stringify({
          request_id: 'job-f',
          status_url: 'https://queue.fal.run/stub/requests/job-f/status',
          response_url: 'https://queue.fal.run/stub/requests/job-f',
        }),
        { status: 200 },
      );
    }
    if (href === 'https://queue.fal.run/stub/requests/job-f/status') {
      return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
    }
    if (href === 'https://queue.fal.run/stub/requests/job-f') {
      return new Response(
        JSON.stringify({ images: [{ url: 'https://fal.example/out.jpg', content_type: 'image/jpeg' }] }),
        { status: 200 },
      );
    }
    if (href === 'https://fal.example/out.jpg') {
      return new Response(JPEG, { headers: { 'Content-Type': 'image/jpeg' } });
    }
    return new Response('unexpected', { status: 500 });
  };
}

interface Case {
  readonly name: string;
  readonly model: string;
  readonly run: (job: FalKontextJob) => Promise<PhotomakerImage[]>;
  /** Payload fields Fal's published schema requires this family to be sent. */
  readonly expected: Readonly<Record<string, unknown>>;
}

const CASES: readonly Case[] = [
  {
    name: 'Seedream 5 Pro',
    model: FAL_SEEDREAM5_PRO_EDIT,
    run: runFalSeedream5ProEdit,
    expected: { image_size: 'auto_2K', num_images: 1, output_format: 'jpeg' },
  },
  {
    name: 'Seedream 5 Lite',
    model: FAL_SEEDREAM5_LITE_EDIT,
    run: runFalSeedream5LiteEdit,
    expected: { image_size: 'auto_2K', num_images: 1, max_images: 1 },
  },
  {
    name: 'Nano Banana Pro',
    model: FAL_NANO_PRO_EDIT,
    run: runFalNanoProEdit,
    expected: { resolution: '1K', aspect_ratio: 'auto', output_format: 'jpeg', limit_generations: true },
  },
  {
    name: 'Qwen image edit',
    model: FAL_QWEN_EDIT,
    run: runFalQwenEdit,
    expected: { num_images: 1, output_format: 'jpeg', guidance_scale: 4.5 },
  },
  {
    name: 'Grok Imagine',
    model: FAL_GROK_EDIT,
    run: runFalGrokEdit,
    expected: { resolution: '2k', aspect_ratio: 'auto', num_images: 1, output_format: 'jpeg' },
  },
  {
    name: 'FLUX.2 Flex',
    model: FAL_FLUX2_FLEX_EDIT,
    run: runFalFlux2FlexEdit,
    expected: { image_size: 'auto', num_inference_steps: 28, guidance_scale: 3.5, output_format: 'jpeg' },
  },
];

describe('illustrated edit families past Seedream 4.5', () => {
  for (const entry of CASES) {
    it(`uploads the still and edits it on ${entry.name}`, async () => {
      const seen: { body?: unknown; calls: string[] } = { calls: [] };
      const images = await entry.run({
        still: JPEG,
        mime: 'image/jpeg',
        prompt: 'Redraw this photograph as a cel-animation illustration.',
        host: { FAL_KEY: 'test-key', fetch: falStub(entry.model, seen) },
      });
      expect(images).toHaveLength(1);
      expect(seen.calls).toContain(`POST https://queue.fal.run/${entry.model}`);
      // The still goes up as an uploaded asset, never as a data URI.
      expect(readField(seen.body, 'image_urls')).toEqual(['https://fal.example/file/1']);
      for (const [field, value] of Object.entries(entry.expected)) {
        expect(readField(seen.body, field)).toEqual(value);
      }
      // Status and result are read back with the URLs Fal named, as GETs.
      const polled = seen.calls.filter((call) => call.includes('/requests/job-f'));
      expect(polled.every((call) => call.startsWith('GET '))).toBe(true);
    });
  }

  it('refuses to run when the host has no key', async () => {
    for (const entry of CASES) {
      await expect(
        entry.run({
          still: JPEG,
          mime: 'image/jpeg',
          prompt: 'Redraw this photograph.',
          host: { FAL_KEY: '' },
        }),
      ).rejects.toThrow(/has not configured/);
    }
  });

  it('keeps every new family off the product POST path', async () => {
    const product = await import('../worker/illustrated.ts');
    expect(product.FAL_MODEL).toBe('fal-ai/photomaker');
    for (const entry of CASES) {
      expect(entry.model).not.toBe(product.FAL_MODEL);
    }
  });
});
