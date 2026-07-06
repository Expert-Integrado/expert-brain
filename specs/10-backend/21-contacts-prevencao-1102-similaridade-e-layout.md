# Contacts: portar as defesas do incidente 1102 (similar_edges pré-computadas, guard de escala, connections sem full-scan)

> **Status:** done · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-contacts
> **Depende de:** `20-frontend/22-grafo-seed-clusterizado-e-layout-persistente.md` (implementação de referência do seed clusterizado no Brain) · `40-ops/44-contacts-migrations-tracking.md` (trilho de migrations do contacts)

> **Execução (05/07/2026):** implementada em `expert-contacts` na branch `feat/console-v2` (commit `fceecf3`). `tsc --noEmit` limpo; `vitest run` 145/145 verde (20 casos novos: `test/similar-edges.test.ts`, `test/layout.test.ts`, `test/contacts-graph-similar.test.ts`).
> Desvios do texto original (o repo evoluiu depois da spec ser escrita):
> - **Migration renumerada `0004`→`0005_similar_edges`** — a `0004_media_dedup_index` já ocupou o número. Aplicada a regra transversal do `90-roadmap.md`: schema real vive em `src/db/migrate.ts` (trilho da `40-ops/44`), não mais em `wrangler d1 migrations apply`; o `.sql` em `migrations/` é só espelho documental.
> - **`src/entity-write.ts` (`reembedEntity`) passou a retornar `{ action, vector }`** (era só a string). O write path precisa do vetor RECÉM-computado pra `refreshSimilarEdges` — `getByIds` logo após o `upsert` é eventual-consistent (o vetor novo pode não voltar ainda). O caminho de edição do Console (`src/web/entity-update.ts`) também refresca as similar edges, por consistência (mesmo intent de "após cada upsertVectorize").
> - **`loadConnectionsBetween` exportada** (era interna) pra teste unitário direto.
> - Gate **G5-C0 NÃO fechado**: exige validação manual do dono (grafo com arestas semânticas sem query Vectorize no load) + `provision`/`backfill-similar`/deploy em produção — nada disso feito nesta sessão (sem OK do dono).

## Contexto

O **expert-contacts** é um Worker Cloudflare (D1 + Vectorize + Workers AI bge-m3 + R2) que co-hospeda o Expert Console (front multi-vault) sob `/app*`. O adapter do vault de contatos (`src/vaults/contacts.ts`) monta o grafo de entidades (pessoas/empresas + connections) no mesmo shape do Expert Brain.

O grafo do **Expert Brain** já sofreu e já CORRIGIU exatamente o problema que o contacts carrega hoje — o "incidente 1102" (Worker exceeded resource limits, Error 1102):

1. **Similaridade ao vivo** — o Brain computava as arestas de similaridade no load do grafo com 1 query Vectorize POR nota; acima de ~950 notas estourava o cap de subrequests do Cloudflare (50 free / 1000 paid). A correção foi a **migration `0005_similar_edges`** (tabela pré-computada, `src/db/migrate.ts:116-125` do repo expert-brain) + **`refreshSimilarEdges`** no write path (`src/web/similarity.ts:17-28` do expert-brain) + **backfill resumível por cursor** (`src/auth/setup.ts:86-136` do expert-brain). O grafo passou a só LER do D1 — zero Vectorize por load.
2. **forceAtlas2 sem teto** — quando o vault cresceu (~1800+ nós), o FA2 server-side de 150 iterações estourava o CPU do Worker a cada invalidação de cache. A correção foi o **guard de escala** `FA2_MAX_NODES = 900` (`src/web/layout.ts:24-40` do expert-brain): acima do teto, pula o FA2 e devolve seed determinístico espalhado O(n); o refino fica pro client.

O contacts foi criado como PORTA do código do Brain, mas foi portado **da versão anterior às correções**:

