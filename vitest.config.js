import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    reporters: 'default',
    coverage: {
      enabled: false,
      include: [
        'app/scripts/scoring.js',
        'app/scripts/constants.js',
        'infrastructure/lambdas/sync/scoring.js',
      ],
    },
  },
});
