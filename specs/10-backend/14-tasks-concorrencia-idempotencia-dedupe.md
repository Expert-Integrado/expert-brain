# Tasks: versionamento otimista, dedupe na criação e idempotência do complete

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O CRUD de tasks do Expert Brain vive em duas camadas:

- **Camada de dados** — `src/db/queries.ts`, seção `TASKS` (a partir da linha 226). Tasks são notas com `kind='task'` mais 4 colunas extras (`status`, `due_at`, `priority`, `completed_at`), adicionadas pela migration `src/db/migrations/0003_task_fields.sql`. Funções relevantes:
  - `insertTask` (`src/db/queries.ts:248-253`) — INSERT direto, sem coluna `completed_at`.
  - `getTaskById` (`src/db/queries.ts:255-259`).
  - `completeTask` (`src/db/queries.ts:312-323`) — lê a task, monta o body com append de `**Resultado:** ...` em JavaScript e faz UPDATE incondicional (read-modify-write).
  - `updateTask` (`src/db/queries.ts:341-368`) — patch parcial com UPDATE condicionado só a `id + kind='task' + deleted_at IS NULL`.
  - `listActiveTasks` (`src/db/queries.ts:264-271`) — tasks `open`/`in_progress`.
  - `listRecentClosedTasks` (`src/db/queries.ts:275-283`) — ordena por `COALESCE(completed_at, updated_at)`.
- **Camada MCP** — `src/mcp/tools/save-task.ts`, `src/mcp/tools/update-task.ts`, `src/mcp/tools/complete-task.ts`. Helpers `toolSuccess`/`toolError`/`safeToolHandler` vêm de `src/mcp/helpers.ts`.

Tags moram na tabela `tags` (N:N por `note_id`), com `insertTags` (`src/db/queries.ts:61-64`) e `replaceTags` (`src/db/queries.ts:131-137`). O `list_tasks` (`src/mcp/tools/list-tasks.ts`) já devolve tags por task via `getTagsForNotes` justamente pra habilitar dedupe manual pelo agente.

O dono do vault roda 4+ clientes MCP simultâneos (PC, notebook, 2 containers VPS) contra o mesmo banco D1. Escritas concorrentes na mesma task são cenário real, não teórico. Além disso, clientes MCP fazem retry automático de chamadas que estouram timeout — a mesma chamada de tool pode executar duas vezes.

## Problema / Motivação

Quatro defeitos concretos, todos verificados no código:

1. **`update_task` é last-write-wins silencioso** (`src/db/queries.ts:341-368`). Duas instâncias que leram a mesma task e mandam patches diferentes sobrescrevem uma à outra sem nenhum aviso. Não existe nenhum mecanismo de detecção de escrita concorrente — o UPDATE não condiciona em `updated_at`.
2. **`save_task` não tem dedupe** (`src/mcp/tools/save-task.ts:60-106`). A única proteção contra duplicata é convenção documentada ("rode `list_tasks` antes de criar") — nada garantido pelo servidor. Duas sessões que decidem criar "Enviar proposta X" ao mesmo tempo geram duas tasks. Em retry de rede, o mesmo `save_task` cria duas tasks idênticas.
3. **`complete_task` não é idempotente** (`src/db/queries.ts:312-323` + `src/mcp/tools/complete-task.ts:31-46`). Chamado numa task já `done`, re-appenda `**Resultado:** ...` no body a cada chamada e avança `completed_at` pra `now` — retry corrompe o body e falsifica o histórico. E o read-modify-write do body (lê em JS na linha 313, escreve na 318) tem janela de corrida: dois completes intercalados perdem um dos outcomes.
4. **`save_task` com status inicial `done`/`canceled` não stampa `completed_at`** (`src/mcp/tools/save-task.ts:17` aceita qualquer valor de `TASK_STATUSES`; `insertTask` em `src/db/queries.ts:248-253` nem tem a coluna `completed_at` no INSERT). A task nasce fechada com `completed_at=NULL` — o `COALESCE(completed_at, updated_at)` de `listRecentClosedTasks` mascara o buraco, mas o dado fica inconsistente com o invariante mantido por `setTaskStatus`/`updateTask`/`completeTask` (fechado ⇒ `completed_at` preenchido).

## Objetivo

Nenhuma sequência de chamadas concorrentes ou retries de `save_task`/`update_task`/`complete_task` produz sobrescrita silenciosa, task duplicada com `dedupe_key` igual, body corrompido ou task fechada sem `completed_at` — comprovado por testes de concorrência simulada no vitest.

## Design proposto

Sem nenhuma migration de schema: tudo usa colunas e tabelas existentes (`notes.updated_at`, tabela `tags`). Zero risco pra dados existentes.