- `src/web/similarity.ts` (contacts) — cópia do loop antigo: 1 `env.VECTORIZE.query` por nó.
- `src/web/layout.ts` (contacts) — cópia do `computeLayout` SEM o guard `FA2_MAX_NODES` (só o `computeLayoutScaled`, usado exclusivamente pelo modo `?all=`, tem mitigação parcial).
- `src/vaults/contacts.ts` — `loadConnectionsBetween` faz `SELECT ... FROM connections LIMIT 8000` e filtra em JS, ignorando os índices `idx_conn_a`/`idx_conn_b` que já existem (`migrations/0002_entities.sql:40-41`).

A base já tem ~6,7k entidades (comentário em `src/vaults/contacts.ts:114-115`); o núcleo conectado ainda é pequeno, mas o import de grupos de WhatsApp (fora desta spec) vai inflá-lo. Esta spec desarma a bomba ANTES do gatilho de escala.

Migrations do contacts vivem em `migrations/*.sql` aplicadas via `wrangler d1 migrations apply` (`wrangler.toml` → `migrations_dir = "migrations"`; trilho formalizado na spec `40-ops/44`). Existem hoje `0001` a `0003` — a próxima é `0004`. **[Execução:** a `40-ops/44` migrou o trilho pro array `MIGRATIONS` em `src/db/migrate.ts` e a `0004` virou `0004_media_dedup_index`; esta spec entrou como **`0005_similar_edges`** — todos os números `0004` abaixo leem-se `0005`.**]**

## Problema / Motivação

Três defeitos concretos, todos com contraparte já corrigida no Brain:

1. **1 query Vectorize por nó no load do grafo** — `src/web/similarity.ts:29-41` (contacts): `computeSimilarityEdges` itera `nodeVectors` e chama `env.VECTORIZE.query` dentro do loop. É chamado por `assemblePayload` (`src/vaults/contacts.ts:248-251`) em TODOS os modos exceto `?all=` (que usa `skipSimilarity`, `src/vaults/contacts.ts:413-417`). O modo default (`fetchConnectedSubgraph`, `src/vaults/contacts.ts:323-330`) computa similaridade pra todo o núcleo conectado: quando ele passar de ~900 nós, o load do grafo estoura o cap de 1000 subrequests e o Console PARA de carregar — reprodução exata do incidente do Brain. Além do risco de quebra, é o que deixa o load lento e caro HOJE (N queries Vectorize a cada MISS de cache).
2. **forceAtlas2 incondicional** — `src/web/layout.ts:52-77` (contacts): `computeLayout` roda FA2 150 iterações sem teto de nós. Os modos default (`fetchConnectedSubgraph`), `?q=` e `?focus=` chamam `computeLayout` direto (`src/vaults/contacts.ts:272-274`, `lightLayout` só no `?all=`). Núcleo conectado grande = Error 1102 por CPU, a cada escrita que invalida o cache (o `sourceHash` muda em qualquer `save_person`/`connect` — `src/vaults/contacts.ts:185-193`). Além disso, o seed é hash puro do id (`seededPosition`, `src/web/layout.ts:16-27`) — ruído uniforme sem estrutura, o que a spec `20-frontend/22` substitui por seed clusterizado no Brain.
3. **Full-scan de connections com truncamento silencioso** — `src/vaults/contacts.ts:140-146`: `loadConnectionsBetween` faz `SELECT ... FROM connections LIMIT ${MAX_EDGES}` (8000) **sem WHERE e sem ORDER BY** e filtra os dois extremos em JS. Acima de 8k arestas, o subconjunto retornado é arbitrário (ordem física do SQLite) e o corte é silencioso: arestas somem do grafo sem log nem aviso. O mesmo padrão `LIMIT ${MAX_EDGES}` sem aviso se repete em `fetchConnectedSubgraph` (`:324-326`), `fetchNeighborhood` (`:367-369`) e `fetchAll` (`:408-410`).

## Objetivo

O load do grafo do Console de contatos executa **zero queries Vectorize** e **zero forceAtlas2 acima de 900 nós**, e nenhuma leitura de `connections` trunca silenciosamente — mantendo o payload visual dos modos existentes inalterado (exceto o seed de layout).

## Design proposto

### Parte 1 — `similar_edges` pré-computadas (porta da migration 0005 + `refreshSimilarEdges` do Brain)

