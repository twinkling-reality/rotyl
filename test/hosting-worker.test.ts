import { describe, expect, it } from 'vitest';
import worker from '../worker/index.ts';

const responseFor = (contentType: string, status = 200): Promise<Response> =>
  Promise.resolve(
    new Response('body', {
      status,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=0, must-revalidate' },
    }),
  );

const fetchFrom = (pathname: string, contentType: string, status = 200): Promise<Response> =>
  worker.fetch(new Request(`https://rotyl.example${pathname}`), {
    ASSETS: { fetch: () => responseFor(contentType, status) },
  });

describe('production response policy', () => {
  it('keeps versioned model bytes immutable and identifies their transport', async () => {
    const response = await fetchFrom('/models/edgetam/edgetam-v1/parameters.json.gz', 'application/json');

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('Content-Type')).toBe('application/gzip');
  });

  it('keeps content-hashed code immutable', async () => {
    const response = await fetchFrom('/assets/index-a1b2c3.js', 'text/javascript');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('revalidates HTML and applies the security policy', async () => {
    const response = await fetchFrom('/', 'text/html; charset=utf-8');

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('preserves the asset binding status', async () => {
    const response = await fetchFrom('/missing', 'text/plain', 404);
    expect(response.status).toBe(404);
  });
});
