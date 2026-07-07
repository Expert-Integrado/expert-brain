# Contacts: DELETE de entidade/connection e merge de duplicatas

> **Status:** done (07/07/2026 — deploy c85f0a98; itens 1-4 shipados + merge tambem move entity_channels (schema evoluiu apos a spec, UPDATE OR IGNORE + dedupe via CASCADE); item 5 (UI no Console) segue opcional/nao feito; GATE OPERACIONAL PENDENTE: backup do D1 com OK do dono ANTES do primeiro delete/merge real em producao) · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-contacts
> **Depende de:** `40-ops/42-contacts-testes-typecheck-ci.md` (gate: operações destrutivas não entram sem suíte de testes) · `10-backend/19-contacts-write-path-e-canon-unico.md` (previne NOVAS duplicatas; esta spec cura as existentes)

## Contexto

O expert-contacts é um Worker Cloudflare (D1 + Vectorize + R2 + Workers AI) que mantém um grafo de entidades (`kind = person | company | group | place | event | other`) com `connections` (arestas), `events` (log de interações) e `media` (blobs em R2, deduplicados por hash).

O que existe hoje:

- **Rotas da API** (`src/index.ts:696-731`): apenas `GET` e `POST`. O bloco de comentário no topo do arquivo (`src/index.ts:14-29`) lista todas as rotas — nenhuma é de remoção. Não existe `DELETE /entities/:id`, `DELETE /connections/:id` nem qualquer rota de merge.
- **MCP standalone** (`mcp/index.js:49-165`): 8 tools (`save_person`, `save_company`, `recall`, `get_entity`, `get_contact_by_phone`, `connect`, `log_event`, `stats`). Nenhuma destrutiva.
- **Console web** (`src/web/`): painel de detalhe da entidade (`src/web/detail.ts`) é somente-leitura — sem ação de deletar/mesclar.
- **Schema** (`migrations/0002_entities.sql`): as três tabelas dependentes já têm `ON DELETE CASCADE` pra `entities(id)` — `connections.a_id/b_id` (linhas 28-29), `events.entity_id` (linha 47), `media.entity_id` (linha 63). O D1 aplica foreign keys por padrão, então um `DELETE FROM entities WHERE id = ?` já limpa as linhas dependentes.
- **Vetores**: cada entidade tem um vetor no Vectorize com o MESMO id da linha do D1 (`upsertVectorize`, `src/index.ts:134-141`). Não há nenhuma chamada `VECTORIZE.deleteByIds` no código.
- **Blobs R2**: `media.r2_key` é `sha256/<hash>.<ext>` (`src/index.ts:487`) e o blob é deduplicado por conteúdo (`src/index.ts:489-490`) — o MESMO blob pode ser referenciado por várias linhas de `media` (de entidades diferentes). Deletar o blob exige refcount.
- **Auth** (`requireAuth`, `src/index.ts:69-78`): `OWNER_TOKEN` dá acesso total; `CONTACTS_PROXY_TOKEN` dá acesso somente-leitura (`GET`). Escritas exigem `OWNER_TOKEN`.
- **Upsert com COALESCE** (`src/index.ts:234-246`): padrão já usado no repo pra "preencher sem sobrescrever" — o merge reaproveita a mesma semântica.
- **Constraint de unicidade de aresta**: `UNIQUE(a_id, b_id, type)` em `connections` (`migrations/0002_entities.sql:34`) — o merge precisa deduplicar contra ela ao re-apontar arestas.
- **Re-embedding pontual**: `reembedEntity(env, id)` já existe (`src/index.ts:617-625`) e é usado pelo cron de manutenção.

## Problema / Motivação

**Import errado é permanente.** Nenhum caminho (REST, MCP, Console) deleta entidade, connection ou event, e duplicata de pessoa não tem merge:

