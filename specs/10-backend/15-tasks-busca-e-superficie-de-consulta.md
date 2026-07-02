# Tasks: busca textual, get_task, filtros corretos e parse de prazo em BRT

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

Tasks são notas com `kind='task'` na mesma tabela `notes`, com 4 colunas extras (`status`, `due_at`, `priority`, `completed_at` — migration `0006_task_fields`). Por decisão de design, tasks ficam FORA do grafo, do recall e da lista de notas (`NON_TASK_FILTER` em `src/db/queries.ts:31`), e têm tools próprias:

- `save_task` — `src/mcp/tools/save-task.ts`
- `list_tasks` — `src/mcp/tools/list-tasks.ts`
- `list_tasks_due_today` — `src/mcp/tools/list-tasks-due-today.ts`
- `update_task` — `src/mcp/tools/update-task.ts`
- `complete_task` — `src/mcp/tools/complete-task.ts`
- Registro central: `src/mcp/registry.ts:33-38`

Queries de task em `src/db/queries.ts:226-368` (`getTaskById`, `listActiveTasks`, `listRecentClosedTasks`, `listTasksDueBefore`, `updateTask`, `TaskPatch`). Parse de prazo em `src/util/time.ts:15-45` (`parseDueToMs`, BRT fixo UTC-3).

Fato relevante pro design: os triggers do FTS (`src/db/migrations/0001_init.sql:18-33`) indexam TODAS as linhas de `notes` — inclusive tasks. A exclusão de tasks da busca acontece só no read, na cláusula `AND (n.kind IS NULL OR n.kind <> 'task')` de `ftsSearch` (`src/db/queries.ts:219`). Ou seja: as tasks JÁ estão no índice `notes_fts`; só não existe caminho de leitura que as alcance.

## Problema / Motivação

1. **Tasks são invisíveis em QUALQUER busca.** `recall` não embeda task (decisão firmada, correta) e `ftsSearch` exclui `kind='task'` no read (`src/db/queries.ts:219`). Não há busca textual alguma sobre tasks. Consequência prática: pra deduplicar antes de um `save_task` ou resgatar uma task antiga, o agente precisa chamar `list_tasks` e paginar até 500 itens dentro do contexto — caro e propenso a falha conforme o vault cresce.
2. **Não existe `get_task`.** `get_note` usa `getNoteById` e devolve shape de nota (title/body/tldr/domains) SEM `status`, `due_at`, `priority`, `completed_at` — o agente que tem um id de task em mãos não consegue ler o estado completo dela.
3. **`list_tasks` com `status: ['done']` retorna `[]` silencioso.** A base do handler é só `listActiveTasks` (`src/mcp/tools/list-tasks.ts:40`); fechadas só entram se o caller TAMBÉM passar `include_closed: true` (`list-tasks.ts:41-43`). Pedir `status: ['done']` sem `include_closed` filtra um conjunto que nunca conteve done → vazio sem erro nem aviso.
4. **`update_task` não limpa `due` nem `priority`.** `TaskPatch` aceita `due_at: number | null` e `priority: number | null` (`src/db/queries.ts:327-334`), e o SQL do `updateTask` já grava null — mas a tool só expõe `due?: string` e `priority?: number` (`src/mcp/tools/update-task.ts:12-16`). Não há como remover um prazo ou prioridade via MCP.
5. **Fallback do `parseDueToMs` interpreta como UTC.** Em `src/util/time.ts:38-41`, input que não casa com o regex estrito cai em `Date.parse(raw)` cru, que trata ISO date-time sem timezone como UTC em vários formatos — prazo gravado 3h adiantado, silenciosamente. Agravante: `raw.replace(' ', 'T')` na linha 26 troca só o PRIMEIRO espaço, então input com espaços extras (ex.: `"2026-06-22  14:00"`) escapa do caminho BRT e cai no fallback. Componentes sem zero-pad (`"2026-6-2 9:00"`) também caem no fallback.
6. **`due` e `due_at` juntos: conflito silencioso.** Em `save-task.ts:66-75` e `update-task.ts:84-94`, `due_at` vence e `due` é ignorado sem erro — se divergirem, o agente acha que gravou uma coisa e gravou outra.
7. **Filtro de tag é match exato case-sensitive.** `list-tasks.ts:53` usa `includes(input.tag)` — `tag: "Cliente-X"` não acha task tagueada `cliente-x`.
8. **Custo desnecessário: tags buscadas antes do slice.** `list-tasks.ts:51` chama `getTagsForNotes` pra TODAS as tasks e o `slice(0, limit)` só vem na linha 56 — quando não há filtro de tag, busca tags de itens que serão descartados. E `listActiveTasks` (`queries.ts:264-271`) não tem LIMIT no SQL.