**1a. Migration aditiva `migrations/0005_similar_edges.sql`** (número 0004→0005: ver nota de execução no topo; a DDL entra no array `MIGRATIONS` de `src/db/migrate.ts`, com espelho `.sql`; NUNCA alterar migrations já aplicadas):

```sql
-- 0004 — similar edges PRÉ-COMPUTADAS (porta da 0005_similar_edges do Expert Brain).
-- O grafo deixava de carregar acima de ~900 nós conectados porque o load computava
-- similaridade ao vivo: 1 query Vectorize POR nó (loop em src/web/similarity.ts)
-- estourava o cap de subrequests do Cloudflare. Agora cada entidade grava seus
-- top-k vizinhos no write path (save_person/save_company/save_entity/reembed) e o
-- grafo só LÊ desta tabela.
CREATE TABLE IF NOT EXISTS similar_edges (
  from_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  score    REAL NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_similar_from ON similar_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_similar_to   ON similar_edges(to_id);
```

Aplicar via o trilho da spec `40-ops/44` (`wrangler d1 migrations apply` — local primeiro, remoto só com OK do dono).

**1b. Reescrever `src/web/similarity.ts` (contacts)** no molde do `src/web/similarity.ts` do expert-brain:

- Mover pra cá as constantes `SIMILARITY_TOP_K = 4` e `SIMILARITY_MIN_SCORE = 0.5` (hoje em `src/vaults/contacts.ts:32-33`) — fonte única usada pela escrita e pelo backfill.
- Nova função `refreshSimilarEdges(env, entityId, vector, opts?)`: 1 `env.VECTORIZE.query(vector, { topK: opts.topK + 1, returnMetadata: 'none' })` (o `+1` porque o próprio nó volta como vizinho mais próximo), filtra `id !== entityId && score >= minScore`, `slice(0, topK)`, e persiste com `replaceSimilarEdges`.
- Nova função `replaceSimilarEdges(env, fromId, neighbors)`: `DELETE FROM similar_edges WHERE from_id = ?` + `INSERT OR IGNORE` dos vizinhos num ÚNICO `env.DB.batch` (1 subrequest D1, transacional — igual `src/db/queries.ts:71-81` do expert-brain).
- Nova função `getAllSimilarEdges(env)`: `SELECT from_id, to_id, score FROM similar_edges` (dedup de pares simétricos/explícitos fica no read path, que já tem os sets em mãos).
- Manter `explicitPairKey` como está. **Apagar** `computeSimilarityEdges` (o loop) quando nenhum caller restar.

**1c. Write path (`src/index.ts`)** — chamar `refreshSimilarEdges` logo após cada `upsertVectorize`, SEMPRE em `try/catch` não-fatal (se falhar, a entidade salva mesmo assim e o backfill/próximo edit corrige):

- `handleSaveEntity` — após o upsert do vetor em `src/index.ts:270`.
- `reembedEntity` — após o upsert em `src/index.ts:624`.
- `handleReembedAll` (`src/index.ts:577-607`) — após cada batch de upsert; atenção ao orçamento de subrequests por invocação (mesma conta do backfill abaixo).

**1d. Backfill resumível `POST /setup/backfill-similar`** (novo handler em `src/index.ts`, rota junto das demais `/setup/*` em `src/index.ts:698-717`) — porta de `handleBackfillSimilar` do expert-brain (`src/auth/setup.ts:86-136`):

- Cursor por id: `?after=<último id processado>`, `SELECT id FROM entities WHERE id > ? ORDER BY id LIMIT ?` (PK estável e resumível).
- `limit` teto-clampeado em **20**. Orçamento por lote: 1× `getByIds` + N×(1 query Vectorize + 1 batch D1) = 1 + 2N ≤ 41 subrequests — cabe com folga até no free tier. NÃO relaxar o teto sem refazer essa conta.
- `try/catch` por entidade DENTRO do loop (vetor órfão no Vectorize apontando pra entidade deletada violaria a FK e abortaria o batch): conta `failed` e segue, senão o cursor nunca avança e o backfill trava pra sempre.
- Resposta `{ done, processed, edges, missing, failed, cursor }`; cliente chama em loop até `done: true`. Idempotente (`replaceSimilarEdges` sobrescreve). Auth: mesmo Bearer `OWNER_TOKEN` das demais rotas.
- **Gate: rodar o backfill em produção SÓ com OK explícito do dono (custa quota Vectorize/Workers AI).**

