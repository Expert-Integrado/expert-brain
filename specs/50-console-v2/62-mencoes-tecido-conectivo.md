# Menções: tecido conectivo nota↔task↔contato — vínculo first-class cross-módulo

> **Status:** ready · **Prioridade:** P1 · **Esforço:** L · **Repo:** ambos (expert-brain + expert-contacts)
> **Depende de:** `50-console-v2/56` (página do contato — recebe as seções reversas) e `50-console-v2/57` (`CONTACTS_WRITE_TOKEN` — reusado pra disparar o evento). Coordena com `61` (contato privado nas superfícies de menção).
> **Agente sugerido:** Opus (schema cross-repo + contrato MCP) · **Esforço de execução:** ultrathink

## Contexto

- Nota, task e contato vivem em silos: notas/tasks na tabela `notes` do Brain; contatos no worker expert-contacts (D1 próprio), lidos pelo Brain via service binding `CONTACTS` (`wrangler.toml:43-46`) + Bearer read-only.
- A ÚNICA ligação possível hoje é informal: tag com nome de pessoa na task (`src/mcp/tools/list-tasks.ts:11` sugere isso) — sem id, sem direção reversa, sem render.
- O contacts JÁ tem o kind de evento `mentioned_in_brain` no enum original (`src/db/migrate.ts`, migration 0001) — a intenção existia; nada nunca dispara esse evento.
- A spec `57` cria o secret `CONTACTS_WRITE_TOKEN` escopado a `POST /app/entity/event` — exatamente o canal necessário pra registrar a menção na timeline do contato.
- A spec `56` cria a página `/app/contacts/<id>` no console do Brain — o lugar natural das seções reversas.
- Edges nota↔nota existem (grafo latticework); edges de/para task são REJEITADAS por design (tasks fora do grafo). A menção NÃO é edge — é outra relação, com outra tabela.
- Migrations runtime do Brain: array `MIGRATIONS` em `src/db/migrate.ts`, DDL aditiva; número abaixo é INDICATIVO (regra transversal da Fase 5/6 do roadmap).

## Problema / Motivação

- "Reunião com a pessoa X, decidimos Y" (nota) + "follow-up com X" (task) + o contato X são três registros que NÃO se enxergam. A pergunta mais valiosa do sistema — "o que eu sei e o que devo fazer em relação a essa pessoa?" — não tem resposta em lugar nenhum.
- Sem menção first-class, a página do contato (56) mostra canais e timeline, mas não o CONHECIMENTO sobre a pessoa (notas) nem os COMPROMISSOS com ela (tasks).
- Task nascida de uma decisão em nota perde a origem — não dá pra auditar "por que essa task existe".

## Design proposto

### 1. Migration `0012_mentions` (Brain, aditiva — número indicativo)

```sql
CREATE TABLE IF NOT EXISTS mentions (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,  -- nota OU task (mesma tabela)
  entity_id  TEXT NOT NULL,                                          -- id da entidade no expert-contacts (sem FK cross-DB)
  entity_label TEXT,                                                 -- cache do nome no momento da menção (render sem roundtrip)
  created_at INTEGER NOT NULL,
  UNIQUE (note_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions (entity_id);
ALTER TABLE notes ADD COLUMN origin_note_id TEXT REFERENCES notes(id);  -- só tasks usam: nota que originou a task
```

`entity_label` é cache de exibição (o nome canônico continua no contacts; refresh no render quando divergir é aceitável — não sincronizar ativamente).

### 2. Escrita de menções

- **MCP (aditivo)**: `save_note`, `update_note`, `save_task`, `update_task` ganham `mentions?: string[]` (ids de entidade). Upsert por `(note_id, entity_id)`; array NÃO remove ausentes (remoção explícita via `mentions_remove?: string[]`). As descriptions instruem o agente: obtenha o id via `get_contact_by_phone`/`search` do contacts ANTES de mencionar — **não aceitar nome livre** (evita menção-fantasma por typo/homônimo).
- **Console**: no editor de nota/task, autocomplete `@` — digitou `@`, client consulta a busca de contatos já proxyada pelo Brain (rota de sessão existente de `56`/contacts-data) e insere chip. O POST de save envia `mentions[]` junto.
- **Task a partir de nota**: botão "Criar task desta nota" no detalhe da nota → abre quick-create com `origin_note_id` preenchido e menções HERDADAS da nota. `save_task` (MCP) também aceita `origin_note_id`.

### 3. Efeitos colaterais da menção (o tecido)

Ao CRIAR uma menção (qualquer superfície), o Brain:

1. **Dispara evento na timeline do contato**: `POST /app/entity/event` no contacts via `CONTACTS_WRITE_TOKEN` (infra da `57`), kind `mentioned_in_brain`, context = título da nota/task + URL do console. Via `ctx.waitUntil` — falha do evento NÃO falha o save (timeline é eco, não fonte).
2. **Grafo**: o payload do grafo do Brain (camada contatos) ganha arestas nota↔contato das menções (estilo visual distinto de edge de conhecimento). Bump do `CACHE_KEY` do grafo.

