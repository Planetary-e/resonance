import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/relay/src/__tests__/v03-completion.integration.test.ts'],
    setupFiles: ['packages/relay/src/__tests__/fixtures/slow-crypto.ts'],
    maxWorkers: 1,
  },
});