**1e. Read path (`src/vaults/contacts.ts`)**:

- Em `assemblePayload` (`:244-258`): substituir `loadNodeVectors` + `computeSimilarityEdges` por `getAllSimilarEdges(env)` (1 query D1), seguido dos MESMOS filtros de hoje: ambos os extremos em `aliveIds`, dedup de par simétrico via `explicitPairKey`, descarte de pares já explícitos. `loadNodeVectors` (`:149-166`) perde o último caller — remover.
- Manter a flag `skipSimilarity` e o comportamento do modo `?all=` (payload idêntico ao atual — sem arestas de similaridade). Ligar similaridade no `?all=` é decisão visual, fora de escopo.
- **`contactsSourceHash` (`:185-193`) passa a incluir `similar_edges`** — acrescentar `SELECT COUNT(*) c, COALESCE(SUM(score), 0) s FROM similar_edges` ao hash (igual `src/web/graph-data.ts:48-57` do expert-brain; o `SUM(score)` detecta mudança de CONTEÚDO com mesma cardinalidade). Sem isso, backfill/reembed não invalidam o cache do grafo e o Console serve payload stale.

### Parte 2 — guard de escala + seed clusterizado em `src/web/layout.ts` (contacts)

- Portar o guard do expert-brain (`src/web/layout.ts:33-40`) pro TOPO do `computeLayout` do contacts (`src/web/layout.ts:52`):

```ts
const FA2_MAX_NODES = 900;
if (nodes.length > FA2_MAX_NODES) {
  const spread = 40 * Math.sqrt(nodes.length);
  return nodes.map((n) => { /* seed determinístico * spread — SEM forceAtlas2 */ });
}
```

  Como `computeLayoutScaled` delega o núcleo pro `computeLayout` (`src/web/layout.ts:38`), o guard protege TODOS os modos automaticamente.
- Substituir o seed hash puro (`seededPosition`, `src/web/layout.ts:16-27`) pelo **seed clusterizado por kind/category**: mesma implementação da spec `20-frontend/22` (âncora angular determinística por cluster + jitter determinístico por id dentro do setor do cluster), PORTADA — não reimplementada de cabeça. Requer estender `LayoutNode` com campo opcional `cluster?: string`; em `src/vaults/contacts.ts:267`, popular com `e.kind` (fallback `'other'`). Nó sem cluster cai no comportamento atual (hash puro). **Gate: só implementar depois que a `20-frontend/22` estiver merged no Brain — copiar de lá a função de referência.**

### Parte 3 — `loadConnectionsBetween` sem full-scan + cap unificado com warning

- Reescrever `loadConnectionsBetween` (`src/vaults/contacts.ts:140-146`): chunks de até 100 ids (mesmo padrão de `loadEntities`, `:124-137`) com `WHERE a_id IN (${ph})` — usa `idx_conn_a` — e **pós-filtro em JS** do outro extremo (`ids.has(c.b_id)`). Como toda aresta do resultado precisa ter os DOIS extremos no set, buscar só por `a_id` já cobre tudo (não precisa da query espelho por `b_id`). Dedup por `c.id` desnecessário (cada linha aparece 1x).
- Unificar o teto: manter `MAX_EDGES = 8000` como constante única em `src/vaults/contacts.ts:36` e criar um helper `warnIfTruncated(rows, ctx)` que loga `console.warn` quando `rows.length === MAX_EDGES` — aplicar nos 3 pontos que continuam com `LIMIT ${MAX_EDGES}` legitimamente (precisam do conjunto global): `fetchConnectedSubgraph` (`:324-326`), `fetchNeighborhood` (`:367-369`) e `fetchAll` (`:408-410`). Truncar continua possível, mas nunca mais SILENCIOSO.