- `src/index.ts:696-731` — o router só aceita `GET` e `POST`; qualquer `DELETE` cai no `err(404, "route not found")` da linha 731.
- `mcp/index.js:167-193` — o `switch` de `handleTool` não tem nenhum caso destrutivo.
- A base tem milhares de **imports crus** (entidades cujo `name` é só o número de telefone) — tanto que `handleRecall` e `handleListEntities` os ESCONDEM por padrão via `include_raw` (`src/index.ts:341-342` e `src/index.ts:523-525`, filtro `hasLetter` / `GLOB '*[A-Za-z]*'`). Esconder não cura: eles continuam poluindo o Vectorize, o `/graph/data` e qualquer dedupe por telefone.
- Duplicata de pessoa (mesmo humano com 2 ids — ex.: um import cru por telefone + um registro manual com nome) não tem NENHUM caminho de consolidação: `save_person` só faz upsert por `phone` ou `id` (`src/index.ts:217-227`), nunca funde dois ids.
- Consequência extra: mesmo que se deletasse a linha no D1 na mão, o **vetor órfão** ficaria no Vectorize (nenhum `deleteByIds` no código) e continuaria aparecendo em `handleRecall` como match sem hydrate — a query semântica retornaria menos resultados que o `topK` pedido.

Com ~5,7 mil imports crus, isso bloqueia qualquer curadoria real do vault de contatos.

## Objetivo

Qualquer entidade, connection ou duplicata do expert-contacts pode ser removida ou fundida por REST e por MCP, sem deixar órfão em D1, Vectorize ou R2, com confirmação obrigatória e relatório do que foi feito.

## Design proposto

Nenhuma migration é necessária — o schema já suporta tudo (CASCADE existente). Todo o trabalho é em código do Worker + MCP + testes.

### 1. `DELETE /entities/:id` (com confirm obrigatório)

Novo handler `handleDeleteEntity(id, url, env)` em `src/index.ts`, registrado no router junto do match existente de `/entities/:id` (`src/index.ts:724-725`), aceitando também o alias `/people/:id`:

```ts
const entMatch = path.match(/^\/(?:entities|people)\/([0-9a-f-]+)$/i);
if (method === "GET" && entMatch) return await handleGetEntity(entMatch[1], env);
if (method === "DELETE" && entMatch) return await handleDeleteEntity(entMatch[1], url, env);
```

Passos do handler:

1. **Confirm obrigatório**: exigir `?confirm=true` na query string. Sem ele → `err(400, "confirm=true required (operação destrutiva e irreversível)")`. (Query param, não body: método `DELETE` com body é mal suportado por proxies/clients.)
2. **Carregar a entidade** (`SELECT * FROM entities WHERE id = ?`); 404 se não existe. Guardar `name`/`kind` pro relatório.
3. **Coletar os `r2_key` da mídia** da entidade ANTES do delete: `SELECT DISTINCT r2_key FROM media WHERE entity_id = ?`.
4. **Deletar a linha**: `DELETE FROM entities WHERE id = ?`. O `ON DELETE CASCADE` do schema (`migrations/0002_entities.sql:28-29,47,63`) limpa `connections`, `events` e `media` automaticamente. Contar antes (`SELECT COUNT(*)`) pra reportar quantas linhas caíram.
5. **Limpar o vetor**: `await env.VECTORIZE.deleteByIds([id])` (guardado por `if (env.VECTORIZE)`, com try/catch e log de erro — mesmo padrão de `upsertVectorize`, `src/index.ts:134-141`; falha no Vectorize NÃO desfaz o delete do D1, só entra no relatório).
6. **Limpar blobs R2 quando o refcount zerar**: para cada `r2_key` coletado no passo 3, rodar `SELECT COUNT(*) AS n FROM media WHERE r2_key = ?` (já pós-cascade). Se `n = 0` e `env.MEDIA` existe → `await env.MEDIA.delete(r2_key)`. Se `n > 0`, outro contato ainda referencia o blob (dedupe por hash) — não deletar.
7. **Auditoria mínima**: `console.log("[destructive]", JSON.stringify({ op: "delete_entity", id, kind, name, connections_deleted, events_deleted, media_deleted, r2_deleted, ts: new Date().toISOString() }))` — visível no observability do Worker (habilitado no `wrangler.toml`).
8. **Resposta**: `{ ok: true, deleted: { id, kind, name }, cascade: { connections, events, media }, vectorize_deleted, r2_blobs_deleted }`.

