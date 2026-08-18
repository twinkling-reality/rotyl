import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5180',
    // Real Chrome, not the bundled Chromium.
    //
    // Bundled Chromium headless has no GPU adapter at all, and enabling WebGPU
    // there falls back to SwiftShader. A CPU rasteriser that reports success
    // while producing different pixels. A GPU test that silently validates
    // against the wrong renderer is worse than no GPU test.
    channel: 'chrome',
  },
  webServer: {
    command: 'pnpm dev --port 5180 --strictPort',
    url: 'http://localhost:5180',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