### Parte 4 — testes (`test/`, novo)

O repo não tem testes nem vitest. Adicionar `vitest` (+ `@cloudflare/vitest-pool-workers` se for testar contra D1 real; senão, testes puros com mocks de `env.DB`/`env.VECTORIZE`, como preferir o executor — o Brain usa vitest e serve de referência de setup). Cobrir no mínimo:

- `refreshSimilarEdges`: exclui o próprio nó, respeita `minScore`, respeita `topK`, grava via batch único, `neighbors = []` limpa as edges antigas.
- `assemblePayload`/read: par simétrico deduplicado, par com edge explícita descartado, extremo fora de `aliveIds` descartado.
- `computeLayout`: > 900 nós NÃO invoca forceAtlas2 (retorna seed espalhado determinístico); ≤ 900 mantém o caminho atual; mesmo input → mesmo output.
- `loadConnectionsBetween`: com > 100 ids faz chunking; só retorna arestas com os dois extremos no set.
- `contactsSourceHash`: muda quando `similar_edges` muda (inclusive mesmo COUNT com score diferente).

Script `"test": "vitest run"` no `package.json`; se possível, `"typecheck": "tsc --noEmit"` também.

**Migrations sempre aditivas — nada nesta spec altera ou apaga dados existentes.** A tabela nova nasce vazia; o read path degrada gracioso (sem linhas em `similar_edges` = grafo sem arestas de similaridade até o backfill rodar, nunca erro).

## Fora de escopo

- Import de grupos de WhatsApp (é o gatilho de escala que motiva a spec, não parte dela).
- Qualquer mudança visual do Console além do seed de layout (cores, legenda, painel, similaridade no modo `?all=`).
- Persistência de layout no client (WS da spec `20-frontend/22`, lado Brain).
- Mudar `SIMILARITY_TOP_K`/`SIMILARITY_MIN_SCORE` ou a fórmula de tamanho de nó.
- Refatorar `brain.ts` (`src/vaults/brain.ts`) — o adapter do vault Brain já lê do serviço remoto correto.
- Sistema de tracking de migrations em si (spec `40-ops/44`).

## Critérios de aceite

- [x] `migrations/0005_similar_edges.sql` existe (espelho documental) + entrada `0005_similar_edges` no array `MIGRATIONS` de `src/db/migrate.ts`, puramente aditiva e aplica limpa (validado no D1 in-memory dos testes com 0001-0004 já aplicadas).
- [x] `grep -rn "VECTORIZE.query" src/vaults src/web` não mostra NENHUMA chamada dentro de loop por nó no caminho de leitura do grafo (`computeSimilarityEdges` removida; restam só a do `?q=` — 1 por request — e a de `refreshSimilarEdges`, que é do WRITE path, não do load).
- [x] `save_person`, `save_company`, `save_entity` e `reembed` gravam/atualizam linhas em `similar_edges`, e uma falha nessa etapa NÃO falha o save (try/catch não-fatal no write path; write path também no Console `entity-update.ts`).
- [x] `POST /setup/backfill-similar` processa em lotes ≤ 20, retorna cursor, é resumível (idempotente via `replaceSimilarEdges`) e não trava em entidade com vetor órfão (try/catch por entidade conta `failed` e avança o cursor).
- [x] Modo default (`fetchConnectedSubgraph`) retorna arestas `type: 'similar'` lidas do D1, com dedup simétrico e sem pares que já têm edge explícita (testado em `test/contacts-graph-similar.test.ts`).
- [x] Payload do modo `?all=true` permanece sem arestas de similaridade (comportamento atual preservado; testado).
- [x] `contactsSourceHash` muda após backfill/reembed — inclusive mesmo COUNT com score diferente (COUNT+SUM(score); testado).
- [x] `computeLayout` com 901+ nós retorna sem executar forceAtlas2 (retorna exatamente `clusteredSeed`); com ≤ 900 executa como hoje (testado).
- [x] Seed de posição usa âncora por cluster (kind) portada de `20-frontend/22` (merged no Brain), com jitter determinístico (mesmo grafo → mesmo layout; testado).
- [x] `loadConnectionsBetween` não contém `SELECT` sem `WHERE` sobre `connections`; usa `IN` chunked por `a_id` (testado com > 100 ids).
- [x] Os 3 `SELECT ... LIMIT ${MAX_EDGES}` restantes logam `console.warn` via `warnIfTruncated` quando o resultado atinge o teto.
- [x] `tsc --noEmit` limpo e `vitest run` verde (145/145) com os testes da Parte 4.
- [ ] **(gate G5-C0, PENDENTE — dono)** validação visual do grafo no vault real + `provision`/`backfill-similar`/deploy em produção (SÓ com OK do dono).