Auth: nenhuma mudança em `requireAuth` — `DELETE` não é `GET`, então o `CONTACTS_PROXY_TOKEN` (read-only, `src/index.ts:76`) já não passa; só `OWNER_TOKEN` autoriza. Cobrir isso com teste.

### 2. `DELETE /connections/:id` (com confirm obrigatório)

Novo handler `handleDeleteConnection(id, url, env)`:

```ts
const connMatch = path.match(/^\/connections\/([0-9a-f-]+)$/i);
if (method === "DELETE" && connMatch) return await handleDeleteConnection(connMatch[1], url, env);
```

1. Exigir `?confirm=true` (mesma mensagem de erro do item 1).
2. `SELECT * FROM connections WHERE id = ?`; 404 se não existe.
3. `DELETE FROM connections WHERE id = ?`. Sem cascade envolvido, sem vetor (connections não têm embedding).
4. Log estruturado `[destructive]` com `op: "delete_connection"`, `id`, `a_id`, `b_id`, `type`, `ts`.
5. Resposta: `{ ok: true, deleted: { id, a_id, b_id, type } }`.

### 3. `POST /entities/merge` — fusão de duplicatas

Novo handler `handleMergeEntities(req, env)`, rota `POST /entities/merge`, body `{ winner_id, loser_id, confirm: true }`:

1. **Validações**: `confirm === true` no body senão 400; `winner_id !== loser_id` senão 400; ambos existem senão 404; se `winner.kind !== loser.kind` → `err(400, "kinds diferem (person vs company); merge só entre entidades do mesmo kind")`.
2. **Mover connections do perdedor** (re-apontando e deduplicando contra o `UNIQUE(a_id, b_id, type)` de `migrations/0002_entities.sql:34`). Para cada linha de `SELECT * FROM connections WHERE a_id = ? OR b_id = ?` (loser):
   - Calcular o par re-apontado (`a_id`/`b_id` com loser→winner).
   - Se virar self-loop (`a_id === b_id`, i.e. aresta winner↔loser) → `DELETE` da aresta, contar em `connections_dropped_selfloop`.
   - Senão, checar duplicata: `SELECT id FROM connections WHERE a_id = ? AND b_id = ? AND type = ?` com o par novo. Existe → `DELETE` da aresta do loser, contar em `connections_deduped`. Não existe → `UPDATE connections SET a_id = ?, b_id = ? WHERE id = ?`, contar em `connections_moved`.
   - (Checar-antes-de-atualizar em vez de capturar o erro de UNIQUE: mesmo racional do `handleConnect`, mas sem depender de parse de mensagem de erro em loop.)
