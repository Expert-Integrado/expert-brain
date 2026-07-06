# Escopos de credencial: PAT com scopes, AuthContext propagado, bearer por rota e revogação lógica

> **Status:** done · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O Expert Brain aceita três famílias de credencial hoje, e nenhuma delas tem escopo:

1. **PAT (`eb_pat_...`)** — criado em `/app/config` (`src/web/api-keys.ts` → `createApiKey` em `src/auth/api-keys.ts:48`), armazenado como SHA-256 em `api_keys` (schema em `src/db/migrate.ts:83-96`, migração `0003_api_keys`). O worker valida em `src/index.ts:27-37`: `validateApiKey` (`src/auth/api-keys.ts:91`) devolve **só o e-mail do dono**, e o handler injeta `props = { email, loggedInAt }` no Durable Object do MCP.
2. **OAuth 2.1** — via `@cloudflare/workers-oauth-provider` (`src/index.ts:12-20`), que popula os mesmos `props` (`AuthContext` em `src/env.ts:39-42`).
3. **Bearer estático de rota web** — `authorizeBearer` em `src/web/bearer-auth.ts:19-25` aceita `GRAPH_EXPORT_TOKEN` **ou** `TASK_REMINDER_TOKEN` de forma intercambiável; é usado em `src/web/tasks.ts:28` e `src/web/media.ts:17`. Existe ainda uma cópia local `authorizeGraphExport` em `src/web/graph-data.ts:16-27` que aceita só `GRAPH_EXPORT_TOKEN`.

No lado MCP, `ExpertBrainMCP.init()` (`src/mcp/agent.ts:13-17`) apenas checa a **presença** dos props e chama `registerAllTools(this.server, this.env)` (`src/mcp/registry.ts:22`) — o `AuthContext` é descartado; nenhuma tool sabe quem chamou nem com que permissão. Todas as 20+ tools (incl. `delete_note`, `reembed`, `delete_note_media`) ficam disponíveis pra qualquer token válido.

## Problema / Motivação

- **PAT vazado = CRUD total.** `validateApiKey` (`src/auth/api-keys.ts:91-103`) retorna apenas `owner_email`; `registerAllTools` (`src/mcp/registry.ts:22-45`) registra todas as tools sem olhar auth. Um PAT criado pra um agente que só precisa de `recall` pode deletar o vault inteiro e exportar todos os contatos (`registerContactsTools`, `src/mcp/registry.ts:44`).
- **Auth props ignorados no registry.** `src/mcp/agent.ts:14-16` valida presença e joga fora o contexto: `registerAllTools(this.server, this.env)` — sem `auth`, é impossível gatear por escopo ou atribuir autoria de escrita.
- **Scope creep dos bearers web.** `src/web/bearer-auth.ts:24` retorna `tokenMatches(got, env.GRAPH_EXPORT_TOKEN) || tokenMatches(got, env.TASK_REMINDER_TOKEN)` — os dois tokens são intercambiáveis. Como `src/web/media.ts:17` (`authReq`) usa esse helper e `handleMediaDelete` (`src/web/media.ts:100-103`) passa por ele, o token do cron de lembrete de tasks consegue **deletar mídia**.
- **`revoked_at` é código morto.** O check `if (row.revoked_at) return null` existe em `src/auth/api-keys.ts:98`, mas `revokeApiKey` (`src/auth/api-keys.ts:84-89`) faz `DELETE` — a linha nunca sobrevive pra ser checada. Sem trilha de auditoria de chaves revogadas.
- **`last_used_at` em promise flutuante.** `src/auth/api-keys.ts:100-101` dispara o `UPDATE` sem `await` nem `ctx.waitUntil` — o runtime do Workers pode cancelar a promise depois que a resposta é enviada, e o "último uso" fica silenciosamente desatualizado.
- **Comentário de timing mente.** `src/web/bearer-auth.ts:3-4` promete "não vaza o tamanho do segredo", mas a linha 7 (`if (got.length !== expected.length) return false`) retorna cedo justamente por tamanho. Mesmo padrão duplicado em `src/web/graph-data.ts:23`.

