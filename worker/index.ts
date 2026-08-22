interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Environment {
  readonly ASSETS: AssetFetcher;
}

/**
 * Rotyl is a static application, but its cache boundary is part of the model
 * release contract. Sites serves a matching static path before its worker, so
 * the deployable files live under an internal binding path. Public requests do
 * not match a static file and reach this worker, which maps them to that path.
 */
export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const html = pathname === '/' || pathname.endsWith('.html');
    const assetPath = pathname === '/' ? '/index.html.page' : `${pathname}${html ? '.page' : ''}`;
    url.pathname = `/__rotyl${assetPath}`;

    const response = await environment.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(response.headers);

    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');

    if (pathname.startsWith('/models/edgetam/edgetam-v1/') || pathname.startsWith('/assets/')) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (html) {
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
      headers.set('Content-Type', 'text/html; charset=utf-8');
    }

    if (pathname.endsWith('.gz')) headers.set('Content-Type', 'application/gzip');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
