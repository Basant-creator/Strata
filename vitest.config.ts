import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Many tests build a git repository and a store, and take 1 to 3 seconds alone. With the
    // files run in parallel, the default 5 seconds timed out two to four of them on each run
    // (measured 2026-11-13, on the committed code too), a different set each time; none
    // failed alone or with this limit.
    testTimeout: 30_000,
  },
});