Esta spec é também o pré-requisito estrutural do escopo `private` / selo de privacidade (spec `30-features/31`).

## Objetivo

Nenhuma credencial do sistema pode mais do que precisa: PAT ganha escopo (`full` | `read`) aplicado no registro de tools, bearers web viram escopados por rota (`graph` | `tasks` | `media`), revogação vira lógica (auditável) e todo write MCP grava autoria — sem quebrar nenhum token existente.

## Design proposto

### 1. Migração aditiva — `scopes` em `api_keys` + colunas de autoria

Em `src/db/migrate.ts`, adicionar ao array `MIGRATIONS` (`src/db/migrate.ts:166-174`):

```ts
// 0012 — escopo de PAT + autoria de escrita. ADD COLUMN é seguro (não recria tabela).
// DEFAULT 'full' preserva o comportamento de TODAS as chaves existentes.
// (O número 0008 citado nesta spec era indicativo — o trilho já ia até 0011_task_projects,
//  então usou-se o próximo livre: 0012. Ver regra transversal em specs/90-roadmap.md.)
const MIGRATION_0012_STMTS: string[] = [
  `ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT 'full'`,
  `ALTER TABLE notes ADD COLUMN created_by TEXT`,
  `ALTER TABLE notes ADD COLUMN updated_by TEXT`,
];
// ...
{ id: '0012_api_key_scopes', stmts: MIGRATION_0012_STMTS },
```

Valores iniciais de `scopes`: `'full'` | `'read'` (string simples; se um dia virar lista, migra pra CSV/JSON sem quebrar). `created_by`/`updated_by` guardam o **id da api key** (`api_keys.id`) ou `'oauth:<email>'` pra sessões OAuth — nullable, notas antigas ficam NULL. Nunca fazer `DROP`/rebuild: migrations sempre aditivas (rebuild cascatearia edges/tags, ver comentário em `src/db/migrate.ts:64-66`).

Espelhar num arquivo `src/db/migrations/0004_api_key_scopes.sql` seguindo o padrão da pasta (hoje tem `0001_init.sql`, `0002_api_keys.sql`, `0003_task_fields.sql`).

### 2. `validateApiKey` retorna escopo + id; `last_used_at` via `waitUntil`

Em `src/auth/api-keys.ts`:

```ts
export type ApiKeyScope = 'full' | 'read';

export interface ValidatedApiKey {
  email: string;
  scopes: ApiKeyScope;
  keyId: string;
}

export async function validateApiKey(
  env: Env,
  plainKey: string,
  ctx?: ExecutionContext
): Promise<ValidatedApiKey | null> {
  // SELECT id, owner_email, scopes, revoked_at ... (o check de revoked_at da linha 98 vira código VIVO)
  // last_used_at: trocar a promise flutuante (linhas 100-101) por
  // ctx?.waitUntil(env.DB.prepare(...).run().catch(() => {})) — fallback pro fire-and-forget se ctx ausente.
}
```

- `ApiKeyRow` (`src/auth/api-keys.ts:24-32`) ganha `scopes: string`.
- `createApiKey` (`src/auth/api-keys.ts:48`) ganha parâmetro `scopes: ApiKeyScope = 'full'` e o inclui no INSERT (`src/auth/api-keys.ts:67-69`).
- Atenção ao comentário em `src/auth/api-keys.ts:53-54` ("revokeApiKey hoje faz DELETE, então count(*) bate"): o count do cap `MAX_ACTIVE_KEYS` já filtra `revoked_at IS NULL` (linha 56), então continua correto após o item 3 — só atualizar o comentário.

### 3. Revogação lógica

`revokeApiKey` (`src/auth/api-keys.ts:84-89`) troca `DELETE` por:

```sql
UPDATE api_keys SET revoked_at = ? WHERE id = ? AND owner_email = ? AND revoked_at IS NULL
```

