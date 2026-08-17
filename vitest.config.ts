import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // A fork per test file, so each gets its own Dawn instance and its own
    // GPU device, released before that process exits (see test/setup.ts).
    // Sharing one device across files was tried and is markedly worse: Dawn
    // does not tolerate its lifetime spanning vitest's module resets.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
