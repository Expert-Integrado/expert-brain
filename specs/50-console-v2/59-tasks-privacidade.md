# Tasks privadas: gate de escopo nos read paths de task + bloqueio de share público

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `10-backend/17` (escopos de credencial) e `30-features/31` (coluna `private` + helper `hasScope` + convenção de filtro)
> **Agente sugerido:** Opus (superfície de segurança)

## Contexto

- Task é nota `kind='task'` na MESMA tabela `notes` — a coluna `private` criada pela spec `30-features/31` (migration indicativa `0009_private_notes`) passa a existir nas tasks automaticamente. **Mas a 31 gateia só os read paths de NOTA** (recall, FTS de notas, `get_note`, `expand`, `stats`); os read paths de TASK ficam abertos — um PAT sem escopo `private` continuaria vendo task privada via `list_tasks`/`get_task`.
- Read paths de task hoje:
  - Tools MCP: `list_tasks` (`src/mcp/tools/list-tasks.ts` — usa `listActiveTasks`, `listRecentClosedTasks`, `ftsSearchTasks` de `src/db/queries.ts`), `list_tasks_due_today`, `get_task` (via `getTaskById`, `queries.ts:~432`).
  - Web: board `/app/tasks` (sessão do dono via `requireSession`; bearer `TASK_REMINDER_TOKEN` no `/app/tasks/data` — `src/web/tasks.ts:28`).
  - Cron de lembrete: `listTasksDueBefore` (`queries.ts:~469`).
  - **Share público**: `/s/<token>` (`src/web/share.ts`) serve a task sem login; `createShare` carrega via `getTaskById` (`share.ts:81`) e as tools `share_task`/`unshare_task` criam/revogam o link.
- A spec `50-console-v2/53` adiciona comentários (thread no detalhe + POST público de convidado no `/s/<token>`); a `52` desenha a página de detalhe da task no console.
- Convenções herdadas da 31: `canSeePrivate = hasScope(auth.scopes,'private') || sessão OAuth do dono` (fail-closed); parâmetro aditivo `includePrivate: boolean = false` nas queries; erro de "not found" indistinguível de inexistente.

## Problema / Motivação

- O dono quer task privada de verdade: "pra ninguém ver" — nem agente de nicho com PAT, nem link público. Sem esta spec, o selo da 31 vale pra nota de conhecimento e VAZA nas tasks (`list_tasks` devolve título/corpo/tags de qualquer task pra qualquer credencial válida).
- O share público é o furo mais grave: task privada com link `/s/<token>` vivo ficaria exposta na internet — a 31 nem toca em `share.ts`.

## Design proposto

### 1. Nenhuma migration nova

A coluna `notes.private` (da 31) já cobre tasks. Esta spec é 100% gate de leitura + escrita de flag + UI.

### 2. Filtro nos read paths MCP de task

Mesmo padrão da 31 (parâmetro aditivo, default fail-closed):

- `listActiveTasks`, `listRecentClosedTasks`, `ftsSearchTasks`, `listTasksDueBefore` e `getTaskById` ganham `includePrivate = false` → quando `false`, `AND private = 0`.
- `list_tasks`, `list_tasks_due_today`, `get_task` computam `canSeePrivate` (auth propagado pelo registry — a 17 propaga às tools de escrita, a 31 estende às de LEITURA; esta spec reusa esse repasse) e injetam nas queries. `get_task` de task privada pra caller sem escopo = mesmo erro de task inexistente.
- Call sites do DONO passam `true`: board web com `requireSession` (`src/web/tasks.ts`), cron de lembrete (`listTasksDueBefore` — o digest vai pro próprio dono; decisão espelhada na 31, que trata `GRAPH_EXPORT_TOKEN`/graph como superfície do dono; o bearer `TASK_REMINDER_TOKEN` idem).

### 3. Share público: privado NUNCA tem link

- `share_task` (tool) e `createShare` (`src/web/share.ts:~69-107`): task com `private = 1` → `toolError`/erro claro ("task privada não pode ter link público; torne-a pública primeiro").
- **Marcar privada revoga share vivo**: no UPDATE que seta `private = 1` (tool ou UI), limpar `share_token`/`share_expires_at` NA MESMA escrita e informar no retorno ("link público revogado"). Fail-closed: nunca existe o estado (privada + token vivo).
- Defesa em profundidade: a rota pública `GET /s/<token>` adiciona `AND private = 0` no lookup — mesmo que o estado proibido surja (escrita manual no banco), a página responde o 404 padrão.
- Se a `53` já estiver implementada: o POST público de comentário (`/s/<token>/comment`) usa o mesmo lookup → herda o bloqueio (critério condicional abaixo).