Com isso o check `if (row.revoked_at) return null` (`src/auth/api-keys.ts:98`) deixa de ser código morto. Na UI (`src/web/config.ts:85-103`), a listagem passa a mostrar chaves revogadas com badge `● revogada` (sem botão Excluir) — ou, no mínimo, `listApiKeys` continua listando tudo e a linha revogada troca o badge `● ativa` (linha 97) condicionalmente. Não expor rota de "un-revoke".

### 4. Propagar `AuthContext` até as tools + gate por escopo

- `AuthContext` (`src/env.ts:39-42`) ganha campos opcionais:

```ts
export interface AuthContext extends Record<string, unknown> {
  email: string;
  loggedInAt: number;
  scopes?: 'full' | 'read'; // ausente = 'full' (sessões OAuth existentes)
  keyId?: string;           // id do PAT; ausente em OAuth
}
```

- `src/index.ts:29-36`: usar o novo retorno — `const validated = await validateApiKey(env, plainKey, ctx)` e `props = { email: validated.email, loggedInAt: Date.now(), scopes: validated.scopes, keyId: validated.keyId }`.
- `src/mcp/agent.ts:16`: `registerAllTools(this.server, this.env, auth)`.
- `src/mcp/registry.ts:22`: nova assinatura `registerAllTools(server: any, env: Env, auth: AuthContext)`. Gate: quando `auth.scopes === 'read'`, **não registrar** as tools de escrita (as com `readOnlyHint: false` nas annotations) — o cliente nem as enxerga no `tools/list`. Ficam registradas só: `recall`, `expand`, `get_note`, `stats`, `list_tasks`, `list_tasks_due_today`, `get_note_media` e as tools de contatos (todas `readOnlyHint: true`, ver `src/mcp/tools/contacts.ts:35-97`). Bloqueadas em `read`: `save_note`, `update_note`, `delete_note`, `restore_note`, `link`, `reembed`, `save_task`, `complete_task`, `update_task`, `attach_media`, `delete_note_media`.
- **Autoria:** as funções `register*` das tools de escrita ganham o parâmetro `auth` e gravam `created_by` (no INSERT de `save_note`/`save_task`) e `updated_by` (nos UPDATEs de `update_note`/`update_task`/`complete_task`/`delete_note`/`restore_note`), com valor `auth.keyId ?? \`oauth:${auth.email}\``. Isso exige estender as queries em `src/db/queries.ts` de forma aditiva (novos parâmetros opcionais; chamadas existentes continuam compilando com default `null`). É fundação de auditoria — não construir UI de auditoria nesta spec.

### 5. Bearer web escopado por rota

`src/web/bearer-auth.ts` vira:

```ts
export type BearerScope = 'graph' | 'tasks' | 'media';

// graph: GRAPH_EXPORT_TOKEN · tasks: TASK_REMINDER_TOKEN ou GRAPH_EXPORT_TOKEN
// (o Console também opera tasks) · media: só GRAPH_EXPORT_TOKEN — o token do
// cron de lembrete NÃO pode mais tocar mídia.
export async function authorizeBearer(req: Request, env: Env, scope: BearerScope): Promise<boolean>
```

- `src/web/tasks.ts:28` → `authorizeBearer(req, env, 'tasks')` (o `authTask` já é async).
- `src/web/media.ts:17` → `authorizeBearer(req, env, 'media')` (o `authReq` já é async).
- `src/web/graph-data.ts:16-27`: **deletar** a cópia local `authorizeGraphExport` e usar `authorizeBearer(req, env, 'graph')` nos três call sites (`src/web/graph-data.ts:191`, `:273`, `:306`) — elimina a duplicação.

### 6. Comparação de token sem vazar tamanho

Substituir `tokenMatches` (`src/web/bearer-auth.ts:5-11`) por hash-then-compare: calcular SHA-256 de `got` e de `expected` (via `crypto.subtle.digest`, mesmo helper de `src/auth/api-keys.ts:11-14` — extrair pra `src/util/` se preciso) e comparar os digests byte a byte em tempo constante. Digests têm tamanho fixo (32 bytes), então o early-return por tamanho some e o comentário das linhas 3-4 passa a ser verdadeiro. A função vira `async` — compatível com o item 5.

