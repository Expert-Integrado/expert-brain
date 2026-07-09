# Usuários (pessoa + agente) e responsáveis nas tasks

> **Status:** shipped (09/07/2026 — deploy 7580fc7c; migration 0017 aplicada no D1 de produção e verificada via get_task real: `assignees`/`created_by` no payload) · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-brain
> **Depende de:** 10-backend/17 (autoria created_by/updated_by), 50-console-v2 (board/projetos/config)

## Contexto

O board de tasks (`/app/tasks`) é individual: não existe o conceito de "responsável" (a bolinha de
usuário do ClickUp). O dono do vault, porém, opera com VÁRIAS instâncias de agente (máquinas/
containers distintos rodando Claude Code ou similares) além dele mesmo — e quer distribuir tarefas:
"ir ao shopping" é do humano; "revisar os sites" é de um agente; "subir um site" pode ser dos dois.

O que o repo JÁ tem e esta spec reusa:

- **Autoria de escrita** (spec 10-backend/17, migration `0012`): `notes.created_by`/`updated_by`
  gravam `api_keys.id` (PAT) ou `oauth:<email>` em toda escrita (`writeActor`, `src/mcp/helpers.ts`).
  Ou seja, "qual dispositivo criou a task" já está no banco — falta só RESOLVER isso pra um perfil
  visível.
- **PATs** (`api_keys`: id, name, prefix, scopes) — cada instância de agente conecta com um PAT
  próprio. A identidade do usuário-agente é o PAT (decisão do dono, 09/07/2026; mesmo desenho do
  Paperclip, que usa `agent_api_keys`).
- **Padrão de referência resolvível** (`src/mcp/tools/project-ref.ts`): resolver `id | label`
  case-insensitive com erros orientados.
- **R2** (binding `MEDIA`) já serve mídia de notas (`src/media/store.ts`).
- **Benchmark** (Paperclip v2026.428.0, `packages/db/src/schema`): `issues.assignee_agent_id` +
  `issues.assignee_user_id` (pessoa E agente na mesma issue), tabela `agents` com perfil/ícone,
  índice `(company, assignee, status)` pra fila "minhas tasks".

Decisões do dono (09/07/2026):

1. Identidade do agente = **vinculada ao PAT** (perfil aponta pro `api_keys.id`).
2. Foto = **upload de imagem real** já no MVP (R2).
3. **Dois campos distintos**: "criado por" (dispositivo/credencial — automático, trilha de
   auditoria) e "responsáveis" (escolhidos por quem cria, task a task, sem regra fixa).
4. Escopo MVP = **atribuição + filtro** ("minhas tasks"). Distribuição automática por cron em cada
   instância = fase 2, fora desta spec.

## Problema / Motivação

- Não dá pra saber no board o que é do humano e o que é de cada agente — cobrança vira varredura
  manual.
- `created_by` existe mas é ilegível (id de PAT); nenhuma superfície mostra QUEM criou.
- Sem "minhas tasks", a fase 2 (cada instância executa as tasks dela nos prazos) não tem fundação.

## Design proposto

### 1. Migration `0017_users` (aditiva, em `src/db/migrate.ts`)

```sql
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,                 -- user_xxxxxxxx
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'person',   -- 'person' | 'agent'
  bio         TEXT,                             -- pra quê serve / o que faz
  api_key_id  TEXT REFERENCES api_keys(id),     -- identidade do usuário-agente (PAT)
  avatar_key  TEXT,                             -- objeto R2 (avatars/<id>) quando tem foto
  avatar_mime TEXT,
  is_owner    INTEGER NOT NULL DEFAULT 0,       -- 1 só no perfil-pessoa do dono
  archived_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_assignees (
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);
INSERT OR IGNORE INTO users (id, name, type, is_owner, created_at, updated_at)
  VALUES ('user_owner', 'Dono', 'person', 1, 0, 0);
```

`users` NÃO é login (o vault continua single-owner com sessão + PATs): é perfil de atribuição —
nome, foto, tipo. O seed `user_owner` garante que "só eu" é atribuível desde o primeiro dia
(rename/foto no console). Sem cap próprio além do bom senso (CAP 64, igual projetos).

### 2. Resolução de referência e identidade (`src/mcp/tools/user-ref.ts`)

- `resolveUserRef(env, ref, auth)` aceita: id exato (`user_...`), nome (case-insensitive, ativos)
  ou **`me`** (a identidade de quem chama: PAT → user com `api_key_id = auth.keyId`; sessão OAuth
  → user `is_owner = 1`).
- **NÃO auto-cria** (diferente de projeto): usuário é identidade — criar é ato deliberado no
  console. Ref sem match → erro listando os usuários ativos disponíveis.
- Usuário arquivado → erro orientando desarquivar (não atribuível; histórico preservado).