### 1. Versionamento otimista (opt-in) em `update_task` e `complete_task`

Padrão If-Match/409: o cliente informa o `updated_at` que leu; o servidor só escreve se ainda for esse.

**`src/db/queries.ts`:**

- `updateTask(env, id, patch, now, expectedUpdatedAt?)` — quando `expectedUpdatedAt` vier, o UPDATE ganha `AND updated_at = ?`:

  ```sql
  UPDATE notes SET ... WHERE id = ? AND kind = 'task' AND deleted_at IS NULL
    AND updated_at = ?  -- só quando expectedUpdatedAt informado
  ```

  Distinguir os dois zeros de `meta.changes`: se `changes === 0` e `getTaskById` retorna a task, é conflito de versão; se retorna null, é not-found. Sugestão de retorno: `TaskRow | 'conflict' | null`.

- `completeTask(env, id, now, outcome?, expectedUpdatedAt?)` — **eliminar o read-modify-write do body**. Trocar a leitura em JS + escrita por um único UPDATE com append em SQL:

  ```sql
  UPDATE notes
  SET status = 'done',
      completed_at = ?,
      updated_at = ?,
      body = CASE WHEN ? IS NULL THEN body
                  ELSE body || char(10) || char(10) || '**Resultado:** ' || ? END
  WHERE id = ? AND kind = 'task' AND deleted_at IS NULL
    AND status <> 'done'                 -- idempotência (item 3)
    AND (? IS NULL OR updated_at = ?)    -- versionamento opt-in
  ```

  (Binds do outcome passados duas vezes, ou montar o SET dinamicamente como o `updateTask` já faz — escolher o estilo consistente com o arquivo.) Isso fecha a janela de corrida: o append acontece atomicamente no D1, não em JS.

**`src/mcp/tools/update-task.ts` e `src/mcp/tools/complete-task.ts`:**

- Novo parâmetro opcional `expected_updated_at: z.number().int().optional()` no `inputSchema`, com descrição explicando o padrão ("pass the `updated_at` you last read; the write fails if the task changed since").
- Em conflito, `toolError` com mensagem acionável: `"Task mudou desde sua leitura (updated_at atual: <valor>) — releia via list_tasks e reaplique o patch."` Incluir o `updated_at` atual e, se barato, os campos atuais da task no erro pro agente não precisar de round-trip extra.
- Opt-in preserva compatibilidade total: chamadas sem o parâmetro seguem last-write-wins como hoje.
- O `update_task` já retorna `updated_at` no `toolSuccess` (`src/mcp/tools/update-task.ts:114`) — o `save_task` e o `complete_task` devem passar a retornar também, senão o agente não tem o valor pra usar como `expected_updated_at`. O `list_tasks` já expõe? Verificar `src/mcp/tools/list-tasks.ts` e incluir `updated_at` por task se ainda não devolve.

### 2. Dedupe em `save_task`

Dois níveis, ambos sem tabela nova:

**a) `dedupe_key` explícito (garantia forte):**

- Novo parâmetro opcional `dedupe_key: z.string().min(1).max(120).optional()` no `inputSchema` de `save-task.ts`.
- Persistido como tag reservada `dedupe:<key>` via `insertTags` existente.
- Antes do INSERT, checar se já existe task **ativa** (status `open`/`in_progress`, `deleted_at IS NULL`) com essa tag:

  ```sql
  SELECT n.id FROM notes n JOIN tags t ON t.note_id = n.id
  WHERE t.tag = ? AND n.kind = 'task' AND n.deleted_at IS NULL
    AND n.status IN ('open','in_progress')
  LIMIT 1
  ```

  Nova função em `queries.ts` (ex.: `findActiveTaskByTag`). Se existe, **não criar**: retornar `toolSuccess` com a task existente + `{ deduped: true }`. Retry da mesma chamada vira no-op seguro.
- Documentar no `DESCRIPTION` da tool: agentes devem passar `dedupe_key` estável (ex.: derivado da origem — id de email, id de card) quando a criação puder repetir entre sessões/retries.
- Nota de honestidade no código: check-then-insert não é atômico sem constraint UNIQUE; a janela residual é de milissegundos e aceitável pro caso de uso (o objetivo é matar retry e criação por convenção, não servir tráfego adversarial). Registrar isso em comentário.
- **Proteção da tag reservada:** `update_task` com `tags` faz `replaceTags` (apaga tudo — `src/mcp/tools/update-task.ts:104`), o que descartaria o `dedupe:` silenciosamente. Preservar tags com prefixo `dedupe:` no replace, a menos que o novo array também contenha uma tag `dedupe:` (substituição explícita). Implementar no handler do `update_task` (ler tags atuais, re-anexar as `dedupe:` ausentes), não mudando a semântica de `replaceTags` pra outros chamadores.

