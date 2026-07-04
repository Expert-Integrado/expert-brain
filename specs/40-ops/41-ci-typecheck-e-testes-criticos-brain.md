# Brain: CI com gate de test/typecheck, fix do typecheck do client e testes do fluxo OAuth/PAT

> **Status:** draft · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O repo tem uma suíte de testes razoável (`test/` com ~15 arquivos rodando no
`@cloudflare/vitest-pool-workers`, mais `test/auth.test.ts` em ambiente node via
`vitest.auth.config.ts`) e um script de typecheck em duas etapas
(`package.json` → `"typecheck": "tsc --noEmit && tsc --noEmit -p src/web/client/tsconfig.json"`).

Porém:

- O **único workflow de CI** é `.github/workflows/publish-create.yml`, que espelha o
  repo pra `create/template/` e publica o pacote `@expertintegrado/create-expert-brain`
  no npm quando uma release é publicada. Ele **não roda `npm test` nem `npm run typecheck`**
  em nenhum momento — o job `publish` vai direto de checkout pra `npm publish`.
- Não existe workflow de push/PR. Nada impede commit com teste quebrado no `master`.
- A entrada de **todas** as instâncias remotas (PAT `eb_pat_...`) vive em
  `src/index.ts:25-38` e a entrada OAuth (login por senha) em `src/auth/handler.ts:22-44`.
  Nenhum dos dois caminhos tem teste.
- A suíte workers roda com `singleWorker: true` + `isolatedStorage: false`
  (`vitest.config.ts`), ou seja, **todos os arquivos de teste compartilham o mesmo D1**.
  Cada arquivo reimplementa (ou esquece) seu próprio `resetDb()` local — hoje existem
  cópias em `test/tools/delete-note.test.ts:16`, `test/tools/update-note.test.ts:15`,
  `test/tools/stats.test.ts:8`, entre outros.

Este item é o **G0 do roadmap de specs**: nenhuma outra spec de código do Brain deveria
ser executada antes de o CI estar verde e obrigatório.

## Problema / Motivação

Evidências concretas:

1. **CI sem gate** — `.github/workflows/publish-create.yml` (único workflow em
   `.github/workflows/`) publica no npm sem nenhum job de teste/typecheck como `needs:`.
   Uma release pode empacotar código quebrado pra todos os alunos que instalam via
   `npm create @expertintegrado/expert-brain`.
2. **Typecheck vermelho permanente** — `npm run typecheck` falha hoje com:
   ```
   src/web/client/sim-worker.ts(104,16): error TS2304: Cannot find name 'DedicatedWorkerGlobalScope'.
   src/web/client/sim-worker.ts(113,12): error TS2304: Cannot find name 'DedicatedWorkerGlobalScope'.
   ```
   Causa: `src/web/client/tsconfig.json:6` usa `"lib": ["ES2020", "DOM"]` — o tipo
   `DedicatedWorkerGlobalScope` só existe na lib `WebWorker`, e `DOM` + `WebWorker`
   conflitam no mesmo tsconfig (definições duplicadas de globals). Com o typecheck
   sempre vermelho, ninguém percebe quando um erro NOVO aparece.
3. **Fluxo de auth sem teste** — o roteamento PAT em `src/index.ts:27`
   (`auth.startsWith('Bearer eb_pat_')` → `validateApiKey` → `(ctx as any).props = ...`)
   depende de um detalhe **interno e não documentado** do agents SDK: `McpAgent.init()`
   lê `(this as any).props` (`src/mcp/agent.ts:14` lança `'ExpertBrainMCP: missing auth props'`
   se ausente). Um upgrade do pacote `agents` pode quebrar esse hack **em silêncio** —
   401/500 pra todas as VPS/containers que usam PAT. Um teste é o detector.
   O caminho OAuth (`POST /authorize` em `src/auth/handler.ts:26-41`) também não tem
   teste: `test/auth.test.ts` só cobre `hashPassword`/`verifyPassword`.
4. **Ordem-dependência latente na suíte** — com `isolatedStorage: false` +
   `singleWorker: true` (`vitest.config.ts:7,24`), um arquivo de teste que não limpa as
   tabelas herda lixo do arquivo anterior. Hoje funciona por sorte/disciplina; o helper
   `resetDb()` é copiado à mão e diverge entre arquivos.

