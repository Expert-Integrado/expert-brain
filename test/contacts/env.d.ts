/// <reference types="@cloudflare/vitest-pool-workers" />

// Tipa o `env` do módulo `cloudflare:test` com os bindings declarados no
// vitest.config.ts. Só o subconjunto exercitado pelos testes desta suíte —
// VECTORIZE/AI/ASSETS/BRAIN são omitidos de propósito (degradação graciosa).
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    CACHE: KVNamespace;
    MEDIA: R2Bucket;
    OWNER_TOKEN: string;
    CONTACTS_PROXY_TOKEN: string;
    CONTACTS_WRITE_TOKEN: string;
    SESSION_SECRET: string;
  }
}
