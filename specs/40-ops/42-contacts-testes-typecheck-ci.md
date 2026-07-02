# Contacts: suíte de testes do zero + typecheck + CI (hoje: nada)

> **Status:** draft · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-contacts
> **Depende de:** nenhuma

## Contexto

O Worker `expert-contacts` (Cloudflare Workers + D1 + Vectorize + R2 + KV) tem hoje:

- **736 linhas de API** em `src/index.ts` (rotas de entidades: `save_person`, `save_company`, `save_entity`, `recall_entity`, `get_contact_by_phone`, `connect`, `event`, `attach_media`, cron de manutenção Pipedrive, etc.).
- **Expert Console multi-vault** co-hospedado em `src/web/` (sessão HMAC em `src/web/session.ts`, cache de grafo em `src/vaults/contacts.ts` e `src/vaults/brain.ts`, ~3.800 linhas totais em `src/`).
- `package.json` com apenas 6 scripts: `build:bundles`, `deploy`, `dev`, `reembed`, `fetch-photos` e `release-v3`. **Não existe script `test` nem `typecheck`.**
- Dois tsconfigs: `tsconfig.json` (raiz, exclui `src/web/client/**`) e `src/web/client/tsconfig.json` (bundles client compilados por esbuild via `scripts/build-bundles.ts`).
- Nenhum diretório `test/`, nenhum `vitest.config.ts`, nenhum workflow em `.github/workflows/`.

O repo irmão `expert-brain` já tem o stack de referência funcionando: `vitest` + `@cloudflare/vitest-pool-workers` (miniflare com D1/KV/R2 in-memory), script `"test": "vitest run ..."` e `"typecheck": "tsc --noEmit && tsc --noEmit -p src/web/client/tsconfig.json"` (ver `expert-brain/vitest.config.ts` e `expert-brain/package.json`). Esta spec replica esse stack no expert-contacts.

## Problema / Motivação

1. **Zero testes.** Não existe nenhum arquivo `*.test.ts` no repo. Toda regressão em `handleSaveEntity` (`src/index.ts:200-292`), `phoneVariants` (`src/index.ts:89-103`) ou `verifySession` (`src/web/session.ts:49-65`) só aparece em produção.
2. **Zero typecheck.** O deploy é `esbuild` (bundles client via `scripts/build-bundles.ts`) + `wrangler deploy` — **nenhum dos dois roda `tsc`**. Erros de tipo passam silenciosamente; o `tsconfig.json` com `strict: true` existe mas nunca é executado.
3. **Zero CI.** Não há `.github/workflows/` — nada roda em push/PR.
4. **Bugs conhecidos sem rede de proteção** (documentados na spec `10-backend/19-contacts-write-path-e-canon-unico.md`):
   - `src/index.ts:208` + `src/index.ts:245`: no update, `source` é bindado como `source` (default `"manual"`) dentro de `COALESCE(?, source)` — um save sem `source` **sobrescreve** o source original com `"manual"` em vez de preservar.
   - `src/index.ts:211-214`: `category: ""` passa pela validação (string vazia é falsy no `if (category && ...)`) e é gravada como `''` no banco, furando o canon de `CONTACT_CATEGORIES`.
   Sem testes, qualquer correção dessas linhas pode regredir de novo.
5. **Script perigoso a um tab-complete do deploy:** `release-v3` em `package.json` faz `wrangler deploy && node scripts/reembed-all.mjs && node scripts/fetch-zapi-photos.mjs` — mistura deploy com **reembed total de ~7,6k entidades** (custo Workers AI + Vectorize) e fetch de fotos em massa. É legado da migração v3 e não deve continuar como script "normal" ao lado de `deploy`.
6. **Gate do roadmap:** as specs `10-backend/19`, `20`, `21`, `22`, `24` e `20-frontend/27` (e a futura 34) mexem exatamente nesses arquivos — todas dependem, formal ou informalmente, desta suíte existir primeiro (G0 do lado contacts).

## Objetivo

`npm test` (≥ 25 casos cobrindo funções puras, upsert e auth) + `npm run typecheck` (ambos os tsconfigs) verdes localmente e em CI (GitHub Actions) a cada push/PR, com `deploy` bloqueado por eles e o script `release-v3` removido.

## Design proposto

Espelhar o stack do expert-brain. Nenhuma mudança de comportamento em produção — apenas **exports adicionais**, scripts e arquivos novos.

### Passo 1 — Dependências e scripts (`package.json`)

Adicionar em `devDependencies` (mesmas versões majoritárias do Brain, compatíveis com `wrangler ^3.99`):

