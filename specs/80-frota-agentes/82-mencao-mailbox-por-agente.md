# @menção e mailbox por agente

> **Status:** draft (aprovada 11/07/2026) · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `81` (assinatura por credencial — sem autor verificável, menção não tem remetente confiável). Plano-mãe: grupo 80.

## Problema

1. Um agente não tem como ENDEREÇAR outro: comentário em task não suporta @menção de usuário (o `mentions` existente, migration 0015 e `src/mcp/mentions.ts`, é de CONTATOS do vault — outra coisa; não tocar).
2. Um agente não tem como perguntar "o que chegou pra mim?": não existe superfície de não-lidas por usuário. `list_inbox` (migration 0014) é o inbox de CAPTURA do dono — owner-only, fail-closed pra PAT `read` — e não deve ser confundido nem estendido.
3. Sem essas duas peças, a colaboração no board depende do dono mandar cada instância ler task por task.

## Design

Nomenclatura: **mailbox** (por agente) em todo código, tool e UI — nunca "inbox", reservado à captura.

### 1. Migration 0021 (`src/db/migrate.ts`)

`0021_agent_mailbox`:

```sql
CREATE TABLE IF NOT EXISTS mailbox_items (
  id TEXT PRIMARY KEY,            -- mbx_<newId()>
  user_id TEXT NOT NULL,          -- destinatário (users.id)
  kind TEXT NOT NULL,             -- 'mention' | 'assignment' | 'comment_on_assigned'
  task_id TEXT NOT NULL,
  comment_id TEXT,                -- NULL em 'assignment'
  actor_user_id TEXT,             -- quem causou (autor do comentário / de quem atribuiu); NULL = dono via web sem perfil
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mailbox_unread ON mailbox_items(user_id, read_at, created_at);
```

Enum de `kind` fechado em código (mesmo racional do `TaskActivityField` em `src/db/task-activity.ts`).

### 2. Produção de itens (write paths)

- **Menção**: no `comment_task` (e no handler web de comentário do dono), parse do body por `@Nome` — match case-insensitive contra `users` ATIVOS (nome completo entre os delimitadores usuais; `@"Nome Com Espaço"` também aceito). Cada usuário mencionado ≠ autor gera 1 item `mention`. Usuário inexistente = texto inerte (nenhum erro — comentário não é validado contra o cadastro).
- **Atribuição**: `save_task`/`update_task` (e web) ao ADICIONAR um assignee geram item `assignment` pro adicionado (≠ ator). Remoção não gera item.
- **Comentário em task minha**: novo comentário gera item `comment_on_assigned` pra cada assignee ≠ autor que NÃO foi mencionado explicitamente (menção tem precedência, sem duplicar).
- Best-effort deliberado, padrão `logTaskActivity`: falha ao gravar mailbox NUNCA derruba a escrita principal (comentário/task já commitados); erro só no console.
- Dedup: mesmo (user_id, kind, task_id, comment_id) não se repete (INSERT com verificação prévia; corrida ocasional gerando duplicata é aceitável e inofensiva — a leitura agrupa por task).

### 3. Tools MCP novas (`src/mcp/tools/check-mailbox.ts`, `ack-mailbox.ts`)

- `check_mailbox` (leitura, requer `resolveMe`; PAT sem vínculo → erro instrutivo igual spec 81):
  - Input: `{ all?: boolean, since?: number, limit?: número (default 50) }`. Default: só não-lidos do chamador, mais antigos primeiro.
  - Output por item: `{ id, kind, task: {id, title, url}, comment: {id, body, author_user}|null, actor, created_at, created_brt }` + `unread_count`. Body do comentário INCLUÍDO (evita round-trip de get_task pra ler uma linha).
  - Barata por construção: 1 query no índice `idx_mailbox_unread`.
- `ack_mailbox`:
  - Input: `{ ids?: string[], up_to?: number }` (um dos dois) — marca `read_at = now` SÓ de itens do próprio chamador.
  - Ler não marca como lido (leitura idempotente pra heartbeat); ack é ato explícito depois de AGIR.
- Registro no `registry.ts`: `check_mailbox` com `readOnlyHint: true`; `ack_mailbox` escrita. Ambas suprimidas se `resolveMe` não resolver? Não — registradas sempre, erro instrutivo no call (descoberta > sumiço silencioso).

### 4. Board web

- Badge de não-lidas por usuário na visão de tasks (contagem via mesma query do summary).
- Filtro "menções a mim" (dono) e realce visual de `@Nome` resolvido no render do comentário (`comments-render.ts` — render segue INERTE, sem link externo; só span estilizado).

### 5. Instruções MCP (`src/mcp/instructions.ts`)

- Seção nova curta: ao abrir sessão, `check_mailbox`; ao concluir algo que outro agente continua, comentar mencionando `@Nome`; `ack_mailbox` só depois de agir. Regras de conversa (turn limits etc.) ficam na skill (spec 84), não aqui.

## Critérios de aceite

- [ ] Agente A comenta "@PC Notebook faz X" numa task → `check_mailbox` do notebook devolve o item com body e autor assinado; `unread_count` bate.
- [ ] Atribuir task a B gera item `assignment`; comentário novo em task de B gera `comment_on_assigned` sem duplicar quando B também foi mencionado.
- [ ] `ack_mailbox` de A não afeta itens de B; `check_mailbox` não marca lido.
- [ ] `@NomeInexistente` fica inerte (sem erro, sem item).
- [ ] Falha simulada na gravação do mailbox não impede o comentário de ser salvo.
- [ ] `list_inbox`/`resolve_inbox` (captura) intocados.
- [ ] Provision aplica 0021; suite verde (parse de menção, produção dos 3 kinds, ack escopado, best-effort).
- [ ] Ciclo real em produção: mensagem PC → VPS lida via `check_mailbox` sem intervenção do dono.
