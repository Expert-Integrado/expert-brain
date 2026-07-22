import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Suíte do MÓDULO de contatos vendorizado em src/contacts/ (fusão do antigo
// worker expert-contacts — plano joyful-petting-alpaca, F1). Espelho fiel do
// vitest.config.mts que rodava no repo expert-contacts: o SELF aponta pro router
// do contacts (`src/contacts/index.ts`), NÃO pro worker do Brain — os testes
// fazem SELF.fetch contra a API de entidades. Roda como config SEPARADA porque
// o worker, os bindings e o schema D1 são outros; o vitest.config.ts principal
// exclui test/contacts/** pra não globar estes no pool do Brain.
//
// Bindings deliberadamente OMITIDOS (degradação graciosa, igual ao repo origem):
//  - VECTORIZE/AI: sem eles, save/recall caem no modo sql_like (determinístico,
//    sem rede). - ASSETS/BRAIN: console renderizado e vault brain não são
//    exercitados por esta suíte.
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      main: 'src/contacts/index.ts',
      miniflare: {
        compatibilityDate: '2025-02-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        kvNamespaces: ['CACHE'],
        r2Buckets: ['MEDIA'],
        bindings: {
          OWNER_TOKEN: 'test-owner-token',
          CONTACTS_PROXY_TOKEN: 'test-proxy-token',
          CONTACTS_WRITE_TOKEN: 'test-write-token',
          SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
        },
      },
      isolatedStorage: false,
    }),
  ],
  test: {
    include: ['test/contacts/**/*.test.ts'],
    setupFiles: ['./test/contacts/apply-migrations.ts'],
    testTimeout: 20000,
    exclude: ['**/node_modules/**', '**/.claude/**'],
  },
});
