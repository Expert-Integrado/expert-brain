import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Suíte do GATEWAY da fusão (F2, plano joyful-petting-alpaca): worker do Brain
// (src/web/worker.ts, o mesmo entry da suíte principal) COM o módulo de contatos
// bound — DB_CONTACTS/KV_CONTACTS presentes ativam o ensureContactsBinding e o
// mount público handleContactsApi. Config SEPARADA de propósito: a suíte
// principal roda SEM esses bindings (modo "instalação sem contatos", degradação
// 503 intacta); esta roda o modo fundido. Os dois ambientes existem em prod.
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      main: 'src/web/worker.ts',
      miniflare: {
        compatibilityDate: '2025-02-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB', 'DB_CONTACTS'],
        kvNamespaces: ['OAUTH_KV', 'GRAPH_CACHE', 'KV_CONTACTS'],
        r2Buckets: ['MEDIA', 'MEDIA_CONTACTS'],
        bindings: {
          SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
          OWNER_EMAIL: 'owner@example.com',
          // pre-computed PBKDF2-SHA256 hash of 'correct-horse-battery-staple' (fixed salt)
          OWNER_PASSWORD_HASH: 'pbkdf2$sha256$100000$KioqKioqKioqKioqKioqKg==$DWDYY4glGRlCjYQo0yd3Mpw7hawDPs1oJcoWekVZ2Tw=',
          GRAPH_EXPORT_TOKEN: 'tok',
          SETUP_TOKEN: 'setup-tok',
          // URL pública do worker único — vira PUBLIC_BRAIN_URL do módulo e a
          // base do proxy Google (contactsPublicBase sem CONTACTS_PUBLIC_URL).
          WORKER_URL: 'https://brain-test.example.com',
          // Tokens do módulo de contatos (mesmos nomes de secret do modo fundido).
          CONTACTS_OWNER_TOKEN: 'test-contacts-owner',
          CONTACTS_PROXY_TOKEN: 'test-proxy-token',
          CONTACTS_WRITE_TOKEN: 'test-write-token',
        },
      },
      isolatedStorage: false,
    }),
  ],
  test: {
    include: ['test/gateway/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.claude/**'],
    testTimeout: 20000,
  },
});