### 3. Tools MCP

- `save_task` / `update_task`: novo param `assignees?: string[]` (refs). No update é
  **replace-set** (`[]` limpa). Resposta ecoa `assignees: [{id, name, type}]`.
- `list_tasks`: novo filtro `assignee?: string` (ref, incl. `me`); cada task retorna `assignees`.
- `list_tasks_due_today`: cada task retorna `assignees` (o agente da instância vê o que é dele).
- `get_task`: retorna `assignees` + `created_by` resolvido:
  `{actor, user: {id,name,type} | null, key_name: string | null}`.
- Nova tool **`list_users`** (read-only): lista usuários ativos `{id, name, type, bio, is_me}` —
  é como um agente descobre a quem atribuir.
- `src/mcp/instructions.ts`: 1 parágrafo sobre responsáveis (criador decide task a task; usar
  `assignee: 'me'` pra fila própria).

### 4. Console (`/app`)

- **Config → seção "Usuários"** (`src/web/config.ts` + `config-script.ts`): lista (avatar, nome,
  tipo, PAT vinculado), criar/editar (nome, tipo, bio, dropdown de PATs ativos p/ agente), foto
  (upload ≤ 2 MB → R2 `avatars/<id>`), arquivar/desarquivar. Endpoints de sessão:
  `GET /app/config/users/data`, `POST /app/config/users` (create),
  `POST /app/config/users/:id` (update/archive), `POST /app/config/users/:id/avatar` (upload),
  `GET /app/users/:id/avatar` (serve a foto, gated por sessão).
- **Board** (`src/web/tasks.ts` SSR): bolinhas de responsável no card (foto ou iniciais+cor
  determinística; máx 3 + "+N").
- **Detalhe da task** (`src/web/notes.ts` sidebar): seção "Responsáveis" (picker com os usuários
  ativos, POST `/app/tasks/assignees` `{id, user_ids}`) e "Criado por" (perfil resolvido do
  `created_by`, ou o nome do PAT quando não há perfil vinculado).

### 5. Fora do escopo (fase 2, spec futura)

Distribuição/execução automática (cron por instância puxando `assignee: me` + due), notificação
por responsável, múltiplos donos-pessoa.

## Arquivos afetados

- `src/db/migrate.ts` (migration 0017) · `src/db/queries.ts` (users CRUD, assignees, filtro)
- `src/mcp/tools/user-ref.ts` (novo) · `save-task.ts` · `update-task.ts` · `list-tasks.ts` ·
  `list-tasks-due-today.ts` · `get-task.ts` · `list-users.ts` (novo) · `registry.ts` ·
  `instructions.ts`
- `src/web/config.ts` · `config-script.ts` · `handler.ts` · `tasks.ts` · `notes.ts` ·
  `client/tasks.ts` (render assignees) · novo endpoint de avatar
- `test/users-*.test.ts` (novos) + testes existentes que asseram shapes de resposta

## Critérios de aceite

- [x] Migration 0017 aplica em D1 zerado E em D1 existente (aditiva; seed `user_owner`).
- [x] `save_task` com `assignees: ['me']` via PAT vinculado grava o vínculo; ref desconhecido dá
      erro com a lista de usuários; usuário arquivado não é atribuível.
- [x] `update_task` com `assignees: []` limpa; replace-set não duplica.
- [x] `list_tasks` com `assignee: 'me'` (PAT → perfil) devolve só as tasks do perfil; cada task
      ecoa `assignees`.
- [x] `get_task` resolve `created_by` (perfil vinculado ao PAT, ou nome do PAT, ou `oauth:`).
- [x] `list_users` devolve ativos com `is_me` correto por PAT e por sessão OAuth.
- [x] Console: CRUD de usuários + upload de foto (rejeita > 2 MB e mime não-imagem) + avatar
      servido gated por sessão; board mostra bolinhas; detalhe permite atribuir/desatribuir.
- [x] Task privada: assignees seguem a visibilidade da task (nenhum vazamento em list/get sem
      escopo `private` — a task inteira já some nos read paths gateados; assignees só saem
      dentro do objeto task).
- [x] Zero PII em fixtures/testes (nomes fictícios: Ana Almeida, Bruno Castro, Claude VPS).

Cobertura: `test/users-queries.test.ts` (16), `test/tools/users-assignees-mcp.test.ts` (9),
`test/users-web.test.ts` (10) — suíte completa 866/866 verde. Restore: `users`/`task_assignees`
entraram no `TABLE_ORDER` do runbook e o passo 5 do `docs/restore.md` limpa os seeds antes do import.

## Validação

```bash
npm run typecheck
npm test
npm run build:bundles   # + git diff --exit-code assets/ (só EOL = restaurar)
```