## Objetivo

Qualquer task do vault é encontrável por busca textual (`query` no `list_tasks`) e legível por id (`get_task`) em 1 chamada, com filtros de status/tag corretos, limpeza de due/priority possível via `update_task` e parse de prazo que NUNCA grava fuso errado silenciosamente.

## Design proposto

Zero migration — tudo é código de read path + tools. Nenhuma mudança de schema, nenhum reprocessamento de dados existentes.

### 1. Busca textual: parâmetro `query` no `list_tasks`

Nova função em `src/db/queries.ts`, ao lado de `ftsSearch` (~linha 224), reusando `sanitizeFtsQuery` com `prefix = true` (busca exploratória, dedupe por fragmento de título):

```ts
// Busca FTS restrita a tasks — o espelho do ftsSearch, que as exclui.
// As linhas de task JÁ estão no notes_fts (triggers 0001 indexam tudo);
// aqui só se abre o caminho de leitura. Zero migration.
export async function ftsSearchTasks(env: Env, query: string, limit: number): Promise<TaskRow[]> {
  const safe = sanitizeFtsQuery(query, true);
  if (!safe) return [];
  const r = await env.DB.prepare(
    `SELECT ${TASK_COLS.split(', ').map((c) => `n.${c}`).join(', ')}
     FROM notes_fts f
     JOIN notes n ON n.rowid = f.rowid
     WHERE notes_fts MATCH ? AND n.deleted_at IS NULL AND n.kind = 'task'
     ORDER BY rank
     LIMIT ?`
  ).bind(safe, limit).all<TaskRow>();
  return r.results ?? [];
}
```

(Se preferir literal, escrever as colunas com prefixo `n.` à mão — o importante é devolver `TaskRow` completo.)

No `list_tasks` (`src/mcp/tools/list-tasks.ts`):
- Novo campo no `inputSchema`: `query: z.string().optional()` com describe explicando que roda busca textual (título+corpo) SÓ em tasks, todos os status inclusos por padrão quando `query` presente.
- Quando `input.query` vier: base = `ftsSearchTasks(env, input.query, limit)` em vez de `listActiveTasks` + `listRecentClosedTasks` (a busca cobre abertas E fechadas — dedupe precisa ver fechadas). Filtros de `status` e `tag` continuam aplicando por cima.
- Fallback: se o FTS complicar (ex.: rank instável no D1), alternativa aceitável é `LIKE` em `title`/`body` com `WHERE kind = 'task' AND deleted_at IS NULL AND (title LIKE ? OR body LIKE ?)` — decidir na implementação, FTS é o preferido.
- **Decisão firmada (não revisitar aqui): task NÃO entra no recall semântico.** Nada de embedding.

### 2. Nova tool `get_task`

Novo arquivo `src/mcp/tools/get-task.ts`, espelhando o padrão dos outros (zod inputSchema, `safeToolHandler`, annotations `readOnlyHint: true`):
- Input: `id: z.string().min(1)`.
- Handler: `getTaskById(env, id)` (`src/db/queries.ts:255`) → se null, `toolError` no padrão do `update_task` ("not found or not a task… do NOT retry"). Senão, `toolSuccess` com shape completo: `id, title, body, status, priority, due_at, due_brt (formatBrtDateTime), when (relativeDue), completed_at, completed_brt, domains (JSON.parse), tags (getTagsByNote), created_at, updated_at, url (noteUrl)`.
- Description deve dizer: "get_note devolve shape de nota e não serve pra task — use get_task pra ler status/prazo/prioridade".
- Registrar em `src/mcp/registry.ts` no bloco de tasks (após `registerUpdateTask`, linha 38) + import.

### 3. `list_tasks`: status fechado busca fechadas automaticamente

Em `list-tasks.ts:39-48`: se `input.status` contém `done` ou `canceled` (ou `include_closed` true), concatenar `listRecentClosedTasks(env, limit)` na base — sem exigir o flag. `include_closed` continua existindo (compat), vira redundante nesses casos. Atualizar o describe do campo `status` avisando que done/canceled retorna as N mais recentes (limitadas pelo `limit`), não o histórico completo.

