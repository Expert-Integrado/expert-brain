# Contacts: migrations com tracking (portar o padrão runMigrations do Brain) e desarmar o footgun do migrations_dir

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-contacts
> **Depende de:** 40-ops/42-contacts-testes-typecheck-ci.md

> **Nota de execução:** `src/db/migrate.ts` (com baseline), `POST /setup/provision`, remoção do `migrations_dir` do `wrangler.toml` e `migrations/README.md` IMPLEMENTADOS e testados (banco vivo=baseline, banco novo, idempotência, dupla chamada — test/migrate.test.ts). A ordem de execução em PRODUÇÃO (backup `wrangler d1 export`, deploy, `POST /setup/provision` remoto, conferência de `_migrations`+counts) é owner-gated — PENDENTE de OK do dono. Nota: adicionei `0004_media_dedup_index` (índice aditivo pedido pela spec 10-backend/19 §7) ao array `MIGRATIONS` — o baseline marca só 0001-0003 como legacy, então a 0004 roda normalmente no primeiro `/setup/provision` (inclusive em produção).

## Contexto

O Expert Contacts é um Worker Cloudflare (D1 + Vectorize + R2 + Workers AI) que vive no repo `expert-contacts`. O schema do banco evoluiu por 3 migrations `.sql` na pasta `migrations/`:

- `migrations/0001_initial_schema.sql` — schema inicial v0.1: tabelas `people`, `connections`, `events`, `media`.
- `migrations/0002_entities.sql` — refatoração v0.4 (`people` → `entities`, grafo polimórfico). **Destrutiva por construção**: `ALTER TABLE people RENAME TO entities`, três rebuilds com `DROP TABLE connections` / `DROP TABLE events` / `DROP TABLE media` (após copiar pra tabelas `_v2`) e `DROP TRIGGER`.
- `migrations/0003_category.sql` — aditiva (`ALTER TABLE entities ADD COLUMN category` + índice).

Nenhuma delas foi aplicada por um mecanismo com registro:

- A 0002 foi aplicada statement-by-statement via D1 HTTP API por um script (`scripts/apply-migration-0002.mjs`, citado no cabeçalho da própria migration) que **não existe mais** em `scripts/` — hoje o repo não tem nenhum rastro executável de como o banco chegou ao estado atual.
- A 0003 documenta no cabeçalho aplicação manual via `wrangler d1 execute expert-contacts-db --remote --file migrations/0003_category.sql`.
- Não existe tabela `_migrations` nem uso da `d1_migrations` nativa do Wrangler no banco de produção.

Já o Expert Brain (repo irmão) tem o padrão maduro em `src/db/migrate.ts`: cada migration é um array de statements SQL atômicos (evita quebrar corpo de trigger em splitters ingênuos), há uma tabela `_migrations (id TEXT PRIMARY KEY, applied_at INTEGER)`, e a função `runMigrations(env)` (`src/db/migrate.ts:176-191`) é idempotente — pula ids já registrados e registra cada id após aplicar. Ela é chamada pelo endpoint de provisionamento em `src/auth/setup.ts:147` (que roda as migrations em todo provision justamente porque são idempotentes).

No Worker do contacts, `src/index.ts` concentra o roteamento: auth Bearer via `requireAuth()` (`src/index.ts:69-78`, `OWNER_TOKEN` pra tudo, `CONTACTS_PROXY_TOKEN` só-leitura em GET), e já existe um endpoint de setup (`POST /setup/reembed`, `src/index.ts:717`) que serve de modelo pro novo `POST /setup/provision`.

## Problema / Motivação

1. **`wrangler.toml:11` arma o footgun**: o bloco `[[d1_databases]]` declara `migrations_dir = "migrations"`. Qualquer pessoa (ou agente) que rode o comando "oficial" `wrangler d1 migrations apply expert-contacts-db --remote` vai tentar aplicar as 3 migrations **do zero** num banco vivo — a `d1_migrations` nativa está vazia, então o Wrangler considera tudo pendente.
2. **A 0002 re-executada é perda de dados**: `migrations/0002_entities.sql` contém `ALTER TABLE people RENAME TO entities` (falha, `people` não existe mais) seguido de `DROP TABLE connections/events/media`. O Wrangler aplica cada arquivo como batch: dependendo de onde o batch falha, o resultado é **aplicação parcial** — tabelas dropadas sem as `_v2` populadas, ou triggers/índices órfãos. Não há transação cross-statement que proteja o conjunto.
3. **Zero rastreabilidade**: sem `_migrations`, não há como um agente futuro saber o que já foi aplicado. Cada migration nova volta a depender de aplicação manual e disciplina humana — o mesmo padrão que já causou incidentes em outros sistemas.
4. **Divergência entre os 2 repos**: o Brain tem tracking idempotente em código; o contacts não. Todo agente que trabalha nos dois precisa carregar dois modelos mentais.