## Validação

```sh
# na raiz do repo expert-contacts
npx tsc --noEmit
npx vitest run

# migration local
npx wrangler d1 migrations apply expert-contacts --local

# smoke local
npx wrangler dev
# noutra shell:
curl -s -X POST http://localhost:8787/setup/backfill-similar?limit=5 -H "Authorization: Bearer $OWNER_TOKEN"
curl -s "http://localhost:8787/app/graph/data?vault=contacts" | head -c 2000  # arestas sim: presentes
```

Teste manual no Console: abrir `/app`, vault Contatos — modo default carrega com arestas de similaridade; `?all=` carrega igual a antes; busca (`?q=`) e foco (`?focus=`) funcionam.

**Deploy em produção (`npm run deploy`) e `wrangler d1 migrations apply` remoto SÓ com OK do dono. Backfill em produção SÓ com OK do dono (custa quota).**

## Arquivos afetados

- `src/web/similarity.ts` — reescrito: `refreshSimilarEdges` + `replaceSimilarEdges` + `getAllSimilarEdges`; remove `computeSimilarityEdges`
- `src/web/layout.ts` — guard `FA2_MAX_NODES` + seed clusterizado (`LayoutNode.cluster`)
- `src/vaults/contacts.ts` — read path lê `similar_edges`; `loadConnectionsBetween` chunked; `contactsSourceHash` inclui `similar_edges`; cap unificado + warning; remove `loadNodeVectors`
- `src/index.ts` — `refreshSimilarEdges` nos write paths (`handleSaveEntity`, `reembedEntity`, `handleReembedAll`) + handler/rota `POST /setup/backfill-similar`
- `migrations/0005_similar_edges.sql` (novo, espelho documental) + `src/db/migrate.ts` (entrada `0005_similar_edges` no array `MIGRATIONS`) + `test/apply-migrations.ts` (mirror)
- `src/entity-write.ts` — `reembedEntity` passou a retornar `{ action, vector }` (necessário pro write path refrescar as similar edges com o vetor recém-computado)
- `src/web/entity-update.ts` — write path do Console também refresca as similar edges
- `test/similar-edges.test.ts`, `test/layout.test.ts`, `test/contacts-graph-similar.test.ts` (novos; `package.json`/vitest já existiam da spec `40-ops/42`)

## Riscos e reversão

- **Risco: quota Vectorize no backfill/reembed em massa.** Mitigação: lote clampeado em 20 + gate de OK do dono. Reversão: parar de chamar o endpoint; nada fica em estado inconsistente (idempotente).
- **Risco: FK de `similar_edges` contra vetor órfão no Vectorize.** Mitigação: `try/catch` por entidade no backfill e no write path (falha contada, nunca propaga).
- **Risco: cache stale se `sourceHash` não cobrir `similar_edges`.** Mitigação: critério de aceite específico + teste.
- **Risco: seed clusterizado divergir do Brain.** Mitigação: gate na `20-frontend/22` merged; copiar a função, não reimplementar.
- **Rollback de código:** `git revert` do(s) commit(s) — o read path antigo volta a funcionar sem tocar no banco (a tabela `similar_edges` fica órfã e inócua; nenhum dado existente foi alterado).
- **Rollback do schema (opcional, só se necessário):** `DROP TABLE similar_edges;` via nova migration — não afeta `entities`/`connections` (FKs saem da tabela dropada, não entram nela).