**b) Match barato por título (aviso, sem bloquear):**

- Quando `dedupe_key` NÃO vier, rodar uma checagem barata contra tasks abertas por título normalizado:

  ```sql
  SELECT id, title, status, due_at FROM notes
  WHERE kind = 'task' AND deleted_at IS NULL AND status IN ('open','in_progress')
    AND title LIKE ? COLLATE NOCASE
  LIMIT 5
  ```

  com padrão `%<título trimado>%` (e/ou o inverso, título existente contido no novo). Limitação conhecida: `NOCASE` do SQLite só normaliza ASCII — acentos não casam ("Proposta" ≠ "propostá"); aceitável pra um warning.
- Se houver matches, criar a task normalmente e incluir no `toolSuccess`: `possible_duplicates: [{ id, title, status, due_brt }]` + instrução curta ("if one of these is the same task, delete this one and use update_task on the existing id"). O agente decide; o servidor não bloqueia.

### 3. Idempotência do `complete_task`

- No handler (`src/mcp/tools/complete-task.ts`), antes de completar: se a task existe e já está `done`, retornar `toolSuccess` com `{ already_done: true, completed_at: <original>, completed_brt: <original formatado> }` **sem escrever nada** (nem body, nem timestamps). O `AND status <> 'done'` do UPDATE do item 1 garante isso também na camada SQL contra corrida (dois completes simultâneos: um escreve, o outro afeta 0 linhas e cai no caminho `already_done`).
- Task `canceled`: completar normalmente (reabrir-fechando é transição legítima done←canceled), mantendo o comportamento atual de `setTaskStatus`. Só `done` → `done` vira no-op.
- Corrigir o response atual que hardcoda `completed_at: now` (`src/mcp/tools/complete-task.ts:43`) — usar o valor efetivamente persistido.

### 4. `save_task` com status inicial fechado

Decidir na implementação entre as duas opções (documentar a escolha no PR):

- **Opção A (recomendada):** manter o enum completo e stampar `completed_at = now` no INSERT quando `status` for `done`/`canceled`. Exige adicionar `completed_at` ao `insertTask` (`src/db/queries.ts:248-253`) e ao `InsertTaskInput` — mudança aditiva, chamadores existentes passam `null`.
- **Opção B:** restringir o enum de criação a `open`/`in_progress` no `inputSchema` do `save_task` (criar já-fechado não tem caso de uso real; quem quiser registra e completa). Menos código, mas quebra chamadas hipotéticas com `status:'done'` — verificar se algum teste/fluxo usa antes de escolher.

A recomendação é A por não remover capacidade.

### 5. Testes (gate obrigatório)

Criar `test/tools/tasks-concurrency.test.ts` (o arquivo `test/tools/tasks.test.ts` citado na atribuição não existe; hoje os testes de task estão em `test/tools/save-task.test.ts`, `test/tools/complete-task.test.ts`, `test/tools/list-tasks.test.ts` — seguir o padrão de setup deles) cobrindo, no mínimo:

- Duas escritas intercaladas: A e B leem a task; A grava com `expected_updated_at` (sucesso); B grava com o `expected_updated_at` antigo → toolError de conflito, e o patch de A permanece intacto.
- `update_task` sem `expected_updated_at` continua funcionando (compatibilidade).
- `complete_task` duas vezes: segunda chamada retorna `already_done: true`, `completed_at` não muda, body tem UM único `**Resultado:**`.
- Dois `complete_task` "simultâneos" com outcomes diferentes: body termina com exatamente um append (o vencedor), sem perda de status.
- `save_task` com mesmo `dedupe_key` duas vezes: segunda retorna a primeira com `deduped: true`, e só existe uma task.
- `dedupe_key` de task já concluída NÃO bloqueia criação nova (dedupe só contra ativas).
- `update_task` com `tags` novas preserva a tag `dedupe:` existente.
- `save_task` sem `dedupe_key` com título quase igual a uma task aberta retorna `possible_duplicates` não vazio e mesmo assim cria.
- `save_task` com `status:'done'` resulta em `completed_at` preenchido (ou é rejeitado, conforme a opção escolhida no item 4).

Estender os testes existentes de `save-task`/`complete-task` onde fizer sentido em vez de duplicar setup.

## Fora de escopo

- Merge automático de duplicatas detectadas (o warning `possible_duplicates` delega a decisão ao agente).
- Tabela própria de tasks separada de `notes` (descartado no inventário — tasks continuam sendo notas `kind='task'`).
- Versionamento otimista em notas (`update_note`) — só tasks nesta spec.
- Constraint UNIQUE no banco pra `dedupe_key` (exigiria migration de índice em `tags`; a janela residual do check-then-insert é aceitável — pode virar spec futura se aparecer duplicata real).
- Mudanças no board web `/app/tasks` (as views leem as mesmas queries e continuam funcionando).

