# Kanban de tarefas: colunas/estágios customizáveis pela UI, persistidos no banco

> **Status:** in-progress · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-brain
> **Depende de:** nenhuma (vizinhas sem overlap: `30-features/32` lifecycle/digest, `30-features/36` edição inline)
> **Agente sugerido:** Opus (schema + compatibilidade MCP)

## Contexto

O console tem um Kanban funcional em `/app/tasks`, mas as colunas são fixas no código:

- `src/web/tasks.ts:442-446` — `COLS` hardcoded com 3 colunas: `open` ("A fazer"), `in_progress` ("Em progresso"), `done` ("Concluído"). O array é DUPLICADO no client em `src/web/client/tasks.ts:38-42`.
- `canceled` existe no enum mas não tem coluna — task cancelada some do board.
- Drag & drop HTML5 nativo já funciona (`src/web/client/tasks.ts:303-342`): soltar em `done` chama `complete(id)`; nas demais, `setStatus(id, target)` → `POST /app/tasks/status`.
- O estado canônico da task vive em `notes.status` com CHECK **imutável** (`src/db/migrate.ts:134-141`, migration `0006_task_fields`): `status IN ('open','in_progress','done','canceled')`. SQLite não altera CHECK sem rebuild da tabela, e rebuild de `notes` é proibido (cascataria FTS/edges/tags — ver comentário da migration `0002` do repo).
- As tools MCP (`src/mcp/tools/{save,update,complete,list,get}-task.ts`) e os índices parciais (`idx_notes_task_open`, `idx_notes_task_due`) dependem desses 4 valores.
- Migrations runtime vivem no array `MIGRATIONS` de `src/db/migrate.ts` (última: `0008_share_task`); DDL sempre aditiva.

## Problema / Motivação

- O dono da instância quer estágios próprios (ex.: "Aguardando resposta", "Delegada", "Revisão") e hoje a única taxonomia é o enum de 4 status — qualquer workflow real não cabe (`src/web/tasks.ts:442-446`).
- Duplicação server/client do array de colunas já causou drift antes (mesma família do bug de handlers compartilhados do grafo) — a fonte precisa ser o banco.
- Não existe NENHUMA UI de gestão do board: criar/renomear/reordenar estágio exige editar código e fazer deploy.

## Objetivo

O dono cria, renomeia, recolore, reordena e arquiva colunas do Kanban pela UI de configuração; cards movem entre colunas custom com drag & drop; e TODAS as tools MCP continuam funcionando sem mudança de contrato (status canônico preservado).

## Design proposto

### 1. Migration runtime `0009_kanban_columns` (aditiva)

Adicionar ao array `MIGRATIONS` em `src/db/migrate.ts` (número `0009` é INDICATIVO — usar o próximo livre no momento da execução e atualizar esta spec; regra transversal na Fase 5 do `specs/90-roadmap.md`):

```sql
CREATE TABLE IF NOT EXISTS kanban_columns (
  id          TEXT PRIMARY KEY,          -- slug estável (seeds fixos: col_aberto, col_progresso, col_concluido, col_cancelado; novos: col_<rand8>)
  label       TEXT NOT NULL,
  color       TEXT,                      -- hex #rrggbb; NULL = neutro do tema
  position    INTEGER NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('open','in_progress','done','canceled')),
  archived_at INTEGER                    -- coluna arquivada não renderiza
);
ALTER TABLE notes ADD COLUMN column_id TEXT REFERENCES kanban_columns(id);
CREATE INDEX IF NOT EXISTS idx_notes_column ON notes (column_id) WHERE kind = 'task';
```

Seeds na MESMA migration (idempotentes, `INSERT OR IGNORE`), espelhando o board atual:

| id | label | category | position | archived_at |
|---|---|---|---|---|
| `col_aberto` | A fazer | open | 1 | NULL |
| `col_progresso` | Em progresso | in_progress | 2 | NULL |
| `col_concluido` | Concluído | done | 3 | NULL |
| `col_cancelado` | Cancelado | canceled | 4 | `strftime('%s','now')*1000` (nasce oculta; dono desarquiva se quiser ver canceladas no board) |

Backfill (mesma migration): `UPDATE notes SET column_id = 'col_' || CASE status ... END WHERE kind='task' AND status IS NOT NULL AND column_id IS NULL` (mapear os 4 status pros 4 seeds).

### 2. Invariante e semântica (o coração da compatibilidade)

**`notes.status` continua a fonte canônica de ESTADO; `column_id` é o estágio VISUAL.** Invariante: `kanban_columns.category(column_id) == notes.status`, mantida server-side nos dois sentidos:

- **Board → banco**: novo `POST /app/tasks/move { id, column_id }` resolve a coluna, seta `column_id` E `status = category` da coluna (com `completed_at` quando a categoria é `done`, espelhando a lógica de `complete`). O endpoint antigo `POST /app/tasks/status` continua aceito (compat): recebe status, realoca `column_id` pra coluna DEFAULT da categoria.
- **MCP → banco**: `save_task` → coluna default de `open`. `update_task(status=X)` → coluna default da categoria X. `complete_task` → default de `done`. "Coluna default da categoria" = menor `position` ativa (`archived_at IS NULL`) daquela `category`; se não existir ativa, usar o seed da categoria mesmo arquivado.
- **Leitura MCP** (aditivo, não quebra clients): `get_task` e `list_tasks` passam a incluir `column: { id, label }`.
- Task com `column_id` NULL ou órfão (coluna deletada manualmente no banco): render e queries caem no default da categoria do `status` — nunca some do board.

### 3. Payload e render dinâmicos