Esta spec é **pré-requisito formal** de qualquer spec que crie migration nova no contacts (10-backend/21 depende dela).

## Objetivo

Todo schema change do contacts passa a ser aplicado exclusivamente por `runMigrations()` idempotente com tabela `_migrations`, e nenhum comando `wrangler d1 migrations apply` consegue mais re-executar as migrations históricas no banco de produção.

## Design proposto

Opção A (preferida — unifica os 2 repos): portar o padrão do Brain.

### 1. Criar `src/db/migrate.ts` no contacts

Mesma estrutura do Brain (`expert-brain/src/db/migrate.ts`):

```ts
const MIGRATIONS: Array<{ id: string; stmts: string[] }> = [
  { id: '0001_initial_schema', stmts: MIGRATION_0001_STMTS },
  { id: '0002_entities',       stmts: MIGRATION_0002_STMTS },
  { id: '0003_category',       stmts: MIGRATION_0003_STMTS },
];
```

Com uma diferença crítica em relação ao Brain: **baseline pra banco vivo**. As migrations 0001–0003 já foram aplicadas em produção e a 0002 é destrutiva — elas NUNCA podem re-executar lá. `runMigrations` ganha um passo de baseline antes do loop:

```ts
export async function runMigrations(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
  ).run();

  // BASELINE: se o schema v0.4 já existe (tabela `entities` presente) e a
  // _migrations está vazia, é o banco de produção pré-tracking. Marca as 3
  // migrations históricas como aplicadas SEM executar nada (a 0002 tem DROP
  // TABLE — re-executar seria perda de dados).
  const hasEntities = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='entities'`
  ).first();
  const applied = await env.DB.prepare(`SELECT id FROM _migrations`).all<{ id: string }>();
  const appliedIds = new Set((applied.results ?? []).map((r) => r.id));
  if (hasEntities && appliedIds.size === 0) {
    for (const legacy of ['0001_initial_schema', '0002_entities', '0003_category']) {
      await env.DB.prepare(`INSERT OR IGNORE INTO _migrations (id, applied_at) VALUES (?, ?)`)
        .bind(legacy, Date.now()).run();
      appliedIds.add(legacy);
    }
  }

  for (const m of MIGRATIONS) {
    if (appliedIds.has(m.id)) continue;
    for (const stmt of m.stmts) await env.DB.prepare(stmt).run();
    await env.DB.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`)
      .bind(m.id, Date.now()).run();
  }
}
```

Conteúdo dos arrays de statements — transcrição dos `.sql` existentes com dois ajustes pra bancos NOVOS (dev/local/testes):

- `MIGRATION_0001_STMTS`: statements do `0001_initial_schema.sql` como estão (`CREATE TABLE IF NOT EXISTS people ...` etc.), um statement por entrada do array. O corpo do trigger `people_set_updated` (se presente no .sql) fica como statement ÚNICO — nunca splitar por `;` (mesma razão documentada no Brain, `migrate.ts:3-5`).
- `MIGRATION_0002_STMTS`: statements do `0002_entities.sql`, com **guards de idempotência onde o SQLite permite**: `DROP TRIGGER IF EXISTS`, `DROP TABLE IF EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE TRIGGER IF NOT EXISTS entities_set_updated ...`. Os `ALTER TABLE ... RENAME` e `ALTER TABLE ... ADD COLUMN` não têm `IF EXISTS`, mas num banco novo rodam logo após a 0001, então a sequência é determinística. Em produção esses statements nunca executam (baseline).
- `MIGRATION_0003_STMTS`: `ALTER TABLE entities ADD COLUMN category TEXT` + `CREATE INDEX IF NOT EXISTS idx_entities_category ON entities(category)`.

**Regra permanente pra DDL futura** (documentar em comentário no topo do `migrate.ts`): migrations sempre ADITIVAS (`ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Qualquer DDL destrutiva (DROP, RENAME, rebuild) só atrás de guard explícito que checa existência/estado antes (`SELECT ... FROM sqlite_master` ou `PRAGMA table_info`), com justificativa no comentário da migration — mesmo padrão dos comentários das migrations 0004–0007 do Brain.

### 2. Endpoint `POST /setup/provision` em `src/index.ts`

Rota nova ao lado de `POST /setup/reembed` (`src/index.ts:717`), já coberta pelo `requireAuth` global (`src/index.ts:693-694` — exige `OWNER_TOKEN`, pois `CONTACTS_PROXY_TOKEN` só passa em GET):

```ts
if (method === "POST" && path === "/setup/provision") {
  await runMigrations(env);
  const rows = await env.DB.prepare(`SELECT id, applied_at FROM _migrations ORDER BY id`).all();
  return json({ ok: true, migrations: rows.results });
}
```

Idempotente por construção — pode rodar em todo deploy sem efeito colateral (mesma decisão do Brain, `src/auth/setup.ts:139-147`).

### 3. Desarmar o `wrangler.toml`

Remover a linha `migrations_dir = "migrations"` do bloco `[[d1_databases]]` (`wrangler.toml:11`). Sem essa chave, `wrangler d1 migrations apply` falha imediatamente pedindo configuração em vez de aplicar as 3 migrations num banco vivo. O `wrangler.toml` é versionado no repo — a mudança vale pra todo clone.

### 4. `migrations/README.md` (novo)

A pasta `migrations/` fica como **referência histórica apenas**. Criar `migrations/README.md` com:

- Aviso em destaque: "NÃO rodar `wrangler d1 migrations apply` nem `wrangler d1 execute --file` com estes arquivos. A 0002 contém DROP TABLE e destruiria o banco de produção."
- Fonte de verdade do schema: `src/db/migrate.ts` (tracking via tabela `_migrations`).
- Como aplicar migration nova: adicionar entrada no array `MIGRATIONS` + chamar `POST /setup/provision` (com Bearer `OWNER_TOKEN`) após o deploy.

### 5. Ordem de execução em produção (gate obrigatório)

1. **Backup ANTES de qualquer execução, com OK explícito do dono**: `wrangler d1 export expert-contacts-db --remote --output=backup-pre-provision.sql` (guardar fora do repo — pode conter dados pessoais).
2. Deploy do Worker com o novo código.
3. `POST /setup/provision` — primeira chamada executa só o baseline (INSERT das 3 linhas na `_migrations`; zero DDL).
4. Verificar: `wrangler d1 execute expert-contacts-db --remote --command "SELECT * FROM _migrations"` → 3 linhas; `GET /health` → counts de `entities/connections/events/media` idênticos aos de antes do deploy.

### Alternativa mínima (só se a opção A estourar o orçamento)

Marcar as 3 migrations na `d1_migrations` nativa do Wrangler (INSERT manual via `wrangler d1 execute --remote`) e passar a usar `wrangler d1 migrations apply` daí em diante. Descartada como caminho preferido porque: (a) mantém dois padrões diferentes entre Brain e contacts; (b) o apply nativo roda arquivo inteiro como batch sem tracking por statement; (c) continua dependendo de disciplina de CLI em vez de endpoint idempotente. Se for adotada, documentar a escolha neste arquivo (atualizar a spec) e ainda assim criar o `migrations/README.md` com o aviso.

## Fora de escopo

- Reescrever/normalizar as migrations históricas (0001–0003 ficam como estão, viram referência).
- Migrar dados ou alterar schema além do necessário (esta spec não cria coluna/tabela nova).
- Unificar o `migrate.ts` dos dois repos num pacote compartilhado.
- Mexer na `d1_migrations` nativa (opção A não a usa).
- Qualquer migration nova de feature (isso é assunto da 10-backend/21, que depende desta).

## Critérios de aceite

- [ ] `src/db/migrate.ts` existe no contacts com `MIGRATIONS` (3 entradas: `0001_initial_schema`, `0002_entities`, `0003_category`), tabela `_migrations` e lógica de baseline (banco com `entities` + `_migrations` vazia → marca as 3 sem executar DDL).
- [ ] `POST /setup/provision` responde 200 com a lista de migrations aplicadas quando autenticado com `OWNER_TOKEN`, e 401 sem token (ou com `CONTACTS_PROXY_TOKEN`, que é GET-only).
- [ ] Chamar `/setup/provision` duas vezes seguidas produz o mesmo estado (idempotência verificada em teste).
- [ ] Num banco NOVO (vazio), `runMigrations` cria o schema v0.4 completo (entities, connections, events, media, índices, trigger `entities_set_updated`) e registra os 3 ids.
- [ ] Num banco SIMULANDO produção (schema v0.4 presente, `_migrations` ausente), `runMigrations` só insere as 3 linhas de baseline — nenhum DROP/RENAME executa e os dados pré-existentes permanecem intactos (teste com linhas seed).
- [ ] `wrangler.toml` não contém mais `migrations_dir`.
- [ ] `migrations/README.md` existe com o aviso de "referência histórica apenas — não aplicar".
- [ ] Em produção: `_migrations` tem as 3 linhas e os counts do `GET /health` são idênticos aos anteriores ao deploy.
- [ ] Comentário no topo de `migrate.ts` documenta a regra "DDL destrutiva futura sempre atrás de guard de existência".

## Validação

Pré-requisito: harness de testes + typecheck da spec 40-ops/42 já instalado (vitest + `tsc --noEmit`; hoje o `package.json` do contacts não tem nem script de teste nem typecheck).

```bash
# no diretório do repo expert-contacts
npx tsc --noEmit
npx vitest run          # inclui test/migrate.test.ts (banco novo, banco "produção", idempotência, dupla chamada)
```

Teste manual local:

```bash
npx wrangler dev
# noutro terminal (banco local novo — deve criar schema completo):
curl -s -X POST http://localhost:8787/setup/provision -H "Authorization: Bearer $OWNER_TOKEN"
curl -s http://localhost:8787/health
```

Produção — **somente com OK explícito do dono**, na ordem: (1) export/backup do D1 (`wrangler d1 export expert-contacts-db --remote --output=backup-pre-provision.sql`), (2) `npm run deploy`, (3) `POST /setup/provision` no Worker de produção, (4) conferir `_migrations` e counts do `/health` contra o snapshot pré-deploy.

## Arquivos afetados

- `src/db/migrate.ts` (novo) — port do padrão do Brain + baseline
- `src/index.ts` — import de `runMigrations` + rota `POST /setup/provision` (junto de `/setup/reembed`, linha ~717)
- `migrations/README.md` (novo) — aviso "referência histórica apenas"
- `wrangler.toml` — remover `migrations_dir = "migrations"` (linha 11; arquivo versionado)
- `test/migrate.test.ts` (novo) — cenários de banco novo, baseline em banco vivo e idempotência

## Riscos e reversão

- **Risco principal: baseline errado num banco novo de dev.** Se alguém criar um D1 vazio e a heurística falhar, o pior caso é executar as migrations num banco sem dados — sem perda possível. O caso perigoso (executar 0002 em produção) é bloqueado pela checagem `sqlite_master`/`entities`: produção sempre cai no ramo de baseline. Teste automatizado cobre os dois ramos.
- **Risco: divergência entre os `.sql` e os arrays transcritos.** Mitigação: teste do banco novo valida o schema final via `PRAGMA table_info(entities)` e `sqlite_master` (tabelas, índices e trigger esperados).
- **Rollback do código:** `git revert` do commit + `npm run deploy` — o Worker volta a não ter `/setup/provision`; nenhuma rota existente muda de comportamento.
- **Rollback do banco:** a única escrita desta spec em produção são as 3 linhas de `_migrations` (e a criação da própria tabela). Reversão: `wrangler d1 execute expert-contacts-db --remote --command "DROP TABLE _migrations"`. Nenhuma tabela de dados é tocada. Em caso extremo, o export feito no gate (passo 1) restaura o estado completo.
- **Rollback do `wrangler.toml`:** restaurar a linha `migrations_dir` via git — mas só depois de as migrations históricas estarem marcadas, e preferencialmente nunca (o footgun voltaria).
