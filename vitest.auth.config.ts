import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Nodejs 'node' env (fs real) pra specs que precisam ler arquivo do disco —
    // o pool de Workers (vitest.config.ts) roda dentro do sandbox workerd e não
    // tem acesso a fs de host. test/manifest.test.ts valida o JSON estático do
    // PWA (specs/50-console-v2/68-pwa-instalavel.md).
    include: ['test/auth.test.ts', 'test/manifest.test.ts'],
    environment: 'node',
  },
});
