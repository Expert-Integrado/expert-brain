# Edges: bloquear task como extremo, tool delete_link e resposta honesta em duplicata

> **Status:** done · **Prioridade:** P1 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O grafo do Expert Brain é formado por notas (`notes`) e edges explícitas (`edges`), criadas por duas tools MCP:

- `link` (`src/mcp/tools/link.ts`) — cria uma edge entre duas notas existentes. Valida self-loop, `why` mínimo de 20 chars e existência dos dois extremos via `getNoteById` (`src/mcp/tools/link.ts:50-59`).
- `save_note` (`src/mcp/tools/save-note.ts`) — aceita um array `edges` no mesmo call; valida cada `to_id` também via `getNoteById` (`src/mcp/tools/save-note.ts:102-109`).

A tabela `edges` tem chave natural `UNIQUE(from_id, to_id, relation_type)` (`src/db/migrations/0001_init.sql:51`) e o insert usa `INSERT OR IGNORE` (`src/db/queries.ts:54-59`, função `insertEdge`, que retorna `void`).

Tasks moram na MESMA tabela `notes` com `kind='task'` e são, por decisão de design, EXCLUÍDAS do grafo, do recall e da lista de notas (comentário em `src/db/queries.ts:17-22`; filtro `NON_TASK_FILTER` em `src/db/queries.ts:31`). Porém `getNoteById` (`src/db/queries.ts:141-146`) filtra apenas `deleted_at IS NULL` — não filtra `kind`.

Não existe nenhuma tool MCP para remover uma edge. A própria description do `update_note` admite o gap: `"To change edges, use link (add) — edges cannot be deleted via MCP yet."` (`src/mcp/tools/update-note.ts:27`). O único caminho hoje é SQL manual no D1.

O dashboard do grafo é servido de um cache KV (`GRAPH_CACHE`, chave `graph:v7` em `src/web/graph-data.ts:43`), invalidado por `sourceHash` que inclui `COUNT` e `MAX(created_at)` de `edges` (`src/web/graph-data.ts:55-58`). O endpoint web de criação de edge também faz invalidação explícita com `env.GRAPH_CACHE.delete(CACHE_KEY)` (`src/web/graph-data.ts:301`).

Referência de tool destrutiva existente: `delete_note` (`src/mcp/tools/delete-note.ts`) usa `confirm: z.literal(true)` e `annotations.destructiveHint: true`.

## Problema / Motivação

Três inconsistências de integridade no grafo de edges:

1. **Edge fantasma apontando pra task.** `link` (`src/mcp/tools/link.ts:50-59`) e `save_note` (`src/mcp/tools/save-note.ts:102-109`) validam os extremos com `getNoteById`, que NÃO filtra `kind`. Uma edge com `from_id`/`to_id` de task é aceita e persiste no D1 — mas a task nunca aparece no grafo nem no recall (filtro `NON_TASK_FILTER`, `src/db/queries.ts:31`), então a edge vira lixo invisível que nenhum read path renderiza e nenhuma tool remove. Contradiz o design declarado em `src/db/queries.ts:17-22`.

2. **Edge errada é impossível de remover via MCP.** Não há tool de delete de edge; `update_note` admite o gap na própria description (`src/mcp/tools/update-note.ts:27`). Isso trava a curadoria semanal do vault (skill de curadoria propõe remoção de edges órfãs/erradas, mas não há tool pra executar) e força SQL manual.

3. **Id fabricado em duplicata.** `link` gera `newId()` ANTES do insert e o retorna incondicionalmente (`src/mcp/tools/link.ts:60-66`). Como `insertEdge` usa `INSERT OR IGNORE` (`src/db/queries.ts:56`) e retorna `void`, um link duplicado (mesmo `from_id, to_id, relation_type`) responde sucesso com um `id` que NÃO existe no banco. O agente chamador pode salvar/referenciar esse id fantasma. A description até avisa "Duplicate edges ... are silently ignored" (`src/mcp/tools/link.ts:20`), mas a resposta mente.

Adicionalmente, a fronteira nota/task é inconsistente entre tools: `delete_note` (`src/mcp/tools/delete-note.ts:44`) também usa `getNoteById` sem filtro de kind, então soft-deleta uma task por um caminho que não é o das tools de task.

## Objetivo

Nenhuma edge pode ser criada com task como extremo, toda edge existente pode ser removida via MCP com confirmação, e `link` em duplicata responde `duplicate: true` sem id fabricado — com testes cobrindo os 4 comportamentos.

## Design proposto

Sem mudança de schema — nenhuma migration. Só código TypeScript + testes.

