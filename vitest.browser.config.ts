import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { dawnTestFiles } from './tools/ci/dawn-files.mjs';

const entry = path.resolve('.scratch/browser-dawn.test.ts');
mkdirSync(path.dirname(entry), { recursive: true });
writeFileSync(
  entry,
  `${dawnTestFiles()
    .map((file) => `import ${JSON.stringify(`../${path.relative(process.cwd(), file)}`)};`)
    .join('\n')}\n`,
);

export default defineConfig({
  plugins: [
    {
      name: 'browser-gpu-harness',
      enforce: 'pre',
      resolveId(source) {
        if (source === './gpu-harness.ts') return path.resolve('test/browser-gpu-harness.ts');
        return undefined;
      },
    },
  ],
  test: {
    include: [entry],
    setupFiles: ['test/setup.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { channel: 'chrome' } }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