```json
"@cloudflare/vitest-pool-workers": "^0.5.0",
"vitest": "^2.1.0"
```

Alterar `scripts`:

```json
"scripts": {
  "build:bundles": "tsx scripts/build-bundles.ts",
  "typecheck": "tsc --noEmit && tsc --noEmit -p src/web/client/tsconfig.json",
  "test": "vitest run",
  "test:watch": "vitest",
  "deploy": "npm run typecheck && npm run test && npm run build:bundles && wrangler deploy",
  "dev": "wrangler dev",
  "reembed": "node scripts/reembed-all.mjs",
  "fetch-photos": "node scripts/fetch-zapi-photos.mjs"
}
```

- `typecheck` roda o `tsc` nos **dois** tsconfigs (Worker + client), igual ao Brain.
- `deploy` encadeia typecheck + test antes do bundle/deploy — deploy quebrado vira impossível por engano.
- **`release-v3` é REMOVIDO** (ver Passo 5).

### Passo 2 — `vitest.config.ts` (novo, raiz)

Modelado no `expert-brain/vitest.config.ts`, adaptado aos bindings do `wrangler.toml` do contacts:

```ts
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          main: 'src/index.ts',
          miniflare: {
            compatibilityDate: '2025-02-01',
            compatibilityFlags: ['nodejs_compat'],
            d1Databases: ['DB'],
            kvNamespaces: ['CACHE'],
            r2Buckets: ['MEDIA'],
            bindings: {
              OWNER_TOKEN: 'test-owner-token',
              CONTACTS_PROXY_TOKEN: 'test-proxy-token',
              SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
              TEST_MIGRATIONS: migrations,
            },
          },
          isolatedStorage: false,
        },
      },
      exclude: ['**/node_modules/**', '**/.claude/**'],
    },
  };
});
```

Notas:

- **Sem binding `AI` nem `VECTORIZE`**: `computeEmbedding` (`src/index.ts:120-132`) engole erro em try/catch e `handleSaveEntity` só embeda quando `env.VECTORIZE` existe (`src/index.ts:266`) — com Vectorize ausente o caminho de save funciona 100% via D1 (`vectorize_action: "skipped"`). Isso mantém os testes rápidos e determinísticos.
- **Sem binding `ASSETS`/`BRAIN`**: os testes desta spec não exercitam o Console renderizado nem o vault brain; `handleApp` só intercepta `/app*` e as rotas de API testadas não passam por ele.
- `test/apply-migrations.ts` (setup file) aplica as migrations reais de `migrations/` (0001-0003) no D1 in-memory:

```ts
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- `test/env.d.ts` declara o `ProvidedEnv` (igual ao padrão do Brain) pra tipar `env` no `cloudflare:test`.

### Passo 3 — Exports pra testabilidade (mudança mínima, aditiva)

As funções puras de `src/index.ts` são privadas ao módulo. **Extrair** `normalizePhone` e `phoneVariants` (`src/index.ts:80-103`) para um novo `src/util/phone.ts` com `export`, e importar de volta no `src/index.ts` (zero mudança de lógica — copiar/colar). `serializeGraphParams` e `contactsSourceHash` já são exportadas de `src/vaults/contacts.ts` (linhas 170 e 185); `verifySession`/`signSession` já são exportadas de `src/web/session.ts` (linhas 38 e 49). Nada mais precisa mudar.

### Passo 4 — Suíte de testes (`test/`, ordem de prioridade)

**4a. `test/phone.test.ts` — funções puras, zero setup:**

- `normalizePhone`: strip de não-dígitos; `< 8` dígitos → `null`; `undefined` → `null`.
- `phoneVariants` (o coração do lookup determinístico `/get_contact_by_phone`):
  - `5511987654321` (13 dígitos, com 9º) → inclui `5511987654321` **e** `551187654321`;
  - `551187654321` (12 dígitos, sem 9º) → inclui a variante **com** o 9 adicionado;
  - entrada de 11 dígitos sem DDI (`11987654321`) → normaliza pra `55...` nos dois sentidos;
  - entrada com zeros à esquerda (`011987654321`) → strip do prefixo `0`;
  - `< 8` dígitos → `[]`;
  - número não-BR longo (ex.: 14 dígitos sem `55`) → devolve só o próprio número.

**4b. `test/graph-cache.test.ts` — serialização e hash de cache:**

- `serializeGraphParams` (`src/vaults/contacts.ts:170-178`): ordem fixa `q,focus,depth,all,limit`; params ausentes viram string vazia; `all: true` → `'1'`; determinístico (mesma entrada, mesma saída).
- `contactsSourceHash` (`src/vaults/contacts.ts:185-193`): banco vazio → hash estável; após inserir uma entity (via `env.DB`), o hash **muda** (é o mecanismo de auto-invalidação do cache KV).

**4c. `test/session.test.ts` — sessão HMAC do Console:**

- `signSession` + `verifySession` round-trip devolve `{ email, issuedAt }`.
- Token com assinatura adulterada → `null`.
- Token com `issuedAt` além do TTL (7 dias, `src/web/session.ts:1`) → `null`.
- Token com formato inválido (≠ 3 partes) → `null`.
- Secret diferente → `null`.

**4d. `test/save-entity.test.ts` — upsert via `SELF.fetch` (integração D1), pega direto os bugs da spec 10-backend/19:**

Usar `SELF` de `cloudflare:test` com header `Authorization: Bearer test-owner-token`:

- `POST /save_person` sem `name` → 400.
- `POST /save_person` novo → `{ action: "created" }`; mesmo phone de novo → `{ action: "updated" }` e **mesmo id** (resolve por phone, `src/index.ts:220-221`).
- `POST /save_company` duas vezes com mesmo nome (case diferente) → segundo é `updated` (idempotência por nome case-insensitive, `src/index.ts:222-227`).
- **COALESCE não sobrescreve campo preenchido**: criar person com `email`, atualizar sem `email` → email original permanece (verificar via `GET /entities/:id`).
- **`source` preservado** *(hoje FALHA — documenta o bug de `src/index.ts:245`)*: criar com `source: "google_import"`, atualizar sem `source` → source deve continuar `google_import`, não virar `manual`. Marcar com `test.fails(...)` até a spec 10-backend/19 corrigir; quando corrigir, o `test.fails` quebra e o executor troca pra `test(...)` — o teste vira a prova da correção.
- **`category: ""` rejeitada** *(hoje FALHA — bug de `src/index.ts:211-214`)*: `POST /save_person` com `category: ""` deve retornar 400 (ou no mínimo não gravar `''`). Mesmo tratamento `test.fails`.
- `category: "banana"` → 400 com lista `allowed` (`src/index.ts:212-214`).
- `kind: "banana"` em `/save_entity` → 400 (`src/index.ts:206`).

**4e. `test/auth.test.ts` — `requireAuth` via `SELF.fetch` (`src/index.ts:69-78`):**

- Sem token → 401 em `GET /list_entities` e `POST /save_person`.
- `OWNER_TOKEN` → 200 em GET **e** POST.
- `CONTACTS_PROXY_TOKEN` → 200 em `GET /list_entities`, **401 em `POST /save_person`** (read-only).
- Token inválido → 401.
- `GET /health` → 200 **sem** token (única rota pública, `src/index.ts:688-691`).

### Passo 5 — Higiene: remover `release-v3`

Remover a linha `"release-v3": "wrangler deploy && node scripts/reembed-all.mjs && node scripts/fetch-zapi-photos.mjs"` do `package.json`. Os passos continuam disponíveis individualmente (`npm run reembed`, `npm run fetch-photos`, `npm run deploy`) — o que sai é só o combo-bomba. Documentar num comentário no topo de `scripts/reembed-all.mjs` que o reembed total tem custo (Workers AI + Vectorize sobre ~7,6k entidades) e só deve rodar deliberadamente. Se o dono do repo preferir manter o combo, alternativa aceitável: renomear pra `_oneoff-release-v3` — **confirmar com o dono antes**; na ausência de resposta, remover (é recuperável no git history).

### Passo 6 — CI (`.github/workflows/ci.yml`, novo)

Mesmo formato do pipeline do Brain (Node 24, npm ci, typecheck, test). Sem deploy no CI — deploy continua manual e local:

```yaml
name: CI