### 4. `update_task`: limpar `due` e `priority`

Em `src/mcp/tools/update-task.ts`:
- `due`: aceitar o valor sentinela `'none'` (e alias `'clear'`) → `patch.due_at = null`. Documentar no describe: `Pass 'none' to REMOVE the due date.`
- `priority`: trocar pra `z.union([z.number().int().min(1).max(4), z.null()])` → `null` limpa (`patch.priority = null`). Cuidado com o guard `hasEdit` (linha 63-67) e o `if (input.priority !== undefined)` (linha 75): `null !== undefined`, então já passam — só garantir que o valor null flui até o patch.
- `TaskPatch` e o SQL de `updateTask` (`queries.ts:341-368`) já suportam null — não mudar.

### 5. `parseDueToMs` sem fallback UTC (`src/util/time.ts`)

- Linha 26: `raw.replace(' ', 'T')` → `raw.replace(/\s+/g, 'T')` NÃO — isso quebraria mais de um espaço em Ts múltiplos; o correto é normalizar: `raw.replace(/\s+/, 'T')` com regex que consome TODOS os espaços entre data e hora numa substituição só (ex.: `raw.replace(/^(\S+)\s+/, '$1T')`).
- Aceitar componentes sem zero-pad: relaxar os regexes pra `\d{1,2}` em mês/dia/hora/minuto e re-emitir zero-padded antes de colar o `BRT_OFFSET` (helper interno que faz split + pad).
- **REMOVER o fallback `Date.parse(raw)` das linhas 38-41.** Input que não casar com os formatos documentados → retornar `null`. O `toolError` de `save_task`/`update_task` já guia o formato correto ("Use BRT formats like…"). Errar alto > gravar prazo 3h adiantado em silêncio.
- Opcional (avaliar na implementação): aceitar `DD/MM/YYYY` e `DD/MM/YYYY HH:MM` convertendo pra ISO + `BRT_OFFSET` explícito — formato natural em PT-BR. Se entrar, cobrir com teste; se não entrar, não documentar nos describes.
- Manter intactos: caminho com timezone explícito (linhas 20-23), date-only → 23:59 BRT (29-31), HH:MM → HH:MM:00 (34-36).

### 6. `due` + `due_at` juntos → erro

Em `save-task.ts:66-75` e `update-task.ts:84-94`: se AMBOS vierem, `toolError('Pass either due (BRT string) or due_at (unix ms), not both.')` — sem tentar reconciliar. Atualizar os describes dos dois campos nas duas tools.

### 7. Tag case-insensitive nos dois lados

- Leitura (`list-tasks.ts:53`): comparar com `.toLowerCase()` dos dois lados.
- Escrita: normalizar tags pra lowercase (+ `.trim()`) em `insertTags` e `replaceTags` (`queries.ts:61-65` e `131-137`) — vale pra tasks e notas, mantém o vault convergindo pro formato canônico sem migration (dados antigos com maiúscula continuam matcháveis porque a LEITURA também normaliza).

### 8. Slice antes das tags + LIMIT defensivo

- `list-tasks.ts`: quando NÃO há `input.tag`, aplicar `tasks = tasks.slice(0, limit)` ANTES de `getTagsForNotes`. Quando há filtro de tag, manter a ordem atual (precisa das tags de todas pra filtrar) e fazer o slice depois.
- `listActiveTasks` (`queries.ts:264-271`): adicionar `LIMIT 500` defensivo no SQL (teto do `limit` da tool), documentando no comentário.

### Gate transversal

**Toda mudança de comportamento acima DEVE refletir nos `DESCRIPTION`/describes das tools** (`list_tasks`, `get_task`, `update_task`, `save_task`) — o agente consumidor descobre os recursos exclusivamente por elas. PR sem describe atualizado não passa.

## Fora de escopo

- Lifecycle de tasks / auto-cancel de vencidas antigas (spec `30-features/32`).
- Embedding/recall semântico de tasks — decisão firmada de NÃO indexar.
- Mudanças no Kanban `/app/tasks` (web) — só backend/MCP.
- Migration de dados (normalizar tags antigas em massa, reindexar FTS) — nada disso é necessário.
- `list_tasks_due_today` — sem mudanças.

## Critérios de aceite

