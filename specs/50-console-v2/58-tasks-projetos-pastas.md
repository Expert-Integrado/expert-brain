# Tasks: projetos (pastas) — agrupamento first-class com filtro no board e no MCP

> **Status:** ready · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-brain
> **Depende de:** `50-console-v2/51` (render dinâmico do board) · suave: `50-console-v2/52` (anatomia do card — o chip de projeto entra no card desenhado lá)
> **Agente sugerido:** Opus (schema + contrato MCP)

## Contexto

- Task é nota `kind='task'` na tabela `notes` (migration `0006_task_fields`); não existe NENHUM eixo de agrupamento além de `domains` (herdado de nota, semântica de área de conhecimento) e tags.
- A única forma de simular "projeto" hoje é tag: a description do `list_tasks` sugere literalmente usar tag como projeto (`src/mcp/tools/list-tasks.ts:11` — "a contact name, a project, or maquina:pc-principal") e o filtro é `tag` case-insensitive (`list-tasks.ts:70-77`). Tag é multi-valorada, sem cor, sem gestão (criar/renomear/arquivar), sem UI de filtro no board.
- Params atuais do `list_tasks`: `query`, `status`, `include_closed`, `tag`, `limit` (`src/mcp/tools/list-tasks.ts:7-13`). `save_task`/`update_task`/`get_task`/`complete_task` em `src/mcp/tools/*-task.ts`.
- Queries de task em `src/db/queries.ts`: `TaskRow` (~335-346), `getTaskById` (~432), `listActiveTasks`, `listRecentClosedTasks` (~456), `ftsSearchTasks`, `listTasksDueBefore` (~469, usado pelo cron de lembrete).
- Board: após a spec `51`, colunas vêm do banco (`kanban_columns`) e o render é dinâmico em `src/web/tasks.ts` + `src/web/client/tasks.ts`. Config page: `/app/config` (`src/web/config.ts`), onde a `51` cria a seção "Quadro de tarefas".
- Migrations runtime: array `MIGRATIONS` em `src/db/migrate.ts`, DDL sempre aditiva. Número `0011` abaixo é INDICATIVO (a `51` usa 0009 e a `53` usa 0010 como indicativos) — usar o próximo livre na execução (regra transversal da Fase 5, `specs/90-roadmap.md`).

## Problema / Motivação

- O dono da instância quer agrupar tasks por PROJETO, no modelo pasta/lista do ClickUp: "puxa as tarefas do projeto X" deve retornar tudo daquele contexto — hoje só funciona se TODA task tiver sido tageada com disciplina perfeita, e tag não tem gestão nem cor.
- Tarefa pessoal vs de trabalho não tem separação visual nenhuma no board — tudo é uma sopa única ordenada por due/priority.
- Tag continua útil como rótulo transversal (máquina, pessoa, contexto), mas projeto é OUTRO eixo: single-valorado, gerenciável, com cor e ciclo de vida (arquivar projeto encerrado).

## Design proposto

### 1. Migration runtime `0011_task_projects` (aditiva)

```sql
CREATE TABLE IF NOT EXISTS task_projects (
  id          TEXT PRIMARY KEY,            -- 'proj_' + rand8 (id estável; label é editável)
  label       TEXT NOT NULL,               -- ≤40 chars
  color       TEXT,                        -- hex #rrggbb; NULL = neutro do tema
  position    INTEGER NOT NULL,
  archived_at INTEGER,                     -- projeto arquivado não aparece em selects/filtros default
  created_at  INTEGER NOT NULL
);
ALTER TABLE notes ADD COLUMN project_id TEXT REFERENCES task_projects(id);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes (project_id) WHERE kind = 'task';
```

Sem seeds: nenhum projeto nasce criado (task sem projeto é o estado default e permanece válido pra sempre). "Pessoal" é só um projeto que o dono cria como qualquer outro.

### 2. Semântica

- **Projeto é single-valorado**: task pertence a 0 ou 1 projeto (`project_id` NULL = "Sem projeto"). Tags continuam multi e ortogonais.
- **Arquivar projeto NÃO mexe nas tasks**: `project_id` fica; o chip renderiza esmaecido; o projeto some dos selects de atribuição, mas o filtro do board lista arquivados numa subseção (histórico consultável).
- **Cap de 64 projetos** (ativos + arquivados) — validação server em criar (UI e MCP).
- `domains` de nota continuam intocados (eixo de conhecimento ≠ eixo de execução).

### 3. Contrato MCP (aditivo — nenhum param existente muda)

- `save_task` e `update_task` ganham `project?: string`: aceita **id** (`proj_...`) ou **label** (match case-insensitive, trim, apenas entre projetos ATIVOS). Label sem match → **auto-cria** o projeto (label como veio, cor NULL, position no fim; respeita o cap de 64 → estourou, `toolError` orientando arquivar/reusar). `update_task` com `project: ""` (string vazia) remove a task do projeto (`project_id = NULL`).
  - Justificativa do auto-create: o fluxo é conversacional ("cria task do projeto X"); exigir pré-criação na UI quebraria o agente. O match case-insensitive absorve variação de caixa; a description da tool instrui a REUSAR labels existentes (o retorno inclui o projeto resolvido, então typo fica visível na resposta).
- `list_tasks` ganha `project?: string` (id ou label; resolve entre ativos E arquivados — histórico) — filtro aplicado como os demais (compõe com `status`/`tag`/`query`). A description da tool passa a distinguir: `project` = pasta single-valorada; `tag` = rótulo transversal multi.
- `get_task` e `list_tasks` retornam `project: { id, label } | null` (aditivo; clients existentes ignoram).
- `complete_task`, `list_tasks_due_today` e o cron (`listTasksDueBefore`) NÃO mudam de comportamento (projeto não filtra lembrete).