## Objetivo

Todo push/PR roda `npm ci` + `npm run typecheck` + `npm test` num workflow obrigatório
que fica verde, o publish do npm só roda depois desse gate, e os caminhos de entrada
OAuth (`POST /authorize`) e PAT (`Bearer eb_pat_` em `/mcp`) têm testes automatizados.

## Design proposto

### 1. Fix do typecheck do client (`sim-worker.ts`)

Trocar os dois casts `(self as DedicatedWorkerGlobalScope)` (linhas 104 e 113 de
`src/web/client/sim-worker.ts`) por um alias tipado no topo do arquivo, sem tocar na lib
do tsconfig:

```ts
// DOM e WebWorker não coexistem na mesma lib do tsconfig (globals duplicados).
// Alias estrutural: só o que o worker realmente usa de `self`.
const workerSelf = self as unknown as {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', handler: (e: MessageEvent) => void): void;
};
```

E usar `workerSelf.postMessage(...)` nos dois pontos e `workerSelf.addEventListener('message', ...)`
na linha 120 (hoje `self.addEventListener` compila porque `DOM` está na lib, mas migrar
os três usos pro alias deixa o arquivo coerente).

Alternativa aceitável (se preferir tipos reais): criar
`src/web/client/tsconfig.worker.json` com `"lib": ["ES2020", "WebWorker"]` incluindo só
`sim-worker.ts`, excluir o arquivo do tsconfig do client, e adicionar o terceiro `tsc -p`
ao script `typecheck`. É mais limpo semanticamente, porém adiciona um passo de build —
o alias estrutural é suficiente e menor. Escolher UMA das duas; a spec recomenda o alias.

Critério: `npm run typecheck` sai com código 0.

### 2. Workflow `ci.yml` (novo) + gate no `publish-create.yml`

