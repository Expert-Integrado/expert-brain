import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/auth.test.ts'],
    environment: 'node',
  },
});
