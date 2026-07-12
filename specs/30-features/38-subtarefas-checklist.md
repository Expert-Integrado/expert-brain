# Subtarefas (checklist) dentro de uma task

> **Status:** in-progress · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma dura · relacionada: `50-console-v2/53` (comentários — o padrão de sub-recurso), `30-features/37` (usuários/autoria)

## Contexto

Agentes da frota entregam trabalho multi-parte num card só — o caso motivador real foi a
task "implementar 8 specs" (`t740gj5h6eo1`, 12/07/2026): oito entregas dentro de UM card,
sem nenhuma visibilidade de progresso além do texto do body. O dono pediu explicitamente
subtarefas dentro do card ("vocês colocam 8 specs dentro de um único card, teria que ter
subtarefa").

O board hoje comunica progresso só pela coluna + badge de comentários. A spec `52` já
havia descartado subtasks estilo ClickUp (cards-filhos) como não-objetivo — e o pedido
do dono confirma: ele NÃO quer N cards no board, quer UM card decomponível.

## Problema / Motivação

- Card multi-parte é opaco: pra saber "quanto falta" o dono abre o detalhe e lê markdown.
- Agentes que decompõem trabalho hoje escolhem entre N cards (polui o board) ou body
  gigante (invisível). Não existe meio-termo.
- Sem estrutura, não há como um agente "ticar" a parte que terminou de forma auditável.

## Objetivo

Um card de task pode carregar um checklist de itens tickáveis; o board mostra o progresso
("3/8") de relance; agentes criam e marcam itens via MCP; o dono gerencia no detalhe da
task; o share público exibe read-only.

## Design

1. **Modelagem: tabela filha `task_subtasks`** (migration `0029_task_subtasks`), no molde
   de `task_comments`: `id ('sub_...'), task_id REFERENCES notes(id) ON DELETE CASCADE,
   title (1..200), position (append max+1), done_at (único marcador de estado),
   done_by / created_by (formato writeActor: 'oauth:<email>' | PAT id), created_at` +
   índice `(task_id, position)`. Cap de 100 itens por task (em código).
   - NÃO é nota: não embeda, não entra em grafo/recall. Reads filtram task viva
     (`notes.deleted_at IS NULL`); soft-delete da task esconde, hard-delete cascateia.
   - **Mutação de subtask não toca `notes.updated_at`** — tick não invalida o
     `expected_updated_at` de uma edição concorrente (contrato igual ao dos comentários).
     Efeito colateral aceito: atividade só de checklist não "des-stale-ia" a task.
2. **MCP**:
   - `save_task` ganha `subtasks: string[]` (máx 50) — a task nasce com o checklist.
   - Tool nova `update_subtask` `{task_id, add?, check?, uncheck?, remove?, retitle?}` —
     uma call cobre o ciclo; `check`/`uncheck` aceitam id ou título exato (ambíguo erra
     listando os itens); `remove` só por id; resolve todas as refs ANTES de escrever.
   - `get_task` retorna `subtasks[]` + `subtask_progress`; `list_tasks` retorna
     `subtask_progress {done,total} | null` (contagem em batch, sem N+1).
   - Descriptions orientam a frota: trabalho multi-parte = UM card com subtasks, nunca
     N cards. `complete_task` avisa que concluir não auto-tica (e não bloqueia).
3. **Console**: seção "Subtarefas" no detalhe da task (toggle, adicionar, renomear,
   remover; sem reordenação na v1 — ordem = criação); 4 endpoints JSON
   `/app/tasks/subtask/{add,toggle,update,delete}` no padrão das rotas irmãs; badge
   "3/8" no card do board (SSR + espelho client, ao lado do badge de comentários).
   Modal de criação do board não ganha subtasks na v1 (agente nasce completo via
   save_task; dono detalha depois).
4. **Histórico**: cada mutação vira `task_activity` `field='subtask'` com ação em PT
   (adicionada/concluída/reaberta/renomeada/removida) + título truncado.
5. **Share `/s/<token>`**: checklist read-only (✓/○ + contagem) — a página é
   `script-src 'none'`, zero JS.

## Fora de escopo

- Tasks-filhas com parent_id / dependências (blocked_by) — segue no backlog da frota
  (`80-frota-agentes/88`).
- Reordenação drag-and-drop de itens; due/assignee por item.
- Progresso no card da home ("Hoje") e no digest.
- Auto-mover a task de coluna quando o checklist completa.

## Critérios de aceite

- [ ] Migration `0029_task_subtasks` aplica via `/setup/provision` em instância existente sem tocar dados; backup test passa com 29 migrations.
- [ ] `save_task` com `subtasks:["a","b"]` cria checklist ordenado e devolve `subtask_progress {done:0,total:2}`.
- [ ] `update_subtask` adiciona, marca (por id e por título único), desmarca, renomeia e remove; ref inválida aborta sem escrita parcial; task privada sem escopo `private` = not found.
- [ ] `get_task` devolve `subtasks` + progresso; `list_tasks` devolve `subtask_progress` (null sem checklist) em batch.
- [ ] Card do board (SSR e client idênticos) mostra "3/8" ao lado do badge de comentários; payload `/app/tasks/data` carrega os contadores.
- [ ] No detalhe: dono adiciona, marca/desmarca, renomeia e remove sem reload; contador atualiza; POST sem sessão negado.
- [ ] Cada mutação gera entrada no Histórico em PT.
- [ ] Página pública `/s/<token>` exibe o checklist read-only com progresso, sem script.
- [ ] Concluir task com itens abertos continua permitido.
- [ ] Subtasks de task soft-deletada não aparecem em nenhum read path; `updated_at` da task NÃO muda com tick.

## Validação

- TDD: testes de queries/tools/web escritos antes de cada camada; suite completa
  (`npm test` + `npm run test:client` + `npm run typecheck`) verde por commit.
- Fluxo real em wrangler dev: save_task com subtasks → badge no board → tick no
  detalhe → histórico → share.
- Gate de deploy: OK explícito do dono.

## Arquivos afetados

- `src/db/migrate.ts` (0029), `src/db/subtasks.ts` (novo), `src/db/task-activity.ts`
- `src/mcp/tools/update-subtask.ts` (novo), `save-task.ts`, `get-task.ts`,
  `list-tasks.ts`, `complete-task.ts` (description), `src/mcp/registry.ts`
- `src/web/tasks.ts` (endpoints + board), `src/web/handler.ts`, `src/web/notes.ts`
  (detalhe + histórico), `src/web/share.ts`, `src/util/task-badges.ts`
- `src/web/client/task-edit.ts`, `src/web/client/tasks.ts`

## Riscos e reversão

Aditivo puro (tabela nova + superfícies novas); risco de regressão concentrado no card
do board (SSR vs client dessincronizar — commit atômico dos dois) e nos 4 call sites de
`renderSharePage`. Reversão: remover rotas/tool/badge; a tabela fica órfã sem custo.