on:
  push:
    branches: [master, main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

### Regras invioláveis

- **Nenhuma migration nova, nenhum ALTER em schema** — esta spec não toca `migrations/` (os testes só LEEM as migrations existentes 0001-0003 pra montar o D1 in-memory).
- **Zero mudança de lógica de runtime** além da extração copiar/colar de `normalizePhone`/`phoneVariants` pra `src/util/phone.ts`. Os bugs de `source`/`category` são **documentados** com `test.fails`, não corrigidos aqui (correção é da spec 10-backend/19).
- Se o `typecheck` inicial revelar erros de tipo pré-existentes: corrigir apenas anotações/casts que não mudam comportamento; se algum exigir mudança de lógica, marcar com `// @ts-expect-error TODO(spec-19/20/...)` e referenciar a spec dona.

## Fora de escopo

- Cobertura de UI do Console (render de páginas, bundles client, sigma/graphology) — só as funções puras de sessão/cache entram.
- Testes e2e contra o Worker deployado.
- Corrigir os bugs de `source`/`category` do write path (spec `10-backend/19`) — aqui eles apenas ganham testes-sentinela.
- Testes do MCP (`mcp/index.js`).
- Testes do cron `handleMaintenanceSync` (mock de Pipedrive fica pra spec `10-backend/22`).
- Deploy automatizado via CI.

## Critérios de aceite

- [ ] `npm run typecheck` existe e passa (roda `tsc --noEmit` na raiz E em `src/web/client/tsconfig.json`).
- [ ] `npm test` existe e passa com ≥ 25 casos, cobrindo os 5 arquivos de teste (phone, graph-cache, session, save-entity, auth).
- [ ] `phoneVariants` testada nos dois sentidos do 9º dígito (com→sem e sem→com).
- [ ] Teste de upsert prova `created` vs `updated` com mesmo id e prova que COALESCE não sobrescreve campo preenchido.
- [ ] Bugs de `source` sobrescrito e `category: ""` documentados com `test.fails` referenciando a spec 10-backend/19.
- [ ] `requireAuth` testada nas 3 vias: OWNER_TOKEN (read+write), CONTACTS_PROXY_TOKEN (read-only, POST → 401), sem token (401); `/health` público.
- [ ] Testes rodam sem bindings AI/Vectorize (sem chamada de rede, determinísticos).
- [ ] `npm run deploy` encadeia `typecheck && test && build:bundles && wrangler deploy`.
- [ ] Script `release-v3` removido (ou renomeado pra `_oneoff-` com OK explícito do dono).
- [ ] `.github/workflows/ci.yml` criado e verde no primeiro push.
- [ ] Nenhuma migration nova; nenhum comportamento de runtime alterado (diff de `src/index.ts` restrito a mover `normalizePhone`/`phoneVariants` + import).

## Validação

```bash
cd C:/repos/expert-contacts
npm install                 # instala vitest + pool-workers
npm run typecheck           # tsc nos 2 tsconfigs — deve sair 0
npm test                    # suíte completa — deve sair 0 (test.fails contam como pass)
npm run test:watch          # loop local durante o desenvolvimento
```

Teste manual pós-merge (sem deploy): `npx wrangler dev` + `curl http://localhost:8787/health` → 200 com counts, provando que a extração pra `src/util/phone.ts` não quebrou o Worker.

**Deploy em produção (`npm run deploy`) SOMENTE com OK explícito do dono do repo.** O CI não deploya nada.

## Arquivos afetados

- `package.json` (scripts test/typecheck, deploy encadeado, remoção de release-v3, devDependencies)
- `vitest.config.ts` (novo)
- `test/apply-migrations.ts` (novo)
- `test/env.d.ts` (novo)
- `test/phone.test.ts` (novo)
- `test/graph-cache.test.ts` (novo)
- `test/session.test.ts` (novo)
- `test/save-entity.test.ts` (novo)
- `test/auth.test.ts` (novo)
- `.github/workflows/ci.yml` (novo)
- `src/util/phone.ts` (novo — extração de `normalizePhone`/`phoneVariants`)
- `src/index.ts` (só remoção das 2 funções extraídas + import)
- `tsconfig.json` (apenas se precisar incluir `test/**` num tsconfig próprio de teste; a raiz continua excluindo `src/web/client/**`)

## Riscos e reversão

- **Risco: versões `@cloudflare/vitest-pool-workers` × `wrangler ^3.99` incompatíveis.** Mitigação: usar as mesmas versões que já funcionam no expert-brain (`pool-workers ^0.5.0`, `vitest ^2.1.0`). Se der conflito, alinhar a versão do wrangler à do Brain — mudança só de devDependency, sem efeito em produção.
- **Risco: `typecheck` revela dezenas de erros pré-existentes e trava o deploy.** Mitigação: janela de correção só-de-tipos; em último caso, `deploy` encadeia só `test` temporariamente e o typecheck fica como job separado no CI (documentar no PR).
- **Risco: extração de `phoneVariants` introduzir divergência.** Mitigação: copiar/colar literal + os próprios testes de 4a como prova; `wrangler dev` + `/health` como smoke.
- **Rollback:** tudo é aditivo — `git revert` do(s) commit(s) restaura o estado anterior por completo (não há migration, não há mudança de dados, não há deploy nesta spec). Se `release-v3` fizer falta, recuperar do git history.
