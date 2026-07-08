import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Formato do @cloudflare/vitest-pool-workers 0.18+ (vitest 4): as opções que
// viviam em test.poolOptions.workers agora vão direto pro plugin cloudflareTest.
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      main: 'src/web/worker.ts',
      miniflare: {
        compatibilityDate: '2025-02-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        kvNamespaces: ['OAUTH_KV', 'GRAPH_CACHE'],
        r2Buckets: ['MEDIA'],
        bindings: {
          SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
          OWNER_EMAIL: 'owner@example.com',
          // pre-computed PBKDF2-SHA256 hash of 'correct-horse-battery-staple' (fixed salt)
          OWNER_PASSWORD_HASH: 'pbkdf2$sha256$100000$KioqKioqKioqKioqKioqKg==$DWDYY4glGRlCjYQo0yd3Mpw7hawDPs1oJcoWekVZ2Tw=',
          // Token de export do grafo (auth Bearer aditiva de /app/graph/*) — usado
          // pelos testes de ETag do meta (spec 23) via header Authorization.
          GRAPH_EXPORT_TOKEN: 'tok',
          // Bearer dos /setup/* quando o vault esta configurado (spec 10-backend/18).
          SETUP_TOKEN: 'setup-tok',
        },
      },
      isolatedStorage: false,
    }),
  ],
  test: {
    // .claude/worktrees são checkouts isolados de sessões agênticas — têm seus
    // próprios *.test.ts com schemas possivelmente divergentes. Sem excluí-los, o
    // vitest da árvore principal globa e roda essas cópias, poluindo o resultado.
    // test/client/** roda em jsdom pela suíte própria (vitest.client.config.ts) —
    // dentro do workerd não há DOM. e2e/** é Playwright, nunca vitest.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/test/auth.test.ts', '**/test/manifest.test.ts', '**/test/client/**', '**/e2e/**'],
    // Default de 5s flaka sob carga: os testes rodam DENTRO do workerd (import
    // caro) e alguns fazem dezenas de writes D1 num loop. 20s é folga, não licença.
    testTimeout: 20000,
  },
});
