import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    env: { LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent' },
  },
});