### 4. Escrita da flag (espelha a 31)

- `save_task` ganha `private: z.boolean().optional()` (default false); `update_task` aceita `private: true` SOMENTE (`false` → `toolError` orientando pra UI logada) — one-way via MCP, desmarcar só com sessão.
- UI: toggle "Tornar privada / Tornar pública" na página de detalhe da task (layout da `52`; se a `52` não rodou, no quick-edit atual) → `POST /app/tasks/private { id, private }`, protegido por `requireSession` APENAS (único lugar que desmarca). Ao marcar privada com share vivo, o server revoga o link (item 3) e a UI atualiza o bloco de share.
- Badge `🔒 privada` no card do board e no detalhe (mesmo padrão visual da 31 nas notas).

### 5. Interações com vizinhas (registrar, não implementar)

- `list_tasks` com `query` usa `ftsSearchTasks` — o filtro do item 2 cobre; nenhum caminho FTS separado resta aberto.
- Comentários (`53`): thread só é lida via `get_task` (gated) e páginas (sessão/share) — sem read path novo.
- Projetos (`58`): contador de tasks por projeto na config é superfície de sessão (vê tudo); nenhum gate extra.

## Fora de escopo

- Migration (coluna vem da 31); escopo/credencial (vem da 17).
- Privacidade de contatos (spec `50-console-v2/61`).
- Task privada com share "protegido por senha" (não existe meio-termo: privada = sem link).
- Auditoria de quem marcou/desmarcou.

## Critérios de aceite

- [x] PAT **sem** escopo `private` (incluindo `full`): `list_tasks` (com e sem `query`/`status`/`tag`), `list_tasks_due_today` e `get_task` não retornam nem contam task privada; `get_task` de privada = erro de inexistente.
- [x] PAT **com** escopo `private` e sessão do dono: veem tudo; board mostra badge; cron de lembrete inclui privadas.
- [x] `share_task`/`createShare` numa task privada → erro claro; nada persiste.
- [x] Marcar task privada (tool ou UI) com share vivo → `share_token`/`share_expires_at` limpos na mesma escrita; `GET /s/<token>` antigo responde 404.
- [x] `GET /s/<token>` tem `AND private = 0` no lookup (teste com estado forjado no banco).
- [x] `save_task private:true` grava; `update_task private:false` → erro orientando UI; toggle web funciona nos dois sentidos e exige sessão (PAT/bearer → 401/redirect).
- [x] (Condicional, se `53` implementada) POST público de comentário em task que virou privada → 404.
- [x] Suíte de vazamento por superfície de task (um teste por read path) passa; `npm run typecheck` e `npm test` verdes.

## Validação

- Testes novos em `test/tools/private-tasks.test.ts`: seed 2 tasks públicas + 1 privada (com tag e due), caller sem escopo por superfície; caller com escopo vê tudo; share block + revogação no toggle; rota pública com estado forjado.
- Manual (`wrangler dev`): marcar task privada com link vivo → conferir 404 no link; PAT `full` sem `private` via cliente MCP real não lista a task.
- **Gate de deploy:** `wrangler deploy` só com OK explícito do dono da instância (rodar o roteiro de vazamento ANTES, igual à 31).

## Arquivos afetados

- `src/db/queries.ts` (`includePrivate` nas 5 queries de task)
- `src/mcp/tools/list-tasks.ts`, `list-tasks-due-today.ts`, `get-task.ts` (gate), `save-task.ts`, `update-task.ts` (flag), `share-task.ts` (bloqueio)
- `src/web/share.ts` (bloqueio no create + filtro na rota pública)
- `src/web/tasks.ts` + `src/web/client/tasks.ts` (badge, toggle, includePrivate=true na sessão)
- `src/web/handler.ts` (rota `POST /app/tasks/private`)
- `test/tools/private-tasks.test.ts` (novo)

## Riscos e reversão

- **Risco**: read path de task novo no futuro (ex.: digest novo) nascer sem o filtro. Mitigação: mesma disciplina da 31 — teste por superfície é critério de aceite; a constante/convenção `includePrivate` fica documentada em `queries.ts`.
- **Risco**: dono marca privada esquecendo que o link estava compartilhado com alguém que precisava. Aceito: o retorno avisa "link revogado" — comportamento explícito.
- **Reversão**: revert do código volta ao estado da 31 (tasks visíveis a qualquer credencial). Se houver task sensível marcada, avisar o dono ANTES do rollback (mesma nota da 31).
