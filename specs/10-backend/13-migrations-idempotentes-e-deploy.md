# Migrations idempotentes + provision no deploy + espelho .sql saneado

> **Status:** draft · **Prioridade:** P0 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O Expert Brain roda migrations em **runtime**, não via `wrangler d1 migrations apply`:

- `src/db/migrate.ts` define as 7 migrations como arrays de statements SQL (`MIGRATION_0001_STMTS` até `MIGRATION_0007_STMTS`, registradas no array `MIGRATIONS` em `src/db/migrate.ts:166-174`) e exporta `runMigrations(env)` (`src/db/migrate.ts:176-191`), que cria a tabela `_migrations`, lê os ids já aplicados e executa as pendentes.
- O endpoint público `POST /setup/provision` (roteado em `src/auth/handler.ts:19`, implementado em `handleProvision` em `src/auth/setup.ts:138-149`) chama `runMigrations`. É como uma instalação nova OU uma instalação existente que subiu versão nova aplica o schema.
- O wizard de instalação (`scripts/setup.mjs:235-242` e `scripts/setup.mjs:468-475`) chama `/setup/provision` automaticamente — mas só na instalação inicial. Em **updates** (deploy de versão nova numa instalação existente), ninguém chama.
- O script de deploy é `"deploy": "npm run build:bundles && wrangler deploy"` (`package.json`).
- Existe um **espelho** de arquivos `.sql` em `src/db/migrations/` (`0001_init.sql`, `0002_api_keys.sql`, `0003_task_fields.sql`) referenciado por `migrations_dir = "src/db/migrations"` em `wrangler.toml:33` e `wrangler.example.toml:28`. O próprio header de `0003_task_fields.sql:1-7` admite que a numeração do espelho diverge da runtime (o arquivo `0003` espelha a migration runtime `0006`).

## Problema / Motivação

Três defeitos concretos, todos com potencial de travar a instalação de um aluno (o repo é open-source e instalado por terceiros via wizard):

1. **Migration parcial trava o vault pra sempre** (`migrations-alter-nao-idempotente`). Em `runMigrations` (`src/db/migrate.ts:182-190`), os statements de cada migration rodam um a um com `.run()` separado, e o `INSERT INTO _migrations` é outro `.run()` no final. Não há transação. Se uma falha transiente (timeout do D1, worker evicted) interromper no meio da `0006` (`src/db/migrate.ts:134-141`), algumas colunas já foram adicionadas mas `_migrations` não registrou. No retry, o `ALTER TABLE notes ADD COLUMN status ...` explode com `duplicate column name: status` — SQLite **não tem** `ADD COLUMN IF NOT EXISTS`. A partir daí, TODO `POST /setup/provision` retorna 500 pra sempre: a `0006` nunca completa e as migrations seguintes (`0007`) nunca rodam. O mesmo vale pra `0004` (`src/db/migrate.ts:104-106`, `ALTER TABLE notes ADD COLUMN deleted_at`). Os statements `CREATE TABLE/INDEX/TRIGGER` já usam `IF NOT EXISTS` e não sofrem disso — o problema é exclusivo dos `ALTER TABLE ADD COLUMN`.

2. **Janela deploy → provision** (`deploy-sem-provision-gap`). `npm run deploy` publica código novo imediatamente, mas as migrations só rodam quando alguém lembra de chamar `POST /setup/provision`. Nessa janela, código novo que referencia coluna/tabela nova (ex.: `queries.ts` filtrando `deleted_at IS NULL` antes da `0004` aplicada) devolve 500 em produção até intervenção humana. O comentário em `src/auth/setup.ts:139-146` documenta exatamente esse caminho de atualização — mas nada o dispara automaticamente.

3. **Espelho `.sql` incompleto e perigoso** (`brain-migrations-espelho-incompleto`). `src/db/migrations/` tem 3 arquivos contra 7 migrations runtime (faltam soft-delete, similar_edges, note_media e domains_json_valid), com numeração conflitante (`0002_api_keys.sql` = runtime `0003`; `0003_task_fields.sql` = runtime `0006`). Como `wrangler.toml:33` declara `migrations_dir`, um instalador que rode `wrangler d1 migrations apply` de boa fé aplica um schema errado e desalinhado do `_migrations` da runtime — quebrando o banco.

## Objetivo