### 4. Board e detalhe (coordena com 51/52)

- **Filtro no board**: select no header de `/app/tasks` — "Todos os projetos" (default) | "Sem projeto" | cada ativo (com swatch de cor) | subgrupo "Arquivados". Estado em query param `?project=<id|none>` + persistido em `localStorage` (mesmo padrão do colapso de coluna da `52`). O payload de `handleTasksData` ganha `projects: [{id,label,color,archived}]` e cada task ganha `project_id`; o filtro aplica no client (dataset já está na página — sem round-trip).
- **Chip no card**: chip compacto com a cor do projeto (posição definida na anatomia da `52`; se a `52` ainda não rodou, adicionar no card atual sem redesign).
- **Detalhe/quick-edit**: select de projeto (ativos + opção "Sem projeto"); persiste via endpoint de edição existente estendido (`POST /app/tasks/*` com CSRF/headers atuais).

### 5. Gestão de projetos na UI de config

Seção "Projetos" em `/app/config` (`src/web/config.ts`, padrão `<details>` das seções existentes, ao lado da seção "Quadro de tarefas" da `51`):

- Lista (ativos e arquivados): label editável, color input, ↑/↓ (position), Arquivar/Desarquivar, contador de tasks do projeto.
- "Novo projeto": label + cor.
- Endpoints (sessão, mesmos padrões dos POSTs de `/app/tasks/*`): `POST /app/tasks/projects/create | update | reorder | archive`.
- Excluir projeto NÃO existe (só arquivar) — evita órfãos e decisão de realocação; task de projeto arquivado é resolvida no render (chip esmaecido).

### 6. Queries novas em `src/db/queries.ts`

`listTaskProjects(env, includeArchived)`, `getProjectByIdOrLabel(env, ref, activesOnly)`, `createTaskProject`, `updateTaskProject`, `countTasksByProject`. `TaskRow` ganha `project_id`; `TASK_COLS` idem.

## Fora de escopo

- Hierarquia (subprojetos/pastas dentro de pastas), múltiplos boards por projeto, WIP por projeto.
- Realocação/migração de tags existentes pra projetos (curadoria manual do dono, se quiser).
- Projeto em notas de conhecimento (só `kind='task'` usa `project_id`; a coluna existe em `notes` mas os write paths de nota não a tocam).
- Privacidade por projeto (privacidade é por task — spec `50-console-v2/59`).
- Filtro de projeto no cron/digest de lembretes.

## Critérios de aceite

- [ ] Migration aplicada via `/setup/provision` em banco provisionado: zero mudança em tasks existentes (`project_id` NULL = "Sem projeto").
- [ ] `save_task` com `project: "Cliente ACME"` (inexistente) cria o projeto e vincula; segunda chamada com `project: "cliente acme"` REUSA o mesmo (case-insensitive, sem duplicar).
- [ ] `list_tasks` com `project` (label ou id) retorna só as tasks do projeto; compõe com `status`/`tag`; `get_task`/`list_tasks` incluem `project {id,label}`; nenhuma chamada existente (sem `project`) muda de resultado.
- [ ] `update_task` com `project: ""` desvincula; com label de projeto ARQUIVADO não vincula (erro orientando desarquivar) — mas `list_tasks` com projeto arquivado ainda lista o histórico.
- [ ] Board: select de filtro funciona (Todos/Sem projeto/ativo/arquivado), sobrevive a reload (query param + localStorage); card mostra chip com a cor.
- [ ] Config: criar, renomear, recolorir, reordenar, arquivar/desarquivar projeto; cap 64 aplicado também no auto-create do MCP.
- [ ] Arquivar projeto com tasks: tasks continuam no board (chip esmaecido), nada é realocado.

## Validação

- `npm run typecheck` e `npm test` verdes (suíte + vitest.auth).
- Testes novos: resolução id/label (case-insensitive, ativos vs arquivados), auto-create + dedupe + cap, desvincular com `""`, filtro composto no list_tasks, migration em banco com tasks.
- Manual (`wrangler dev`): criar projeto pela UI e via `save_task`, filtrar board, conferir `list_tasks project:` via MCP.
- **Gate de deploy:** `wrangler deploy` só com OK explícito do dono da instância.

## Arquivos afetados

- `src/db/migrate.ts` (migration `0011_task_projects` — número indicativo)
- `src/db/queries.ts` (queries de projeto + `TaskRow`/`TASK_COLS`)
- `src/mcp/tools/save-task.ts`, `update-task.ts`, `list-tasks.ts`, `get-task.ts` (param/retorno `project`)
- `src/web/tasks.ts` (payload projects + endpoints `projects/*` + filtro SSR)
- `src/web/client/tasks.ts` (filtro no header, chip no card)
- `src/web/config.ts` (seção Projetos)
- `src/web/handler.ts` (rotas novas)
- `test/` (suites acima)

## Riscos e reversão

- **Risco**: auto-create do MCP proliferar projetos por typo. Mitigação: match case-insensitive + retorno explícito do projeto resolvido + cap 64 + gestão fácil (arquivar) na config.
- **Risco**: conflito de edição com specs `51`/`52` (mesmos arquivos web). Mitigação: rodar DEPOIS delas na onda C1 (sequência no roadmap).
- **Reversão**: revert do código; tabela e coluna ficam inertes (aditivas, ignoradas pelo código antigo) — sem migração de volta.