Criar `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

jobs:
  test:
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

Em `.github/workflows/publish-create.yml`, adicionar um job `test` idêntico aos steps
acima (checkout → setup-node → `npm ci` → `npm run typecheck` → `npm test`) e mudar o
job `publish` pra `needs: test`. NÃO renomear o arquivo `publish-create.yml` — o nome é
parte da configuração do Trusted Publisher no npm (aviso no header do próprio arquivo).

Observação: `npm ci` roda o hook `prepare` (`scripts/install-hooks.mjs`) — verificar que
ele é no-op fora de um checkout git com hooks configuráveis; se falhar no runner, guardar
com `--ignore-scripts` NÃO é opção (quebraria deps que compilam), então ajustar o script
pra sair 0 quando não aplicável.

### 3. Testes do caminho de auth

**3a. PAT em `/mcp` — novo `test/mcp-auth.test.ts`.**

O `main` do `vitest.config.ts` atual é `src/web/worker.ts` (entry mínimo sem OAuth, de
propósito). Pra exercitar `src/index.ts` de verdade via `SELF.fetch`, criar um terceiro
config `vitest.mcp.config.ts` (espelho do principal) com:

- `main: 'src/index.ts'`
- `miniflare.durableObjects: { MCP_OBJECT: 'ExpertBrainMCP' }` (binding igual ao
  `wrangler.example.toml` seção `[durable_objects]`)
- mesmos `d1Databases`, `kvNamespaces`, `r2Buckets` e `bindings` do config principal
- `include: ['test/mcp-auth.test.ts']`, e adicionar `'**/test/mcp-auth.test.ts'` ao
  `exclude` do `vitest.config.ts`

E encadear no `package.json`:

```json
"test": "vitest run && vitest run --config vitest.auth.config.ts && vitest run --config vitest.mcp.config.ts"
```

Casos do `test/mcp-auth.test.ts` (todos via `SELF.fetch('https://example.com/mcp', ...)`
com um POST JSON-RPC `initialize` e headers `content-type: application/json` +
`accept: application/json, text/event-stream`):

1. **PAT válido:** `beforeAll` roda `runMigrations(env)` + `resetDb(env)`; cria chave com
   `createApiKey(env, 'owner@example.com', 'ci')` (de `src/auth/api-keys.ts:48`) e usa o
   `plainKey` retornado como `Authorization: Bearer <plainKey>`. Espera `status !== 401`
   e resposta do handler MCP (não o JSON de erro `-32001`). Este caso é o detector do
   hack `(ctx as any).props` (`src/index.ts:36`): se um upgrade do agents SDK parar de
   propagar props, `ExpertBrainMCP.init()` lança `missing auth props` e o teste quebra.
2. **PAT inválido:** `Authorization: Bearer eb_pat_inexistente` → `401` com body JSON
   contendo `"Invalid or revoked API key"` (`src/index.ts:32`).
3. **PAT revogado:** cria chave, `revokeApiKey(env, 'owner@example.com', row.id)`
   (`src/auth/api-keys.ts:84` — faz DELETE), repete a chamada → `401`.
4. **Sem `Bearer eb_pat_`:** request sem Authorization cai no OAuthProvider e NÃO retorna
   o erro `-32001` do branch PAT (basta asserir que o status é 401 do provider ou
   similar, sem acoplar no formato interno do OAuthProvider).

**3b. `POST /authorize` — estender `test/auth.test.ts` OU teste workers dedicado.**

`test/auth.test.ts` roda em ambiente node puro (`vitest.auth.config.ts`) e o
`authHandler` precisa de `Env`; o mais simples é testar o `authHandler.fetch` como
unidade, injetando um env fake (objeto plano com `OWNER_EMAIL`, `OWNER_PASSWORD_HASH`
gerado na hora via `hashPassword`, e os campos que `isSetup(env)` de
`src/auth/setup.ts` checa) e um `OAUTH_PROVIDER` stub:

1. **Credenciais erradas:** `POST /authorize` com `FormData` `email` errado → resposta
   HTML do `renderLogin` contendo `Credenciais inválidas.` (`src/auth/handler.ts:29`);
   idem senha errada (`src/auth/handler.ts:31`). Nenhuma chamada ao provider.
2. **Senha certa:** stub `OAUTH_PROVIDER` com `parseAuthRequest: async () => ({ scope: ['mcp'] })`
   e `completeAuthorization: async () => ({ redirectTo: 'https://client.example/cb?code=x' })`
   → resposta `302` com `Location` igual ao `redirectTo` (`src/auth/handler.ts:41`).

Node 20+ tem `crypto.subtle` e `FormData`/`Request` globais, então isso roda no
`vitest.auth.config.ts` sem pool workers. Se `isSetup` exigir bindings reais demais,
mover esses casos pro pool workers (config principal) usando os bindings de teste já
definidos em `vitest.config.ts:16-19` — decidir na implementação pelo caminho de menor
atrito, mantendo os 2 casos.

### 4. Higiene da suíte — `resetDb` canônico

- Criar `test/reset-db.ts` (nome sem `.test.` pra não ser globado como suíte) exportando:

  ```ts
  export async function resetDb(env: { DB: D1Database }): Promise<void> {
    // Ordem respeita FKs: filhas antes de notes.
    for (const table of ['edges', 'tags', 'note_media', 'similar_edges', 'api_keys', 'notes']) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  }
  ```

  Ajustar a lista de tabelas ao schema real em `src/db/migrations/` na implementação
  (só DELETE — **nenhum DROP, nenhuma migration nova**; dados de produção nunca são
  tocados por isto, é helper de teste).
- Substituir os `resetDb()` locais duplicados (`test/tools/delete-note.test.ts:16`,
  `test/tools/update-note.test.ts:15`, `test/tools/stats.test.ts:8` e demais ocorrências)
  por import do helper.
- Regra: todo arquivo de teste do pool workers começa com
  `beforeAll/beforeEach` → `runMigrations(env)` + `resetDb(env)`.
- Documentar a regra numa seção curta "Desenvolvimento / testes" no `CLAUDE.md` do repo
  (2-4 linhas: por que `isolatedStorage: false` exige reset explícito e onde fica o
  helper).

## Fora de escopo

- Migrar pra `isolatedStorage: true` no vitest-pool-workers (avaliar custo/tempo de
  execução em spec futura).
- Testes e2e de browser (login real via Playwright, dashboard `/app`).
- Cobertura completa do OAuthProvider (`/token`, `/register`, refresh) — é código de
  terceiro (`@cloudflare/workers-oauth-provider`).
- Renomear ou reestruturar `publish-create.yml` (nome é contrato com o Trusted Publisher
  do npm).
- Branch protection no GitHub (config de repo, não de código — dono ativa manualmente
  depois que o `ci.yml` estiver verde).

## Critérios de aceite

- [ ] `npm run typecheck` sai com código 0 (os dois erros `TS2304: DedicatedWorkerGlobalScope` em `src/web/client/sim-worker.ts:104,113` eliminados sem `any` solto nem `@ts-ignore`)
- [ ] `.github/workflows/ci.yml` existe e roda `npm ci` + `npm run typecheck` + `npm test` em push pra `master` e em pull request
- [ ] `publish-create.yml` tem job `test` e o job `publish` declara `needs: test`
- [ ] `test/mcp-auth.test.ts` cobre: PAT válido (não-401, MCP responde), PAT inválido (401 + `-32001`), PAT revogado (401)
- [ ] Teste de `POST /authorize` cobre: credenciais erradas → HTML com `Credenciais inválidas.`; credenciais certas → 302 pro `redirectTo` do provider
- [ ] Helper `resetDb(env)` canônico em `test/reset-db.ts`, e os `resetDb` locais duplicados removidos dos arquivos de teste
- [ ] Seção curta sobre a regra de reset no `CLAUDE.md` do repo
- [ ] `npm test` completo (as 3 invocações do vitest) passa localmente e no CI
- [ ] Nenhuma migration de banco criada/alterada por esta spec

## Validação

```bash
# na raiz do repo (C:\repos\expert-brain)
npm ci
npm run typecheck        # exit 0
npm test                 # 3 passes de vitest, tudo verde

