import { describe, expect, it } from 'vitest';
import worker from '../worker/index.ts';

const responseFor = (contentType: string, status = 200): Promise<Response> =>
  Promise.resolve(
    new Response('body', {
      status,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=0, must-revalidate' },
    }),
  );

const fetchFrom = (
  pathname: string,
  contentType: string,
  status = 200,
): { response: Promise<Response>; requestedPaths: string[] } => {
  const requestedPaths: string[] = [];
  const response = worker.fetch(new Request(`https://rotyl.example${pathname}`), {
    ASSETS: {
      fetch: (request) => {
        requestedPaths.push(new URL(request.url).pathname);
        return responseFor(contentType, status);
      },
    },
  });
  return { response, requestedPaths };
};

describe('production response policy', () => {
  it('keeps versioned model bytes immutable and identifies their transport', async () => {
    const { response: pendingResponse, requestedPaths } = fetchFrom(
      '/models/edgetam/edgetam-v1/parameters.json.gz',
      'application/json',
    );
    const response = await pendingResponse;

    expect(requestedPaths).toEqual(['/__rotyl/models/edgetam/edgetam-v1/parameters.json.gz']);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('Content-Type')).toBe('application/gzip');
  });

  it('keeps content-hashed code immutable', async () => {
    const { response: pendingResponse } = fetchFrom('/assets/index-a1b2c3.js', 'text/javascript');
    const response = await pendingResponse;
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('revalidates HTML and applies the security policy', async () => {
    const { response: pendingResponse, requestedPaths } = fetchFrom('/', 'text/html; charset=utf-8');
    const response = await pendingResponse;

    expect(requestedPaths).toEqual(['/__rotyl/index.html']);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('preserves the asset binding status', async () => {
    const { response: pendingResponse } = fetchFrom('/missing', 'text/plain', 404);
    const response = await pendingResponse;
    expect(response.status).toBe(404);
  });
});