`POST /setup/provision` termina num schema consistente em **qualquer** cenário (D1 limpo, re-run, retry após falha no meio de uma migration), roda automaticamente após todo `npm run deploy`, e nenhum caminho documentado ou configurado permite aplicar o espelho `.sql` via wrangler.

## Design proposto

Princípio geral: **nenhuma migration histórica é reescrita** e **nenhum dado existente é tocado** — todas as mudanças são no executor (`runMigrations`), no tooling de deploy e em config/docs. Migrations continuam aditivas.

### 1. Statements de cada migration em `env.DB.batch` (transacional no D1)

Em `src/db/migrate.ts:182-190`, trocar o loop de `.run()` individuais por um único `env.DB.batch()` por migration, incluindo o `INSERT INTO _migrations` **no mesmo batch**:

```ts
export async function runMigrations(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
  ).run();
  const applied = await env.DB.prepare(`SELECT id FROM _migrations`).all<{ id: string }>();
  const appliedIds = new Set((applied.results ?? []).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (appliedIds.has(m.id)) continue;
    const stmts = await filterAlreadyAppliedAlters(env, m.stmts); // ver passo 2
    await env.DB.batch([
      ...stmts.map((s) => env.DB.prepare(s)),
      env.DB.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`).bind(m.id, Date.now()),
    ]);
  }
}
```

`env.DB.batch` é autocommit transacional no D1: ou a migration inteira aplica **e** registra em `_migrations`, ou nada aplica. Isso elimina o estado "parcialmente aplicada e não registrada" daqui pra frente. Manter o comentário existente sobre por que os statements ficam como entradas individuais do array (trigger bodies com `;` interno — `src/db/migrate.ts:3-5`).

Atenção: `@cloudflare/vitest-pool-workers` (usado nos testes, ver `vitest.config.ts`) suporta `DB.batch` — os testes existentes de `queries.ts` já exercitam `env.DB.batch` (`src/db/queries.ts:64,80,135`).

### 2. `ALTER TABLE ADD COLUMN` idempotente via `PRAGMA table_info`

Novo helper em `src/db/migrate.ts` que trata bancos que JÁ estão no estado parcial (instalações de alunos travadas hoje — o batch do passo 1 não conserta o passado):

```ts
// SQLite não tem ADD COLUMN IF NOT EXISTS. Se uma versão antiga do executor
// morreu no meio de uma migration (sem batch), colunas podem já existir sem a
// migration constar em _migrations. Filtra os ALTER ... ADD COLUMN cuja coluna
// já está na tabela, pra que o re-run complete em vez de explodir com
// "duplicate column name".
const ADD_COLUMN_RE = /^ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i;

async function filterAlreadyAppliedAlters(env: Env, stmts: string[]): Promise<string[]> {
  const out: string[] = [];
  const colsByTable = new Map<string, Set<string>>();
  for (const stmt of stmts) {
    const m = ADD_COLUMN_RE.exec(stmt.trim());
    if (!m) { out.push(stmt); continue; }
    const [, table, column] = m;
    if (!colsByTable.has(table)) {
      const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      colsByTable.set(table, new Set((info.results ?? []).map((r) => r.name)));
    }
    if (!colsByTable.get(table)!.has(column)) out.push(stmt);
  }
  return out;
}
```

Observações:
- `PRAGMA table_info` é suportado pelo D1. O nome da tabela vem dos NOSSOS arrays de migration (não de input externo) — sem risco de injeção.
- Preferimos o pré-check via PRAGMA a capturar o erro `duplicate column` porque, com o batch do passo 1, um erro aborta o batch inteiro — não dá pra "pular só o statement que falhou" dentro do batch.
- Se TODOS os statements de uma migration já estiverem aplicados, o batch vira só o `INSERT INTO _migrations` — exatamente o registro que faltava. É assim que um vault travado hoje se autorrepara no próximo `/setup/provision`.
- Caso degenerado: `filterAlreadyAppliedAlters` retornando lista com o mesmo conteúdo não muda nada pra migrations sem `ALTER` (0001, 0002, 0003, 0005, 0007) — o regex não casa e os statements passam direto.

### 3. Provision automático pós-deploy

Fechar a janela humana entre deploy e provision. Trocar o script `deploy` do `package.json` por um wrapper que deploya e chama `/setup/provision` na sequência:

```json
"deploy": "npm run build:bundles && node scripts/deploy.mjs"
```

Novo `scripts/deploy.mjs` (Node >= 18, zero dependências, mesmo estilo de `scripts/setup.mjs`):

1. Roda `wrangler deploy` herdando stdio parcialmente e **capturando stdout** (o wrangler imprime a URL do worker, ex.: `https://<worker>.<subdomain>.workers.dev`). Se o exit code for != 0, propaga e NÃO chama provision.
2. Extrai a URL do output via regex `https:\/\/[\w.-]+\.workers\.dev`. Se não achar (ex.: rota custom domain), aceita fallback pela env `BRAIN_URL`. Se nem assim tiver URL, imprime warning claro (`provision NAO rodou — chame POST <url>/setup/provision manualmente`) e sai com código 1.
3. Faz `POST <url>/setup/provision` com `fetch`, com até 3 tentativas e backoff (2s/5s — cobre o propagation delay do deploy). Qualquer resposta não-2xx ou falha final = exit code 1 com o corpo da resposta no stderr, pra CI/humano ver na hora (equivalente ao `curl -f` da ideia original, mas cross-platform — o repo é instalado por alunos em Windows/Mac/Linux).
4. Loga `provision ok` no sucesso.