### 7. UI de criação com escolha de escopo

- `src/web/config.ts:193-198` (form "Criar nova chave"): adicionar um `<select name="scope">` com opções `full` ("Leitura e escrita — CRUD completo do vault") e `read` ("Somente leitura — recall, get, stats, list"), default `full`.
- `src/web/api-keys.ts:31-55` (`handleApiKeyCreate`): ler `form.get('scope')`, validar contra `['full','read']` (valor inválido → `full`), passar pro `createApiKey`.
- Tabela "Suas chaves" (`src/web/config.ts:94-101`): nova coluna "Escopo" exibindo `full`/`read`.

### 8. Gate de release

Após deploy validado: rotacionar os PATs de todas as instâncias existentes do dono do vault (**com OK explícito dele**, uma a uma) pra que as chaves novas já nasçam com escopo mínimo; só então liberar a versão pros demais usuários.

## Fora de escopo

- Escopo `private` e o filtro de notas privadas correspondente (spec `30-features/31`, que **depende desta**).
- Scopes no fluxo OAuth (consent screen com escolha de permissão) — sessão OAuth continua equivalente a `full`.
- UI/relatório de auditoria em cima de `created_by`/`updated_by` (aqui só grava).
- Expiração automática de PAT (TTL) e rate limiting.
- Migrar `GRAPH_EXPORT_TOKEN`/`TASK_REMINDER_TOKEN` pra PATs de banco — continuam secrets de ambiente, só ganham escopo por rota.

## Critérios de aceite