3. **Mover events**: `UPDATE events SET entity_id = ? WHERE entity_id = ?` (winner, loser). Reportar `events_moved` via `meta.changes`.
4. **Mover media**: `UPDATE media SET entity_id = ? WHERE entity_id = ?`. Blobs R2 não mudam (mesmo `content_hash`/`r2_key`) — nada a limpar em R2 no merge, o refcount só muda de dono.
5. **Preencher campos vazios do vencedor com os do perdedor** (COALESCE — vencedor SEMPRE prevalece quando tem valor):
   ```sql
   UPDATE entities SET
     phone          = COALESCE(phone, ?),
     email          = COALESCE(email, ?),
     role           = COALESCE(role, ?),
     company        = COALESCE(company, ?),
     website        = COALESCE(website, ?),
     sector         = COALESCE(sector, ?),
     birthday       = COALESCE(birthday, ?),
     last_contacted = COALESCE(last_contacted, ?),
     notes_text     = COALESCE(notes_text, ?),
     attributes     = COALESCE(attributes, ?),
     category       = COALESCE(category, ?),
     avatar_r2_key  = COALESCE(avatar_r2_key, ?)
   WHERE id = ?
   ```
   Binds = os valores correspondentes do loser + `winner_id`. Reportar em `fields_filled` a lista dos campos que estavam NULL no winner e não-NULL no loser. `name` NUNCA é tocado (o vencedor foi escolhido justamente pelo nome bom). Exceção `last_contacted`: usar `MAX(...)` dos dois em vez de COALESCE simples (o mais recente é o correto): `last_contacted = CASE WHEN last_contacted IS NULL THEN ? WHEN ? IS NULL THEN last_contacted ELSE MAX(last_contacted, ?) END`.
   - **Ordem importa**: o `UPDATE ... SET phone` do winner acontece DEPOIS de deletar o loser (passo 6) OU o loser tem o phone anulado antes — porque `entities.phone` pode ter índice/expectativa de unicidade lógica (dedupe por telefone no `save_person`, `src/index.ts:221`). Implementar como: (a) capturar os valores do loser em memória, (b) deletar o loser, (c) rodar o UPDATE do winner. D1 não tem transação multi-statement no binding — usar `env.DB.batch([...])` pra agrupar os statements de escrita dos passos 2-6 no que for possível e minimizar janela de inconsistência.
6. **Deletar o perdedor + vetor**: `DELETE FROM entities WHERE id = loser_id` (cascade já não tem mais nada pra limpar — tudo foi movido) e `env.VECTORIZE.deleteByIds([loser_id])`.
7. **Re-embedar o vencedor**: chamar `reembedEntity(env, winner_id)` (`src/index.ts:617`) — os campos preenchidos no passo 5 podem mudar o texto do embedding.
8. **Auditoria**: log `[destructive]` com `op: "merge_entities"`, ids, nome dos dois, contadores; e registrar um event no vencedor: `INSERT INTO events (id, entity_id, kind, context, source) VALUES (?, ?, 'merged_from', 'merged loser <loser_id> ("<loser_name>")', 'merge')` — trilha permanente consultável via `GET /entities/:id`.
9. **Resposta — relatório do que moveu**:
   ```json
   {
     "ok": true,
     "winner_id": "...", "loser_id": "...",
     "report": {
       "connections_moved": 3, "connections_deduped": 1, "connections_dropped_selfloop": 0,
       "events_moved": 12, "media_moved": 2,
       "fields_filled": ["email", "company"],
       "vectorize": { "loser_deleted": true, "winner_reembedded": true }
     }
   }
   ```

### 4. MCP standalone — novas tools (`mcp/index.js`)

Adicionar ao array `TOOLS` e ao `switch` de `handleTool`:

- **`delete_entity`** — `{ id: string, confirm: boolean }`, ambos required. Description deixando explícito: "DESTRUTIVO e IRREVERSÍVEL (hard delete). Remove a entidade + todas as conexões, eventos e mídia dela. Exige confirm:true — PERGUNTE ao usuário antes." Handler: `callWorker("DELETE", \`/entities/${encodeURIComponent(args.id)}?confirm=${args.confirm === true}\`)`.
- **`delete_connection`** — `{ id: string, confirm: boolean }`, required. Handler: `callWorker("DELETE", \`/connections/${encodeURIComponent(args.id)}?confirm=${args.confirm === true}\`)`.
- **`merge_entities`** — `{ winner_id: string, loser_id: string, confirm: boolean }`, required. Description: "Funde duplicatas: move conexões/eventos/mídia do perdedor pro vencedor, preenche campos vazios do vencedor e DELETA o perdedor. Irreversível. Exige confirm:true." Handler: `callWorker("POST", "/entities/merge", args)`.

