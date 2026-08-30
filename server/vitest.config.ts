import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // mongodb-memory-server downloads/boots a real mongod; give it room and
    // keep suites serial so they share one instance instead of racing for it.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Thin process entry points: they only read argv/env and call into the
      // covered modules below them. Everything with logic is covered.
      exclude: ['src/index.ts', 'src/cli/index.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
