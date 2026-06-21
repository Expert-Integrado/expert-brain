import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        main: 'src/web/worker.ts',
        miniflare: {
          compatibilityDate: '2025-02-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          kvNamespaces: ['OAUTH_KV', 'GRAPH_CACHE'],
          bindings: {
            SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
            OWNER_EMAIL: 'robson@example.com',
            // pre-computed PBKDF2-SHA256 hash of 'correct-horse-battery-staple' (fixed salt)
            OWNER_PASSWORD_HASH: 'pbkdf2$sha256$100000$KioqKioqKioqKioqKioqKg==$DWDYY4glGRlCjYQo0yd3Mpw7hawDPs1oJcoWekVZ2Tw=',
          },
        },
        isolatedStorage: false,
      },
    },
    // .claude/worktrees são checkouts isolados de sessões agênticas — têm seus
    // próprios *.test.ts com schemas possivelmente divergentes. Sem excluí-los, o
    // vitest da árvore principal globa e roda essas cópias, poluindo o resultado.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/test/auth.test.ts'],
  },
});
