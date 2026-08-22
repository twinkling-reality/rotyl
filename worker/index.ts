interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Environment {
  readonly ASSETS: AssetFetcher;
}

/**
 * Rotyl is a static application, but its cache boundary is part of the model
 * release contract. Sites does not apply a Pages `_headers` file, so every
 * response runs through this worker before the asset binding serves it.
 */
export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const response = await environment.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    const pathname = new URL(request.url).pathname;

    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');

    if (pathname.startsWith('/models/edgetam/edgetam-v1/') || pathname.startsWith('/assets/')) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (headers.get('Content-Type')?.startsWith('text/html')) {
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    }

    if (pathname.endsWith('.gz')) headers.set('Content-Type', 'application/gzip');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