## Critérios de aceite

- [ ] `update_task` aceita `expected_updated_at` opcional; com valor desatualizado retorna toolError instruindo releitura, sem escrever nada.
- [ ] `update_task` sem `expected_updated_at` mantém comportamento atual (compatibilidade retro total).
- [ ] `complete_task` aceita `expected_updated_at` opcional com a mesma semântica.
- [ ] `completeTask` em `src/db/queries.ts` não faz mais read-modify-write do body em JS — o append de `**Resultado:**` acontece num único UPDATE SQL.
- [ ] `complete_task` em task já `done` retorna `{ already_done: true }` com o `completed_at` original e não escreve nada (idempotente sob retry).
- [ ] `save_task` aceita `dedupe_key` opcional; segunda chamada com a mesma key contra task ativa retorna a existente com `deduped: true` sem criar duplicata.
- [ ] `dedupe_key` é persistido como tag `dedupe:<key>` e sobrevive a `update_task` com `tags` (preservação da tag reservada).
- [ ] `save_task` sem `dedupe_key` retorna `possible_duplicates` quando há task aberta com título similar, sem bloquear a criação.
- [ ] Task criada via `save_task` com status fechado tem `completed_at` preenchido (ou o enum de criação foi restringido — decisão documentada).
- [ ] `save_task` e `complete_task` retornam `updated_at` no success (insumo pro `expected_updated_at` da próxima escrita).
- [ ] Todos os testes de concorrência do item 5 do design existem e passam.
- [ ] Nenhuma migration destrutiva; nenhum dado existente alterado por deploy (só comportamento de escrita novo).
- [ ] Descrições das tools (`DESCRIPTION`) atualizadas explicando `expected_updated_at`, `dedupe_key` e o contrato de idempotência.

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck        # tsc --noEmit (worker + client)
npm test                 # vitest run && vitest run --config vitest.auth.config.ts
npx vitest run test/tools/tasks-concurrency.test.ts   # gate específico
```

Teste manual (wrangler dev ou preview):

1. `save_task` com `dedupe_key:"spec-teste-1"` → repetir a mesma chamada → segunda retorna `deduped: true` e mesmo id.
2. `update_task` com `expected_updated_at` errado → erro de conflito; com o valor correto → sucesso.
3. `complete_task` duas vezes no mesmo id → segunda retorna `already_done: true`; conferir no `/app/tasks` que o body tem um único `**Resultado:**`.

Deploy (`npm run deploy`) SOMENTE com OK explícito do dono do repo.

## Arquivos afetados

- `src/mcp/tools/save-task.ts` — `dedupe_key`, checagem de duplicata por título, `completed_at` em status fechado, `updated_at` no retorno.
- `src/mcp/tools/update-task.ts` — `expected_updated_at`, erro de conflito, preservação da tag `dedupe:`.
- `src/mcp/tools/complete-task.ts` — `expected_updated_at`, caminho `already_done`, retorno com valores persistidos.
- `src/db/queries.ts` — `updateTask` e `completeTask` com versão opcional; `completeTask` com append em SQL; `insertTask`/`InsertTaskInput` com `completed_at`; nova `findActiveTaskByTag`; nova busca de título similar.
- `test/tools/tasks-concurrency.test.ts` — novo (gate de concorrência).
- `test/tools/save-task.test.ts`, `test/tools/complete-task.test.ts` — casos novos de dedupe/idempotência.

## Riscos e reversão

- **Risco: agentes antigos não passam `expected_updated_at`.** Mitigado por design — o parâmetro é opt-in; sem ele, comportamento idêntico ao atual.
- **Risco: warning `possible_duplicates` gerar falso positivo e o agente deletar task legítima.** O warning instrui explicitamente a verificar antes; o servidor nunca deleta nem bloqueia sozinho.
- **Risco: janela residual do check-then-insert do `dedupe_key`.** Documentada; probabilidade mínima no padrão de uso real (retries e sessões humanas, não corrida adversarial). Escalável pra índice UNIQUE em spec futura.
- **Risco: LIKE por título em vault com muitas tasks abertas.** Query limitada a tasks ativas (dezenas, não milhares) com `LIMIT 5` — custo desprezível.
- **Reversão:** mudanças são só de código, sem migration — `git revert` do(s) commit(s) + `npm run deploy` restaura o comportamento anterior integralmente. Tasks criadas com tag `dedupe:` são tags comuns na tabela `tags` e continuam válidas após rollback (viram tags inertes, sem efeito).