- [x] Migração `0012_api_key_scopes` aplicada; chaves pré-existentes seguem funcionando com comportamento idêntico (`scopes='full'` via DEFAULT), zero linha alterada em `notes`.
- [x] `validateApiKey` retorna `{ email, scopes, keyId }` e `null` pra chave revogada (check de `revoked_at` coberto por teste — não é mais código morto).
- [x] `revokeApiKey` faz `UPDATE ... SET revoked_at` (não `DELETE`); a linha permanece no banco e a UI a exibe como revogada; chave revogada é recusada no `/mcp` com 401.
- [x] `last_used_at` atualizado via `ctx.waitUntil` quando `ctx` disponível (sem promise flutuante em `src/index.ts` → `validateApiKey`).
- [x] PAT com `scopes='read'`: `tools/list` no MCP retorna **apenas** tools com `readOnlyHint: true`; chamar qualquer tool de escrita é impossível (não registrada).
- [x] PAT com `scopes='full'` e sessão OAuth: conjunto de tools idêntico ao atual (nenhuma regressão).
- [x] Writes via MCP gravam `created_by`/`updated_by` com `keyId` (PAT) ou `oauth:<email>` (OAuth).
- [x] `TASK_REMINDER_TOKEN` autoriza `/app/tasks/*` e **recebe 401/redirect** em `/app/notes/{id}/media` (upload) e no delete de mídia; `GRAPH_EXPORT_TOKEN` segue autorizando graph, tasks e media.
- [x] `authorizeGraphExport` removido de `src/web/graph-data.ts`; os três call sites usam `authorizeBearer(req, env, 'graph')`.
- [x] `tokenMatches` compara digests SHA-256 de tamanho fixo — sem early-return por tamanho do input; comentário condiz com o código.
- [x] Form de criação em `/app/config` permite escolher `full`/`read`; valor inválido cai em `full`; tabela mostra a coluna Escopo.
- [x] `npm run typecheck` e `npm test` verdes.

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck        # tsc --noEmit (worker + client)
npm test                 # vitest run && vitest run --config vitest.auth.config.ts
```

Testes novos (criar `test/api-keys.test.ts` — não existe hoje; `test/auth.test.ts` só cobre password):
- `createApiKey` com `scopes='read'` → `validateApiKey` retorna `scopes:'read'` e `keyId`.
- `revokeApiKey` → linha persiste com `revoked_at` setado → `validateApiKey` retorna `null`.
- Cap `MAX_ACTIVE_KEYS` conta só ativas (revogadas não contam).
- `registerAllTools` com `auth.scopes='read'` não registra tools de escrita (mock de server que coleta nomes registrados).
- `authorizeBearer(..., 'media')` recusa `TASK_REMINDER_TOKEN` e aceita `GRAPH_EXPORT_TOKEN`; tokens de tamanhos diferentes do esperado não geram caminho de retorno distinto (assert funcional; timing em si não é testável em unit).

Teste manual (preview/local com `wrangler dev`):
1. Criar chave `read` em `/app/config`, conectar um cliente MCP com ela → confirmar que `save_note` não aparece em `tools/list` e `recall` funciona.
2. Criar chave `full` → CRUD completo funciona; nota criada tem `created_by` = id da chave (checar via query D1).
3. Revogar a chave `read` → próxima chamada `/mcp` retorna 401; linha segue visível na UI como revogada.
4. `curl -H "Authorization: Bearer $TASK_REMINDER_TOKEN"` em `/app/tasks/data` (200) e em delete de mídia (401/redirect).

**Deploy em produção SOMENTE com OK explícito do dono do vault.** Após deploy: rotação assistida dos PATs de todas as instâncias (item 8 do design), uma a uma, com OK do dono em cada.

## Arquivos afetados

- `src/db/migrate.ts` — migração `0012_api_key_scopes` (scopes + created_by/updated_by)
- `src/db/migrations/0004_api_key_scopes.sql` — espelho SQL (novo)
- `src/auth/api-keys.ts` — `ValidatedApiKey`, `scopes` no create/list, revogação lógica, `waitUntil`
- `src/index.ts` — passar `ctx` ao `validateApiKey`; props com `scopes`/`keyId`
- `src/env.ts` — `AuthContext` com `scopes?`/`keyId?`
- `src/mcp/agent.ts` — repassar `auth` ao registry
- `src/mcp/registry.ts` — gate por escopo; repasse de `auth` às tools de escrita
- `src/mcp/tools/*` (tools de escrita) + `src/db/queries.ts` — gravar `created_by`/`updated_by` (parâmetros aditivos)
- `src/web/bearer-auth.ts` — `BearerScope` + hash-then-compare
- `src/web/graph-data.ts` — remover `authorizeGraphExport`, usar `authorizeBearer(..., 'graph')`
- `src/web/tasks.ts`, `src/web/media.ts` — escopo `'tasks'`/`'media'`
- `src/web/config.ts` — select de escopo no form + coluna Escopo + badge revogada
- `src/web/api-keys.ts` — parse/validação do `scope` no create
- `test/api-keys.test.ts` — suíte nova (não existe hoje)

## Riscos e reversão

- **Risco: agente externo com PAT antigo perde acesso.** Mitigado: DEFAULT `'full'` na migração — chaves existentes não mudam de comportamento até serem rotacionadas.
- **Risco: consumidor do `TASK_REMINDER_TOKEN` usava (indevidamente) rotas de mídia.** O item 5 quebra esse uso de propósito; validar antes do deploy que o cron de lembrete só chama `/app/tasks/data`.
- **Risco: tools de escrita com assinatura nova quebram registro.** Coberto por typecheck + teste do registry.
- **Rollback:** `wrangler rollback` (ou redeploy do commit anterior). As colunas novas (`scopes`, `created_by`, `updated_by`) são inofensivas pro código antigo — SELECTs existentes não as referenciam, INSERTs antigos deixam NULL/DEFAULT — então **não é preciso reverter a migração** (e não reverter: `_migrations` já a marca aplicada). Único cuidado: chaves revogadas no período novo viram linhas com `revoked_at` que o código antigo também respeita (`if (row.revoked_at)` já existia) — revogação permanece efetiva após rollback.