Remoção da menção não apaga o evento já disparado (timeline é histórico).

### 4. Superfícies de leitura

- **Página do contato** (`/app/contacts/<id>`, da 56) ganha DUAS seções (dados 100% Brain-local, query em `mentions`):
  - "Notas sobre esta pessoa" — notas de conhecimento que a mencionam (título, kind badge, data; link).
  - "Tarefas com esta pessoa" — tasks abertas/em progresso que a mencionam (título, due, prioridade; link) + contador de fechadas.
- **Detalhe de nota/task**: chips das menções (label + link pra página do contato); no detalhe da nota, seção "Tasks originadas desta nota" (query por `origin_note_id`).
- **MCP**: `get_note`/`get_task` incluem `mentions: [{entity_id, label}]` (aditivo); `list_tasks` ganha filtro `mentions_entity?: string` (id) — "tasks com essa pessoa" via agente.
- **Privacidade (coordenação com 31/59/61)**: menção herda a visibilidade da NOTA (nota privada → menção invisível nas superfícies MCP sem escopo, já coberto pelos gates de nota/task). Contato privado (61): as seções da página do contato são sessão do dono (vê tudo); nos retornos MCP de `get_note`, menção a contato privado retorna só `entity_id` sem label pra caller sem escopo `private` (não vazar nome).

### 5. Queries novas (`src/db/queries.ts`)

`upsertMention`, `removeMention`, `listMentionsForNote`, `listNotesMentioning(entityId, {kinds, statuses})`, `listTasksFromOrigin(noteId)`.

## Fora de escopo

- Detecção automática de nomes em texto livre (só menção explícita — id ou @autocomplete).
- Menção em comentário de task (`53`) — iteração futura.
- Sincronização ativa do `entity_label` (cache com refresh no render é suficiente).
- Menção contato→contato (isso é `connections` do contacts, já existe).
- Backfill de tags antigas com nome de pessoa → menções (curadoria manual do dono, se quiser).

## Critérios de aceite

- [ ] Migration aplicada; nenhuma nota/task existente alterada.
- [ ] `save_note` com `mentions: [id]` cria a menção, dispara `mentioned_in_brain` na timeline do contato (visível na página) e o grafo mostra a aresta nota↔contato.
- [ ] Página do contato lista notas e tasks que o mencionam; task fechada sai da lista de abertas e entra no contador.
- [ ] "Criar task desta nota": task nasce com `origin_note_id` + menções herdadas; detalhe da nota lista a task originada.
- [ ] `@` no editor autocompleta contatos e o save persiste; remover chip + salvar remove a menção (`mentions_remove`).
- [ ] `list_tasks mentions_entity:` filtra corretamente; `get_note`/`get_task` retornam `mentions[]`.
- [ ] Falha no POST do evento (contacts fora do ar) NÃO impede o save da nota (teste com binding mockado falhando).
- [ ] Caller MCP sem escopo `private`: menção a contato privado vem sem `entity_label`.
- [ ] Contratos existentes intocados (params novos opcionais).

## Validação

- Brain: `npm run typecheck` + `npm test`; Contacts: `npx tsc --noEmit` + `npm test` — verdes.
- Testes novos: upsert/remove/unique de menção, herança na task-from-note, filtro `mentions_entity`, waitUntil tolerante a falha, label omitido sem escopo.
- Manual (`wrangler dev` nos dois): fluxo completo nota→menção→timeline→página do contato→task.
- **Gate de deploy:** os DOIS workers só com OK explícito do dono da instância.

## Arquivos afetados

- expert-brain: `src/db/migrate.ts` (0012), `src/db/queries.ts`, `src/mcp/tools/{save,update}-note.ts` + `{save,update,get,list}-task.ts` + `get-note.ts`, `src/web/notes.ts` (chips, botão task-from-note), `src/web/tasks.ts` + client (chips), `src/web/contact-page.ts` + client (seções reversas), `src/web/contacts-data.ts` (POST evento de menção), `src/web/graph-data.ts` (arestas de menção + CACHE bump), `test/`
- expert-contacts: nenhum código novo obrigatório (kind `mentioned_in_brain` e o write path da 57 já existem) — só teste de integração do evento.

## Riscos e reversão

- **Risco**: menção órfã (entidade deletada no contacts). Sem FK cross-DB — render cai no `entity_label` cacheado com marcação "contato removido"; aceitável.
- **Risco**: enxurrada de eventos `mentioned_in_brain` poluindo a timeline. Mitigação: dedupe por `(note_id, entity_id)` garante 1 evento por par; a timeline filtra por kind (57).
- **Reversão**: revert do código; tabela `mentions` e coluna `origin_note_id` ficam inertes (aditivas).