O `callWorker` (`mcp/index.js:28-40`) já suporta método arbitrário — nenhuma mudança de infraestrutura. Bumpar a versão do server (`mcp/index.js:196`) e o comentário de header.

### 5. Console (opcional nesta spec)

Ação "Deletar" e "Mesclar com..." no painel de detalhe da entidade (`src/web/detail.ts`), chamando as rotas novas com modal de confirmação dupla (digitar o nome da entidade). Pode ser entregue em PR separado sem bloquear os itens 1-4.

### Decisão registrada: delete é HARD

Delete de contacts é hard delete (sem lixeira/undelete), diferente do Brain (que tem `restore_note`). Racional: o vault de contacts é majoritariamente derivado de fontes re-importáveis (WhatsApp, Pipedrive) — o custo de re-importar é menor que o custo de carregar soft-delete em todas as queries. Se o dono pedir reversibilidade, portar o soft-delete do Brain em spec futura. Documentar isso no header do `src/index.ts` e nas descriptions das tools MCP.

### Gate operacional (obrigatório antes do primeiro uso em produção)

1. Suíte de testes da spec `40-ops/42-contacts-testes-typecheck-ci.md` rodando verde — operações destrutivas não entram sem teste.
2. **Backup do D1** (export completo) antes do primeiro delete/merge em produção, com OK do dono:
   ```sh
   npx wrangler d1 export expert-contacts-db --remote --output=backup-pre-delete-$(date +%Y%m%d).sql
   ```

## Fora de escopo

- **Detecção automática de duplicatas** (batch): a spec `10-backend/19` já previne novas duplicatas no write path; detecção em massa nas existentes é curadoria com script fora do Worker (usa `get_contact_by_phone` + `merge_entities` desta spec como primitivas).
- **Undelete / soft-delete / lixeira**: decisão acima — delete é hard. Reversibilidade, se pedida, é spec futura portando o modelo do Brain.
- **Delete de event individual** (`DELETE /events/:id`): baixo valor de curadoria; events somem junto com a entidade. Adicionar depois se surgir demanda.
- **UI de merge no Console** além da ação básica (comparação lado-a-lado, preview de campos): entrega mínima é o botão; o resto é iteração.
- **Merge cross-kind** (person ↔ company): bloqueado por validação; não implementar coerção.

## Critérios de aceite

- [ ] `DELETE /entities/:id` sem `confirm=true` retorna 400 e NÃO deleta nada.
- [ ] `DELETE /entities/:id?confirm=true` remove a entidade e (via CASCADE) todas as suas linhas em `connections`, `events` e `media`; resposta traz os contadores.
- [ ] Após o delete, `env.VECTORIZE.deleteByIds` foi chamado com o id — não sobra vetor órfão (verificável: `recall` da entidade deletada não a retorna).
- [ ] Blob R2 é deletado SOMENTE quando nenhuma outra linha de `media` referencia o mesmo `r2_key`; blob compartilhado por outra entidade sobrevive.
- [ ] `DELETE /connections/:id?confirm=true` remove só a aresta; as duas entidades ficam intactas.
- [ ] Requisições `DELETE` com `CONTACTS_PROXY_TOKEN` (read-only) retornam 401.
- [ ] `POST /entities/merge` sem `confirm: true` retorna 400; com `winner_id === loser_id` retorna 400; com kinds diferentes retorna 400; com id inexistente retorna 404.
- [ ] Merge move todas as connections do loser pro winner; aresta que viraria duplicata (`UNIQUE(a_id,b_id,type)`) é descartada e contada em `connections_deduped`; aresta winner↔loser vira `connections_dropped_selfloop` (nunca cria self-loop).
- [ ] Merge move todos os `events` e `media` do loser pro winner.
- [ ] Campos NULL do winner são preenchidos com os do loser; campos JÁ preenchidos do winner NUNCA são sobrescritos; `name` do winner nunca muda.
- [ ] Após o merge, o loser não existe mais no D1 nem no Vectorize, e o winner foi re-embedado.
- [ ] O winner ganha um event `merged_from` com o id do loser no contexto.
- [ ] MCP: `delete_entity`, `delete_connection` e `merge_entities` aparecem no `list_tools`, exigem `confirm` no schema (required) e repassam corretamente pro Worker.
- [ ] Toda operação destrutiva emite log estruturado `[destructive]` com op, ids e timestamp.
- [ ] Nenhuma migration nova; nenhum dado existente é alterado por deploy (as rotas novas só agem quando chamadas).