- [ ] `list_tasks({ query: "relatório" })` retorna tasks (abertas E fechadas) cujo título/corpo casa por prefixo, sem nenhuma nota de conhecimento no resultado.
- [ ] `recall` continua NÃO retornando tasks (nenhuma mudança no caminho semântico) e `ftsSearch` de notas continua excluindo tasks.
- [ ] `get_task(id)` de uma task devolve `status`, `priority`, `due_at`, `due_brt`, `completed_at`, `tags`, `url`; com id de nota comum ou inexistente devolve `toolError` sem lançar.
- [ ] `list_tasks({ status: ['done'] })` retorna tasks done SEM precisar de `include_closed`.
- [ ] `update_task({ id, due: 'none' })` zera `due_at` (fica null); `update_task({ id, priority: null })` zera `priority`.
- [ ] `parseDueToMs("2026-06-22T14:00:00")` continua = 17:00 UTC (BRT). `parseDueToMs("June 22, 2026")` e qualquer formato fora dos documentados retornam `null` (fallback UTC removido). `"2026-6-2 9:00"` parseia como BRT.
- [ ] `save_task`/`update_task` com `due` E `due_at` simultâneos e divergentes retornam `toolError`.
- [ ] `list_tasks({ tag: 'Cliente-X' })` encontra task com tag `cliente-x` e vice-versa; tags novas são gravadas em lowercase.
- [ ] `list_tasks` sem filtro de tag não chama `getTagsForNotes` pra itens além do `limit` (verificável por spy no teste).
- [ ] Describes/DESCRIPTIONs de `list_tasks`, `get_task`, `update_task` e `save_task` documentam todos os comportamentos novos.
- [ ] Suíte completa verde e typecheck limpo.

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck
npx vitest run test/util/time.test.ts test/tools/list-tasks.test.ts test/tools/save-task.test.ts test/tasks-queries.test.ts
npm test            # suíte completa (inclui vitest.auth.config.ts)
```

Teste manual (preview local): `npm run dev` + chamar as tools via MCP inspector ou cliente local — criar task com prazo `"2026-08-01 9:00"`, confirmar `due_brt = "01/08/2026 09:00"`, buscar por `query`, limpar o prazo com `due: 'none'`, ler via `get_task`.

**Deploy (`npm run deploy`) SOMENTE com OK explícito do dono do repo.**

## Arquivos afetados

- `src/mcp/tools/list-tasks.ts` — `query`, status fechado automático, tag case-insensitive, slice antes das tags, DESCRIPTION
- `src/mcp/tools/get-task.ts` — **novo**
- `src/mcp/tools/update-task.ts` — `due: 'none'`, `priority: null`, conflito due/due_at, describes
- `src/mcp/tools/save-task.ts` — conflito due/due_at, describes
- `src/mcp/registry.ts` — registrar `get_task`
- `src/util/time.ts` — `parseDueToMs` (regex de espaço, zero-pad, remover fallback UTC)
- `src/db/queries.ts` — `ftsSearchTasks`, LIMIT em `listActiveTasks`, lowercase em `insertTags`/`replaceTags`
- `test/util/time.test.ts` — casos novos de parse (sem zero-pad, fallback removido)
- `test/tools/list-tasks.test.ts` — query, status done, tag case-insensitive, ordem slice/tags
- `test/tools/get-task.test.ts` — **novo**
- `test/tools/save-task.test.ts` — conflito due/due_at
- `test/tasks-queries.test.ts` — `ftsSearchTasks`, patch null

## Riscos e reversao

- **Zero risco de dados:** nenhuma migration, nenhuma escrita destrutiva. O índice FTS já contém as tasks; só se abre leitura.
- **Fallback UTC removido pode rejeitar formatos que "funcionavam" (errado):** clientes que mandavam formatos exóticos passam a receber `toolError` com o formato correto — comportamento desejado, mas monitorar reclamação nos primeiros dias.
- **Lowercase na escrita de tags:** afeta também notas (não só tasks). Como a leitura do filtro também normaliza, não há quebra funcional; tags antigas com maiúscula seguem no banco como estão.
- **Rollback:** `git revert` do(s) commit(s) + `npm run deploy` da versão anterior. Sem estado novo no D1/Vectorize pra desfazer — reverter o código restaura 100% do comportamento anterior. Tags gravadas em lowercase durante a janela permanecem lowercase (inócuo: o filtro antigo com match exato só falharia se o caller passasse maiúscula, mesmo caso de hoje).
