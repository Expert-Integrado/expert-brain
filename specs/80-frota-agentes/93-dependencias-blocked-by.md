# Spec 93 — Dependências entre tasks (blocked_by)

> Grupo 80-frota-agentes. Origem: item diferido do benchmark 11/07/2026 (spec 88 §5,
> "subtasks/dependências... segue no backlog"), formalizado como task `a19zjy5k7cqe`
> ("Frota: subtasks e dependencias (blocked_by) no board do Brain"), executado por
> exec:agente (autorização do dono 14/07/2026 ~22h30 BRT) sob timebox de p3.
> Status: implementado (migration 0030), aguardando deploy (gate do dono).

## Contexto

A spec `30-features/38` já cobre **subtarefas/checklist** (`task_subtasks`, migration
`0029`): trabalho multi-parte dentro de UM card, ticável, sem N cards no board. Ela
deixou **explicitamente fora de escopo**: "Tasks-filhas com parent_id / dependências
(blocked_by) — segue no backlog da frota (80-frota-agentes/88)". Essa lacuna é
diferente: não é "dividir uma task em partes", é "esta task X só pode começar depois
que a task Y (JÁ EXISTENTE, possivelmente de outro dono/projeto) terminar" — uma
relação de ORDEM entre tasks que já existem como cards separados no board.

Hoje, se o dono ou um agente quebra manualmente uma entrega grande em N tasks soltas
(porque cada parte tem due date, assignee ou projeto próprios — o que o checklist da
spec 38 não cobre por design), não há vínculo entre elas: o agente que pega a fila
(`list_tasks assignee:me available:true`) pode pegar a task 2 antes da 1 terminar,
sem saber que depende dela.

## Decisão de design: SEM parent_task_id

A spec 88 original cogitava `parent_task_id (subtask) + task_deps (blocked_by)` como
um desenho único. Esta spec IMPLEMENTA só `task_deps` — decomposição hierárquica
("task-filha") já tem solução (checklist da spec 38, mais leve: não cria N cards, não
precisa de assignee/due/projeto próprios). Um `parent_task_id` redundante criaria dois
jeitos de "task dentro de task" no mesmo produto. `task_deps` cobre o caso real que
falta: ORDENAR cards que já são (e continuam sendo) tasks de primeira classe.

## Objetivo

Uma task pode declarar que está **bloqueada por** (`blocked_by`) uma ou mais outras
tasks. Enquanto qualquer bloqueadora não estiver `done`/`canceled`:
- a task bloqueada aparece marcada (`blocked: true`, com a lista de bloqueadoras
  pendentes) em `get_task` e `list_tasks`;
- ela **some da fila `available:true`** do modo fila (spec 88) — um agente pegando
  trabalho não pega uma task cuja pré-condição não terminou;
- o board web mostra um indicador visual (chip "bloqueada por N") no card.

Quando a ÚLTIMA bloqueadora pendente fecha (`done` ou `canceled`), a task bloqueada
NÃO se auto-completa nem muda de coluna — só deixa de estar `blocked` e volta a
aparecer em `available:true`. Isso evita o efeito colateral de uma dependência
completar e mover silenciosamente uma task que o dono ainda não revisou.

## Design

1. **Modelagem: tabela `task_deps`** (migration `0030_task_deps`), no molde de
   `mentions`/`task_subtasks` — tabela PRÓPRIA, não é nota (não embeda, não entra em
   grafo/recall):
   ```sql
   CREATE TABLE task_deps (
     id              TEXT PRIMARY KEY,
     task_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
     depends_on_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
     created_at      INTEGER NOT NULL,
     created_by      TEXT,
     UNIQUE (task_id, depends_on_id)
   )
   ```
   `task_id` é a task BLOQUEADA; `depends_on_id` é a bloqueadora (`blocked_by`).
   `ON DELETE CASCADE` nas duas pontas: hard-delete de qualquer task do par limpa a
   dependência (soft-delete não cascateia — mesma convenção das tabelas irmãs).
   Auto-referência (`task_id = depends_on_id`) e ciclo direto (A depende de B que já
   depende de A) são rejeitados em CÓDIGO na escrita (não dá pra expressar ciclo
   longo como CHECK simples; detectar ciclo transitivo em toda escrita é overkill
   pro caso de uso real — o board tem poucas dependências por task).
   Índices `(task_id)` e `(depends_on_id)` — a leitura roda nas duas direções
   ("quem me bloqueia" / "eu bloqueio quem").