### 1. `insertEdge` reporta se inseriu (`src/db/queries.ts`)

Mudar o retorno de `void` para `boolean` usando `res.meta.changes` (mesmo padrão já usado por `setTaskStatus` em `src/db/queries.ts:307`):

```ts
// Retorna true se a edge foi inserida; false se já existia (INSERT OR IGNORE
// na UNIQUE(from_id,to_id,relation_type)). O caller decide como reportar.
export async function insertEdge(env: Env, e: EdgeRow): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO edges (id,from_id,to_id,relation_type,why,created_at)
     VALUES (?,?,?,?,?,?)`
  ).bind(e.id, e.from_id, e.to_id, e.relation_type, e.why, e.created_at).run();
  return (res.meta?.changes ?? 0) > 0;
}
```

Callers de `insertEdge`: `src/mcp/tools/link.ts` e `src/mcp/tools/save-note.ts` (o endpoint web `handleGraphLink` em `src/web/graph-data.ts:296-299` usa SQL inline, não é afetado). Adicionar também a query de delete:

```ts
// Remove uma edge pela chave natural. Retorna true se removeu, false se não existia.
export async function deleteEdge(
  env: Env, fromId: string, toId: string, relationType: EdgeType
): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM edges WHERE from_id = ? AND to_id = ? AND relation_type = ?`
  ).bind(fromId, toId, relationType).run();
  return (res.meta?.changes ?? 0) > 0;
}
```

### 2. Bloquear task como extremo em `link` e `save_note`

Em `src/mcp/tools/link.ts`, após os checks de existência (linhas 54-59 atuais), adicionar:

```ts
if (from.kind === 'task' || to.kind === 'task') {
  return toolError(
    `Edges cannot point to tasks — tasks live outside the graph. ` +
    `Use the task's tags (update_task) to reference context instead.`
  );
}
```

Em `src/mcp/tools/save-note.ts`, dentro do loop de validação de edges (linhas 92-110 atuais), após confirmar que `target` existe:

```ts
if (target.kind === 'task') {
  return toolError(
    `Edge to '${e.to_id}' rejected: that id is a task, and tasks live outside the graph. ` +
    `Use the task's tags to reference context instead. The note was NOT saved — remove this edge and retry.`
  );
}
```

Nota: em `save_note` a validação roda ANTES de qualquer write em D1 (o embed só acontece depois do loop, `src/mcp/tools/save-note.ts:114`), então rejeitar aqui não deixa nota parcial. Manter os textos de erro em inglês, como todo o restante das mensagens de tool do repo.

Atualizar as DESCRIPTIONs das duas tools mencionando a regra (ex.: em `link`: "Both endpoints must be knowledge notes — edges to/from tasks (kind='task') are rejected; tasks live outside the graph.").

### 3. `link` honesto em duplicata (`src/mcp/tools/link.ts`)

Trocar o final do handler (linhas 60-66 atuais):

```ts
const id = newId();
const inserted = await insertEdge(env, { id, from_id: input.from_id, to_id: input.to_id, relation_type: input.relation_type, why: input.why, created_at: Date.now() });
if (!inserted) {
  return toolSuccess({
    duplicate: true,
    from_id: input.from_id, to_id: input.to_id, relation_type: input.relation_type,
    message: 'Edge already existed — original why kept. No new edge was created.',
  });
}
return toolSuccess({ id, from_id: input.from_id, to_id: input.to_id, relation_type: input.relation_type });
```

Só devolver `id` quando `inserted === true`. Atualizar a DESCRIPTION: trocar "Duplicate edges ... are silently ignored" por "Duplicate edges (same from_id, to_id, relation_type) return duplicate:true and keep the original why".

Em `save_note`, o campo `edges_created` da resposta (`src/mcp/tools/save-note.ts:162`) passa a somar apenas os inserts que retornaram `true` (em vez de `input.edges?.length`).

### 4. Nova tool `delete_link` (`src/mcp/tools/delete-link.ts`, novo)

Espelhar o padrão de `delete_note` (`confirm: z.literal(true)`, `destructiveHint: true`, `safeToolHandler`):

- **Input:** `from_id: z.string().min(1)`, `to_id: z.string().min(1)`, `relation_type: z.enum(EDGE_TYPES)`, `confirm: z.literal(true)`. A tripla é a chave natural (`UNIQUE` em `0001_init.sql:51`) — não expor o `id` interno da edge, que o agente raramente tem em mãos.
- **Handler:**
  1. Buscar a edge (`SELECT` pela tripla) pra poder citar o `why` na resposta; se não existe, `toolError` orientando a chamar `expand(note_id)` pra ver as edges reais (com direção: `expand` retorna `getEdgesFrom`/`getEdgesTo`, e a edge é direcional — errar `from`/`to` invertidos é o erro mais provável; o texto do erro deve sugerir tentar a direção inversa).
  2. `deleteEdge(env, ...)` (hard delete — edge não tem soft-delete; recriar via `link` é barato e o `why` removido é citado na resposta como registro).
  3. Invalidar o cache do grafo. O `sourceHash` já cobre o caso (COUNT de `edges` muda no DELETE — `src/web/graph-data.ts:55-58`), mas seguir o padrão explícito do endpoint web (`src/web/graph-data.ts:301`): exportar de `src/web/graph-data.ts` um helper `invalidateGraphCache(env: Env): Promise<void>` que faz `env.GRAPH_CACHE.delete(CACHE_KEY)` (hoje `CACHE_KEY` é const privada na linha 43), usar o helper na nova tool E refatorar a linha 301 pra usá-lo. Chamar em best-effort (try/catch com `console.error`) — falha de KV não pode falhar o delete já commitado.
  4. `toolSuccess({ deleted: true, from_id, to_id, relation_type, why_removed: <why original> })`.
- **DESCRIPTION:** deixar claro que é irreversível mas barato de recriar via `link`; fluxo recomendado: `expand(note_id)` primeiro pra confirmar a tripla exata e a direção; pedir confirmação ao usuário antes (citar o `why` de volta); uso principal: curadoria (edge errada, `why` vago, edge órfã de conceito reformulado). Mencionar que edição de `why` = `delete_link` + `link` novo.
- **Registrar** em `src/mcp/registry.ts` (import + `registerDeleteLink(server, env);` junto do bloco de notas, após `registerLink`).

Atualizar `src/mcp/tools/update-note.ts:27`: trocar "edges cannot be deleted via MCP yet" por "use link (add) or delete_link (remove); to edit a why, delete_link then link again".

### 5. Fronteira nota/task documentada tool a tool

Regra decidida nesta spec: **leitura e mídia aceitam task; escrita/destruição de task só pelas tools de task.**

- `get_note`, `expand`, `attach_media_to_note`, `get_note_media`, `delete_note_media`: continuam aceitando `kind='task'` (comportamento atual, mantido de propósito — ler uma task por id e anexar mídia a ela são operações legítimas). Adicionar 1 frase na DESCRIPTION de cada uma registrando isso (ex.: "Works for tasks (kind='task') too.").
- `delete_note` (`src/mcp/tools/delete-note.ts`): passa a REJEITAR `kind='task'` com `toolError` apontando o caminho certo: `update_task(id, status: 'canceled')` pra descartar, `complete_task(id)` pra concluir. Motivo: task tem ciclo de vida próprio (status/completed_at) e não tem vetor — o fluxo do `delete_note` (Vectorize delete + soft-delete) não faz sentido pra ela, e um soft-delete silencioso some com a task do Kanban sem registrar desfecho. Registrar a regra na DESCRIPTION.
- `link` / `save_note` (edges): rejeitam task como extremo (item 2 acima).

## Fora de escopo

- Edição de `why` de edge existente como tool própria — `delete_link` + `link` cobre.
- UI de grafo (remover edge pelo dashboard web) — só MCP nesta spec.
- Limpeza retroativa de edges já apontando pra tasks no banco de produção (se existirem) — vira proposta da skill de curadoria semanal usando a própria `delete_link` nova.
- Soft-delete de edges — hard delete é aceitável (recriação barata, `why` devolvido na resposta).
- Mudança de schema/migrations — nada muda no D1.

## Critérios de aceite

- [ ] `link` com `from_id` ou `to_id` de nota `kind='task'` retorna `isError: true` com mensagem direcionando pra tags de task, e NÃO cria linha em `edges`.
- [ ] `save_note` com edge cujo `to_id` é task retorna `isError: true` e NÃO grava a nota nem a edge (sem write parcial em D1).
- [ ] `link` duplicado (mesma tripla `from_id, to_id, relation_type`) retorna `duplicate: true` com mensagem "edge already existed", SEM campo `id`, e o `why` original permanece intacto no banco.
- [ ] `link` novo (não duplicado) continua retornando `id` que existe de fato em `edges`.
- [ ] Tool `delete_link(from_id, to_id, relation_type, confirm: true)` registrada com `destructiveHint: true`; remove a linha de `edges` e responde com o `why` removido.
- [ ] `delete_link` numa tripla inexistente retorna `isError: true` sugerindo `expand()` e a hipótese de direção invertida, sem tocar o banco.
- [ ] `delete_link` invalida o `GRAPH_CACHE` via helper exportado de `src/web/graph-data.ts` (e o endpoint web `handleGraphLink` passa a usar o mesmo helper).
- [ ] `delete_note` num id de task retorna `isError: true` apontando `update_task`/`complete_task`, e a task NÃO é soft-deletada.
- [ ] `insertEdge` retorna `boolean`; `edges_created` do `save_note` conta só inserts reais.
- [ ] Description do `update_note` não afirma mais que edges não podem ser deletadas via MCP.
- [ ] Testes novos cobrindo os 4 comportamentos (task como extremo em link, task como extremo em save_note, duplicata honesta, delete_link feliz + tripla inexistente) passam; suíte existente segue verde.

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck          # tsc --noEmit (worker + client)
npm test                   # vitest run + vitest run --config vitest.auth.config.ts
```

