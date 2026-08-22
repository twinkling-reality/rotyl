interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Environment {
  readonly ASSETS: AssetFetcher;
}

/**
 * Rotyl is a static application. The worker exists so the validated Vite
 * output has an explicit Cloudflare entry point; matching files are served by
 * the asset layer before this fallback runs.
 */
export default {
  fetch(request: Request, environment: Environment): Promise<Response> {
    return environment.ASSETS.fetch(request);
  },
};
