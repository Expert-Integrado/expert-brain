import { defineConfig } from 'vitest/config';

// Suíte da CAMADA CLIENT (src/web/client/*) em jsdom — separada da suíte de
// worker (vitest.config.ts, pool-workers) porque o ambiente é outro: aqui é
// DOM de browser simulado, sem bindings Cloudflare (specs/60-ux-reforma/61).
// Roda com: npx vitest run --config vitest.client.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/client/**/*.test.ts'],
  },
});