Testes a escrever (padrão de `test/tools/link.test.ts` — registrar a tool com um `server` fake e chamar o handler direto, seed via `E.DB.prepare(...INSERT INTO notes...)`; pra task, inserir linha com `kind='task'` e `status='open'`):

- Ampliar `test/tools/link.test.ts`: caso "rejects task endpoint" (from e to), caso "duplicate returns duplicate:true without id" (chamar 2x e conferir `COUNT(*)` em edges = 1 + `why` original).
- Ampliar `test/tools/save-note.test.ts`: edge pra task rejeitada, nota não gravada.
- Novo `test/tools/delete-link.test.ts`: happy path (edge some, resposta traz `why_removed`), tripla inexistente (isError), schema exige `confirm: true`.
- Ampliar `test/tools/delete-note.test.ts`: id de task rejeitado, `deleted_at` continua NULL.

Teste manual (opcional, em `wrangler dev`): criar 2 notas + 1 task via tools, tentar `link` nota→task (deve falhar), `link` nota→nota 2x (segunda deve vir `duplicate: true`), `delete_link` da edge criada, conferir no dashboard `/app/` que a edge sumiu do grafo.

Deploy (`npm run deploy`) SOMENTE com OK explícito do dono do repo.

## Arquivos afetados

- `src/mcp/tools/link.ts` — bloqueio de task + resposta de duplicata + DESCRIPTION
- `src/mcp/tools/save-note.ts` — bloqueio de task no array `edges` + `edges_created` real + DESCRIPTION
- `src/mcp/tools/delete-link.ts` — NOVO
- `src/mcp/tools/delete-note.ts` — rejeitar `kind='task'` + DESCRIPTION
- `src/mcp/tools/update-note.ts` — corrigir DESCRIPTION (linha 27)
- `src/mcp/tools/get-note.ts`, `src/mcp/tools/expand.ts`, `src/mcp/tools/attach-media.ts`, `src/mcp/tools/get-note-media.ts`, `src/mcp/tools/delete-note-media.ts` — só DESCRIPTION (fronteira nota/task documentada)
- `src/mcp/registry.ts` — registrar `delete_link`
- `src/db/queries.ts` — `insertEdge` → boolean; nova `deleteEdge`
- `src/web/graph-data.ts` — exportar `invalidateGraphCache` e usar no `handleGraphLink`
- `test/tools/link.test.ts`, `test/tools/save-note.test.ts`, `test/tools/delete-note.test.ts` — casos novos
- `test/tools/delete-link.test.ts` — NOVO

## Riscos e reversão

- **Sem migration, sem mudança de dados** — rollback é `git revert` do(s) commit(s) + `npm run deploy` da versão anterior. Nenhum dado precisa ser restaurado.
- **Edge deletada por engano via `delete_link`:** hard delete, mas a resposta da tool devolve o `why` removido — recriar com `link(from_id, to_id, relation_type, why)` restaura 1:1.
- **Falso positivo do bloqueio de task:** só dispara em `kind === 'task'` exato; os 7 kinds de conhecimento e `kind IS NULL` (notas legadas) passam intactos — sem risco pra notas existentes.
- **Agentes/skills que dependiam do `id` retornado em duplicata:** comportamento anterior devolvia id inválido (bug), então qualquer consumidor desse id já estava quebrado; a mudança só torna o erro visível. Conferir skills de curadoria que parseiam a resposta do `link` antes do deploy.
- **`delete_note` rejeitando task:** se algum fluxo existente usava `delete_note` pra sumir com task, ele passa a receber erro com instrução do caminho certo (`update_task`/`complete_task`) — degradação orientada, não silenciosa.
