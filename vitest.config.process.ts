import { defineConfig } from 'vitest/config';

// Spawns real application processes from dist/ (see `test:process`, which builds first).
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    include: ['test/**/*.process.ts'],
    testTimeout: 240_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