# validar YAML dos workflows sem depender de push
npx --yes yaml-lint .github/workflows/ci.yml .github/workflows/publish-create.yml

# teste real do gate: abrir PR de branch e confirmar que o check "CI / test" aparece
# e fica verde no GitHub antes do merge
```

Deploy do Worker NÃO faz parte desta spec (é só CI + testes + fix de tipo); qualquer
release/publish no npm continua exigindo OK explícito do dono do repo.

## Arquivos afetados

- `.github/workflows/ci.yml` (novo)
- `.github/workflows/publish-create.yml` (job `test` + `needs: test` no `publish`)
- `src/web/client/sim-worker.ts` (alias `workerSelf` tipado; linhas 104, 113, 120)
- `src/web/client/tsconfig.json` (só se a alternativa do tsconfig dedicado for escolhida; no caminho recomendado fica intocado)
- `test/auth.test.ts` (casos de `POST /authorize`)
- `test/mcp-auth.test.ts` (novo)
- `test/reset-db.ts` (novo — helper canônico)
- `test/tools/*.test.ts` (trocar `resetDb` local pelo helper)
- `vitest.config.ts` (excluir `test/mcp-auth.test.ts`)
- `vitest.mcp.config.ts` (novo — `main: src/index.ts` + Durable Object `MCP_OBJECT`)
- `package.json` (script `test` encadeia o terceiro config)
- `CLAUDE.md` (seção curta de higiene de testes)

## Riscos e reversão

- **Risco: `ci.yml` flaky bloqueando merges.** Mitigação: a suíte já roda local
  determinística (Vectorize/AI são mockados nos testes); se um caso específico oscilar
  no runner, marcar com `it.skip` + issue, nunca remover o workflow. Rollback: deletar
  `.github/workflows/ci.yml` (um `git revert` — zero efeito em runtime).
- **Risco: gate no `publish-create.yml` travar uma release urgente.** O `workflow_dispatch`
  continua existindo; em emergência real o dono pode reverter o commit do `needs: test`.
  Rollback: `git revert` do commit que adicionou o job.
- **Risco: teste do PAT acoplado a interno do agents SDK.** É proposital — o teste
  existe exatamente pra quebrar ALTO quando o interno mudar, em vez de quebrar em
  produção. Se quebrar num upgrade do `agents`, o fix é no `src/index.ts`, não no teste.
- **Risco: refactor do `resetDb` alterar comportamento de testes existentes.** Só há
  troca de implementação idêntica (DELETEs); rodar a suíte completa antes/depois no
  mesmo commit. Rollback: reverter o commit do helper (testes voltam às cópias locais).
- **Dados de produção: risco zero.** Nenhuma migration, nenhum comando contra D1 remoto;
  tudo roda em miniflare efêmero do vitest.