2. **MCP — tool nova `update_task_deps`** `{task_id, block_on?, unblock_from?}`
   (mesmo molde de `update_subtask`): `block_on` (ids ou títulos exatos) ADICIONA
   dependências; `unblock_from` REMOVE. Todas as refs resolvidas e validadas (task
   existe, não é ela mesma, não fecha ciclo direto) ANTES de qualquer escrita — uma
   ref inválida aborta a call inteira, sem escrita parcial.

3. **`get_task`** ganha `blocked_by` (`[{id, title, status}]` — TODAS as
   dependências declaradas, não só as pendentes, pra o dono ver o quadro completo) e
   `blocks` (`[{id, title, status}]` — o inverso: quem esta task bloqueia). Campo
   `blocked: boolean` = true se QUALQUER item de `blocked_by` não está
   `done`/`canceled`.

4. **`list_tasks`** ganha `blocked: boolean` por task (batch, sem N+1 — mesmo padrão
   de `countTaskSubtasksBatch`). O filtro `available:true` (spec 88) passa a excluir
   tasks com `blocked === true`, além do critério de claim já existente.

5. **Board web**: chip "bloqueada por N" no card (SSR + espelho client, ao lado dos
   badges de comentário/checklist já existentes) quando `blocked`. Detalhe da task
   ganha seção "Depende de" / "Bloqueia" com link pros cards relacionados. Modal de
   criação não ganha o campo na v1 (mesma decisão da spec 38 pro checklist — nasce
   sem deps, dono/agente declara depois via `update_task_deps`).

6. **Histórico**: mutação de dependência vira `task_activity` `field='dependency'`
   ("bloqueada por: <título>" / "desbloqueada de: <título>").

## Fora de escopo (v1)

- `parent_task_id` / hierarquia task-pai—task-filha (ver decisão acima — coberto
  pelo checklist da spec 38).
- Detecção de ciclo TRANSITIVO (A→B→C→A); só o ciclo direto (A↔B) é validado.
- Auto-mover/auto-notificar quando a última bloqueadora fecha (o dono/agente
  descobre olhando `available:true` ou o card).
- Dependência cross-vault (bloquear por task de outro Brain).

## Critérios de aceite

- [x] Migration `0030_task_deps` aplica via `runMigrations` em instância existente
      sem tocar dados.
- [x] `update_task_deps` adiciona e remove por id ou título exato; ref inexistente,
      auto-referência ou ciclo direto abortam sem escrita parcial.
- [x] `get_task` devolve `blocked_by`, `blocks`, `blocked`.
- [x] `list_tasks` devolve `blocked` em batch; `available:true` exclui tasks
      bloqueadas.
- [ ] Card do board mostra o chip "bloqueada por N" (SSR + client) — **não
      implementado neste corte** (ver Próximos passos).
- [x] Cada mutação gera entrada no Histórico em PT.
- [x] Task soft-deletada não aparece em `blocked_by`/`blocks` de nenhuma outra task
      (JOIN filtra `deleted_at IS NULL`).

## Próximos passos (não entregues neste corte — p3, timebox)

- Badge visual no board web (SSR `src/web/tasks.ts` + client `src/web/client/tasks.ts`)
  e seção "Depende de/Bloqueia" no detalhe (`src/web/notes.ts`).
- Considerar expor `block_on`/`depends_on` como parâmetro de `save_task` (nascer já
  bloqueada), hoje só via `update_task_deps` pós-criação.

## Validação

- TDD: `test/db/task-deps.test.ts` + `test/tools/update-task-deps.test.ts` +
  extensões em `test/tools/get-task.test.ts`/`list-tasks.test.ts` escritos antes da
  implementação. Suite completa (`npm test` + `npm run typecheck`) verde.
- Gate de deploy: OK explícito do dono (produção — Brain é ferramenta operacional
  viva).

## Arquivos afetados

- `src/db/migrate.ts` (0030), `src/db/task-deps.ts` (novo), `src/db/task-activity.ts`
- `src/mcp/tools/update-task-deps.ts` (novo), `get-task.ts`, `list-tasks.ts`,
  `src/mcp/registry.ts`
- (próximos passos) `src/web/tasks.ts`, `src/web/notes.ts`, `src/web/client/tasks.ts`