`handleProvision` (`src/auth/setup.ts:138-149`) já é seguro pra isso: não-autenticado por design, idempotente, re-run inofensivo.

### 4. Espelho `.sql` saneado (opção barata: desarmar, não sincronizar)

O espelho fica como **referência de leitura**, nunca como caminho de aplicação:

1. **Remover** a linha `migrations_dir = "src/db/migrations"` de `wrangler.toml:33` e de `wrangler.example.toml:28`. Sem `migrations_dir`, `wrangler d1 migrations apply` deixa de enxergar esses arquivos — o footgun desaparece na config de todo instalador novo. NÃO tocar no bloco `[[migrations]]` mais abaixo nos dois arquivos (`wrangler.toml:57`) — aquilo é migration de **Durable Object** (`new_sqlite_classes`), não tem relação com D1.
2. Criar `src/db/migrations/README.md` dizendo, em resumo:
   - Estes `.sql` são **referência/auditoria de schema apenas** — o runtime aplica migrations via `runMigrations()` em `src/db/migrate.ts`, disparado por `POST /setup/provision`.
   - **Nunca** rodar `wrangler d1 migrations apply` neste diretório: a numeração diverge da runtime e o conjunto está incompleto — aplicar quebra o schema e desalinha `_migrations`.
   - Fonte de verdade do schema: array `MIGRATIONS` em `src/db/migrate.ts`.
3. Não renumerar nem completar os `.sql` existentes nesta spec (ver Fora de escopo).

## Fora de escopo

- Reescrever/renumerar migrations históricas (arrays `MIGRATION_000X_STMTS` ficam intactos, ids em `_migrations` idem).
- Completar o espelho `.sql` com as migrations 0004/0005/0007 ou gerar os `.sql` a partir do código — a opção escolhida é desarmar o espelho, não sincronizá-lo.
- Autenticar `/setup/provision` (é idempotente e inofensivo por design; mudar isso é outra discussão).
- Mudanças no wizard `scripts/setup.mjs` (ele já chama provision na instalação inicial e continua funcionando).
- Rollback automático de migrations (down migrations) — D1 + backup via Time Travel cobrem o caso.

## Critérios de aceite

- [ ] Cada migration pendente aplica seus statements + o registro em `_migrations` num único `env.DB.batch` (transacional).
- [ ] `runMigrations` rodado 2x seguidas num D1 limpo termina sem erro e com as 7 linhas em `_migrations` (teste automatizado).
- [ ] Falha simulada no meio da `0006` (colunas `status`/`due_at` já existentes em `notes`, sem linha `0006_task_fields` em `_migrations`) seguida de `runMigrations` termina sem erro, com TODAS as colunas da 0006 presentes, os índices parciais criados e `0006_task_fields` registrada (teste automatizado em `test/migrate.test.ts`).
- [ ] Mesmo cenário pra `0004` (`deleted_at` pré-existente) passa (teste automatizado).
- [ ] `npm run deploy` executa `wrangler deploy` e, em caso de sucesso, faz `POST /setup/provision` na URL do worker; falha do provision resulta em exit code != 0 com mensagem acionável.
- [ ] `wrangler.toml` e `wrangler.example.toml` não contêm mais `migrations_dir` (e o bloco `[[migrations]]` de Durable Object permanece intacto).
- [ ] `src/db/migrations/README.md` existe e explica que os `.sql` são referência e que `wrangler d1 migrations apply` não deve ser usado.
- [ ] Suíte existente continua verde (em especial `test/db.test.ts`, que já cobre idempotência básica em `is idempotent`).
- [ ] Nenhuma migration nova foi adicionada e nenhum dado é modificado — só o executor, tooling e docs mudam.