## Validação

```sh
# typecheck (repo não tem script dedicado — usar tsc direto)
cd C:/repos/expert-contacts && npx tsc --noEmit

# testes (suíte da spec 40-ops/42; os casos desta spec entram lá)
npx vitest run

# teste manual em dev local (wrangler dev + D1 local)
npx wrangler dev
# 1. criar 2 pessoas de teste via POST /save_person (uma com email, outra sem)
# 2. conectar as duas via POST /connect
# 3. POST /entities/merge {winner_id, loser_id, confirm:true} → conferir report
# 4. GET /entities/:winner → events/conexões movidos, campos preenchidos, event merged_from
# 5. DELETE /entities/:winner?confirm=true → conferir cascade no report
# 6. GET /entities/:winner → 404
```

Deploy (`npm run deploy`) SÓ com OK do dono, e SÓ depois do gate: suíte 40-ops/42 verde + backup do D1 exportado (`wrangler d1 export ... --remote`).

## Arquivos afetados

- `src/index.ts` — handlers `handleDeleteEntity`, `handleDeleteConnection`, `handleMergeEntities`; 3 entradas novas no router; atualização do comentário de rotas no header.
- `mcp/index.js` — tools `delete_entity`, `delete_connection`, `merge_entities` (TOOLS + handleTool); bump de versão.
- `src/web/detail.ts` (+ `src/web/client/` se houver JS de cliente) — ação de delete/merge no painel de detalhe do Console (opcional nesta spec).
- `test/` (novo) — casos de delete (confirm, cascade, refcount R2, auth) e merge (dedupe UNIQUE, self-loop, COALESCE, name intocado), na infra da spec 40-ops/42.

## Riscos e reversão

- **Risco principal: operação é irreversível por design** (hard delete). Mitigações em camadas: `confirm` obrigatório em todos os caminhos; `CONTACTS_PROXY_TOKEN` bloqueado; descriptions MCP mandando o agente perguntar ao usuário; log `[destructive]` auditável; backup do D1 antes do primeiro uso em produção. Rollback de um delete/merge errado = restaurar do export (`wrangler d1 export` → re-import) ou re-importar a entidade da fonte (WhatsApp/Pipedrive) + `POST /setup/reembed`.
- **Merge deixando estado parcial** (Worker morre no meio; D1 sem transação multi-request): mitigar com `env.DB.batch()` agrupando as escritas e com ordem segura (mover dependentes ANTES de deletar o loser). Pior caso residual: loser vazio ainda existe → rodar o merge de novo é idempotente (0 linhas pra mover, COALESCE não muda nada, delete final completa).
- **Vetor órfão se `deleteByIds` falhar** (D1 deletado, Vectorize não): o handler reporta a falha no response; correção é re-chamar o delete do vetor (expor no relatório o id pra retry manual) — e o hydrate do `handleRecall` já descarta matches sem linha no D1 (`src/index.ts:364-368`), então o impacto é só um slot desperdiçado no topK.
- **Deletar blob R2 ainda referenciado**: prevenido pelo refcount por `r2_key` pós-cascade; coberto por teste com blob compartilhado entre 2 entidades.
- **Reversão do código**: as mudanças são puramente aditivas (rotas e tools novas, zero migration) — rollback = `git revert` do PR + `npm run deploy`. Nenhum dado existente é tocado pelo deploy em si.
