import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/*/test/**/*.test.{ts,tsx}',
      'packages/*/test/**/*.test.ts',
      'packages/integrations/*/test/**/*.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