## Validação

```bash
npm run typecheck
npm test            # vitest run && vitest run --config vitest.auth.config.ts
```

Teste novo `test/migrate.test.ts` (usa `cloudflare:test` como `test/db.test.ts`):
- D1 limpo → `runMigrations` 2x → sem throw, `SELECT count(*) FROM _migrations` = 7.
- Falha parcial simulada: aplicar manualmente `ALTER TABLE notes ADD COLUMN status TEXT ...` e `ALTER TABLE notes ADD COLUMN due_at INTEGER` num banco onde 0001-0005 já rodaram e `_migrations` não tem `0006_task_fields` → `runMigrations` → sem throw; `PRAGMA table_info(notes)` contém `status, due_at, priority, completed_at`; `_migrations` contém `0006_task_fields` e `0007_note_media`.

Teste manual do deploy (em **preview/instalação de teste**, nunca direto em produção):
```bash
npm run deploy          # observar: wrangler deploy ok + "provision ok" no final
curl -sf -X POST https://<worker-de-teste>.workers.dev/setup/provision   # re-run manual: {"ok":true}
```

Gate de release: release nova pros alunos SÓ após merge **e OK explícito do dono do repo**; validar o provision idempotente numa instalação de preview antes de anunciar a versão.

## Arquivos afetados

- `src/db/migrate.ts` — batch por migration + `filterAlreadyAppliedAlters`
- `src/auth/setup.ts` — sem mudança de lógica; atualizar comentário de `handleProvision` se necessário (idempotência agora cobre também estado parcial legado)
- `package.json` — script `deploy` aponta pro wrapper
- `scripts/deploy.mjs` (novo) — wrangler deploy + POST /setup/provision com retry
- `wrangler.toml` e `wrangler.example.toml` — remover `migrations_dir`
- `src/db/migrations/README.md` (novo) — aviso "referência apenas"
- `test/migrate.test.ts` (novo) — idempotência dupla + recuperação de falha parcial (0004 e 0006)

## Riscos e reversão

- **Risco: `DB.batch` com DDL se comportar diferente do `.run()` sequencial em algum caso raro** (ex.: `CREATE VIRTUAL TABLE` fts5 ou triggers dentro de batch). Mitigação: a suíte roda todas as 7 migrations do zero em `@cloudflare/vitest-pool-workers` (mesmo runtime do D1); validar também numa instalação de preview antes da release. Reversão: `git revert` do commit — voltar ao loop `.run()` não corrompe nada, pois o conjunto de statements é idêntico.
- **Risco: regex do `filterAlreadyAppliedAlters` deixar passar um ALTER** (formato inesperado). Impacto = comportamento atual (erro duplicate column), nunca pior que hoje. Os dois únicos formatos existentes (0004 e 0006) são cobertos por teste.
- **Risco: `scripts/deploy.mjs` não extrair a URL** (custom domain, output do wrangler mudar de formato). O script falha ALTO (exit 1 + instrução do POST manual) em vez de silenciar — a janela volta a ser humana, mas visível. Reversão: restaurar `"deploy": "npm run build:bundles && wrangler deploy"` no `package.json`.
- **Risco: remover `migrations_dir` afetar algum fluxo wrangler existente.** Nenhum script do repo usa `wrangler d1 migrations` (verificado por grep); a chave só habilitava o footgun. Reversão: re-adicionar a linha nos dois `.toml`.
- **Dados:** nenhuma mudança toca linhas existentes; todas as operações são DDL aditiva ou metadados (`_migrations`). Em caso de desastre em produção, o D1 tem Time Travel (restore point-in-time) como último recurso.
