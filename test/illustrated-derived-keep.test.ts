import { describe, expect, it } from 'vitest';
import { readField } from '../src/core/illustrated/request.ts';
import { FAL_VISION, describeIllustratedKeep } from '../worker/illustrated.ts';
import { KEEP_INSTRUCTION, buildIllustratedPrompt } from '../src/core/illustrated/prompt.ts';

function requestHref(url: Parameters<typeof fetch>[0]): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  if (url instanceof Request) return url.url;
  return '';
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function visionStub(seen: { body?: unknown; calls: string[] }, output: string): typeof fetch {
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
    if (href === `https://queue.fal.run/${FAL_VISION}`) {
      seen.body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      return new Response(
        JSON.stringify({
          request_id: 'job-v',
          status_url: 'https://queue.fal.run/stub/requests/job-v/status',
          response_url: 'https://queue.fal.run/stub/requests/job-v',
        }),
        { status: 200 },
      );
    }
    if (href === 'https://queue.fal.run/stub/requests/job-v/status') {
      return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
    }
    if (href === 'https://queue.fal.run/stub/requests/job-v') {
      return new Response(JSON.stringify({ output }), { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
  };
}

describe('keep list derived from the still', () => {
  it('uploads the still and asks the vision model to describe it', async () => {
    const seen: { body?: unknown; calls: string[] } = { calls: [] };
    const keep = await describeIllustratedKeep({
      still: JPEG,
      mime: 'image/jpeg',
      prompt: '',
      host: { FAL_KEY: 'test-key', fetch: visionStub(seen, '  a magenta cardigan and a gold headpiece  ') },
    });
    expect(keep).toBe('a magenta cardigan and a gold headpiece');
    expect(seen.calls).toContain(`POST https://queue.fal.run/${FAL_VISION}`);
    expect(readField(seen.body, 'image_urls')).toEqual(['https://fal.example/file/1']);
    expect(readField(seen.body, 'prompt')).toBe(KEEP_INSTRUCTION);
    // Deterministic, so the same upload does not get a different keep list each run.
    expect(readField(seen.body, 'temperature')).toBe(0);
  });

  it('refuses an empty description rather than sending a bare prompt', async () => {
    const seen: { body?: unknown; calls: string[] } = { calls: [] };
    await expect(
      describeIllustratedKeep({
        still: JPEG,
        mime: 'image/jpeg',
        prompt: '',
        host: { FAL_KEY: 'test-key', fetch: visionStub(seen, '   ') },
      }),
    ).rejects.toThrow(/without a description/);
  });

  it('refuses to run when the host has no key', async () => {
    await expect(
      describeIllustratedKeep({ still: JPEG, mime: 'image/jpeg', prompt: '', host: { FAL_KEY: '' } }),
    ).rejects.toThrow(/has not configured/);
  });

  it('asks only for what is in the frame', () => {
    expect(KEEP_INSTRUCTION).toMatch(/skin tone as it appears/);
    expect(KEEP_INSTRUCTION).toMatch(/headwear and which way it faces/);
    expect(KEEP_INSTRUCTION).toMatch(/lettering/);
    expect(KEEP_INSTRUCTION).toMatch(/Do not guess/);
  });

  it('builds a prompt that carries the derived keep list', () => {
    const built = buildIllustratedPrompt('a grey crew-neck shirt and a leopard-print headband');
    expect(built).toMatch(/cel-animation illustration/);
    expect(built).toMatch(/leopard-print headband/);
    expect(built).toMatch(/exactly as photographed/);
  });

  it('falls back to the bare draw request when the still yields nothing', () => {
    const built = buildIllustratedPrompt('   ');
    expect(built).toMatch(/cel-animation illustration/);
    expect(built).not.toMatch(/exactly as photographed/);
  });

  it('names no specific photograph, so it works on any upload', () => {
    for (const hardcoded of ['magenta', 'leopard', 'turban', 'snapback', 'portrait-']) {
      expect(KEEP_INSTRUCTION).not.toContain(hardcoded);
      expect(buildIllustratedPrompt('')).not.toContain(hardcoded);
    }
  });
});