- `handleTasksData` (`src/web/tasks.ts:79-103`): payload ganha `columns: [{id,label,color,position,category}]` (ativas, ordenadas) e as tasks saem agrupadas por `column_id` resolvido (com fallback do item acima). Colunas de categoria `done`/`canceled` carregam as fechadas recentes (mesmo `listRecentClosedTasks` de hoje, filtrado por coluna).
- SSR (`handleTasksPage`) e client (`render()` em `src/web/client/tasks.ts:149-177`): eliminar os DOIS arrays `COLS` hardcoded; renderizar colunas do payload. Header de coluna: swatch/borda na cor da coluna + contador. Dropzones geradas por coluna (`data-dropzone="<column_id>"`); handler de drop passa a chamar `/app/tasks/move`.

### 4. Gestão de colunas na UI de config

Nova seção "Quadro de tarefas" em `/app/config` (`src/web/config.ts`, padrão das seções `<details>` existentes, linhas 126-213):

- Lista das colunas (ativas e arquivadas) com: label editável, color input, select de categoria (travado após criação — mudar categoria de coluna com tasks reclassificaria status em massa; fora de escopo), botões ↑/↓ (reordena `position`), Arquivar/Desarquivar.
- "Nova coluna": label + cor + categoria → `id = 'col_' + rand8`.
- **Arquivar coluna com tasks**: modal pede coluna destino da MESMA categoria (ou default da categoria); server faz `UPDATE notes SET column_id = <destino> WHERE column_id = <arquivada>` na mesma transação do arquivamento. Seeds `col_concluido`/`col_aberto` não podem ser arquivados se forem a última coluna ativa da categoria (validação server).
- Endpoints (sessão, mesmos padrões CSRF/headers dos POSTs atuais de `/app/tasks/*`): `POST /app/tasks/columns/create | update | reorder | archive`.

### 5. Queries novas em `src/db/queries.ts`

`listKanbanColumns(env)`, `getColumnById`, `defaultColumnForCategory`, `moveTaskToColumn` (transacional: status+column_id+completed_at), `reassignColumn(from,to)`. `TaskRow` (`queries.ts:335-346`) ganha `column_id`.

## Fora de escopo

- Status canônico novo além dos 4 (CHECK imutável — colunas custom SEMPRE mapeiam pra uma das 4 categorias).
- Mudar a categoria de uma coluna existente.
- WIP limits, swimlanes, múltiplos boards.
- Reordenação manual de cards DENTRO da coluna (ordem continua due/priority) — candidata a spec futura.
- UI do cartão em si (spec `52`).

## Critérios de aceite

- [ ] Migration `0009` aplicada via `/setup/provision` em banco já provisionado NÃO altera nenhuma task existente além de preencher `column_id` coerente com o `status`.
- [ ] Board renderiza as colunas do banco (ordem/cor/label); array `COLS` não existe mais em `src/web/tasks.ts` nem em `src/web/client/tasks.ts`.
- [ ] Arrastar card pra coluna custom persiste `column_id` e seta `status` = categoria da coluna; arrastar pra coluna de categoria `done` seta `completed_at`.
- [ ] Criar, renomear, recolorir, reordenar, arquivar (com realocação das tasks) e desarquivar coluna pela UI de config funcionam e sobrevivem a reload.
- [ ] `save_task`/`update_task`/`complete_task` alocam a coluna default correta; `list_tasks`/`get_task` retornam `column {id,label}`; NENHUM parâmetro existente das 5 tools mudou de contrato.
- [ ] Task com `column_id` órfão aparece na coluna default da categoria do seu `status` (teste com DELETE manual da coluna).
- [ ] `canceled` finalmente visível: desarquivar `col_cancelado` mostra as canceladas no board.

## Validação

- `npm run typecheck` e `npm test` verdes (suíte + vitest.auth).
- Testes novos: migration+backfill (banco com tasks nos 4 status), `moveTaskToColumn` (invariante status↔categoria + completed_at), realocação no archive, default de categoria com colunas custom, contrato MCP (list/get retornam column; update por status realoca).
- Manual: fluxo completo no board local (`wrangler dev`) — criar coluna "Aguardando resposta" (categoria in_progress), arrastar card pra ela, conferir `list_tasks` via MCP mostrando status `in_progress` + column nova.
- **Gate de deploy:** `wrangler deploy`/release SÓ com OK explícito do dono da instância.

## Arquivos afetados

- `src/db/migrate.ts` (migration 0009 + seeds + backfill)
- `src/db/queries.ts` (queries de coluna + TaskRow)
- `src/web/tasks.ts` (payload, SSR dinâmico, endpoints move/columns/*)
- `src/web/client/tasks.ts` (render dinâmico, DnD → move)
- `src/web/config.ts` (seção Quadro de tarefas)
- `src/mcp/tools/save-task.ts`, `update-task.ts`, `complete-task.ts`, `list-tasks.ts`, `get-task.ts` (alocação default + retorno column)
- `src/web/handler.ts` (rotas novas)
- `test/` (novos testes acima)

## Riscos e reversão

- **Risco**: drift do invariante status↔categoria por escrita concorrente (web move + MCP update simultâneos). Mitigação: as DUAS pontas derivam o outro campo na mesma escrita (nunca gravam um só); `update_task` já tem `expected_updated_at` opcional pra concorrência.
- **Risco**: coluna arquivada como destino de MCP. Mitigação: `defaultColumnForCategory` só considera ativas (fallback seed).
- **Reversão**: revert dos commits de código volta o board fixo; tabela `kanban_columns` e coluna `column_id` ficam inertes no banco (aditivas, ignoradas pelo código antigo) — sem migração de volta.
