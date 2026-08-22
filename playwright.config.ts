import { defineConfig } from '@playwright/test';

const deployed = process.env.ROTYL_E2E_BASE_URL?.trim();
const siteAuthorization = process.env.ROTYL_SITE_AUTHORIZATION?.trim();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: deployed || 'http://localhost:5180',
    ...(siteAuthorization ? { extraHTTPHeaders: { 'OAI-Sites-Authorization': siteAuthorization } } : {}),
    // Real Chrome, not the bundled Chromium.
    //
    // Bundled Chromium headless has no GPU adapter at all, and enabling WebGPU
    // there falls back to SwiftShader. A CPU rasteriser that reports success
    // while producing different pixels. A GPU test that silently validates
    // against the wrong renderer is worse than no GPU test.
    channel: 'chrome',
  },
  ...(deployed
    ? {}
    : {
        webServer: {
          command: 'pnpm dev --port 5180 --strictPort',
          url: 'http://localhost:5180',
          reuseExistingServer: true,
          timeout: 60_000,
        },
      }),
});
