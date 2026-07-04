# Grafo servidor: orçamento de payload, cap de similar edges, sourceHash em 1 query e TTL no KV

> **Status:** done · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O grafo do console (`/app/graph/data`) é montado inteiramente no servidor por `buildPayload` em `src/web/graph-data.ts:76-173`:

- Carrega **todas** as notas vivas (`id, title, domains`) e **todas** as edges explícitas em 2 queries paralelas (`src/web/graph-data.ts:79-83`).
- Carrega **todas** as similar edges pré-computadas via `getAllSimilarEdges` (`src/db/queries.ts:86-91`) — `SELECT from_id, to_id, score FROM similar_edges` sem `LIMIT` nem cap — e deduplica pares simétricos/explícitos em memória no Worker (`src/web/graph-data.ts:101-116`).
- Roda o layout (`computeLayout`, já com guard de escala do fix do Error 1102 — ver comentário do `CACHE_KEY` em `src/web/graph-data.ts:43`) e serializa **um JSON único** que vai pro KV (`GRAPH_CACHE`) e pro browser.

O cache funciona assim (`getPayload`, `src/web/graph-data.ts:180-188`):

1. `computeSourceHash` (`src/web/graph-data.ts:45-59`) roda **3 queries D1 sequenciais** (notes, edges, similar_edges) e monta uma string-hash.
2. Lê a chave fixa `CACHE_KEY = 'graph:v7'` (`src/web/graph-data.ts:43`) do KV; se o `sourceHash` do value bate, serve o cache.
3. Senão, rebuilda e faz `env.GRAPH_CACHE.put(CACHE_KEY, JSON.stringify(payload))` **sem `expirationTtl`** (`src/web/graph-data.ts:186`).

Cada nota grava até `SIMILARITY_TOP_K = 4` vizinhos no write path (`src/web/similarity.ts:8`), então `similar_edges` cresce ~4x o número de notas. O repo já usa `expirationTtl` em outro KV (`src/web/api-keys.ts:50`), e o padrão "identidade do conteúdo NA CHAVE + TTL" é o mesmo usado pelo adapter de contacts no Expert Console (o Brain só proxia esse caso, ver `src/web/contacts-data.ts`).

Testes existentes do endpoint: `src/web/graph.test.ts` (cache hit por `sourceHash`, invalidação por update, dedup de similar edges, anti-stale por `SUM(score)`).

## Problema / Motivação

Este é o próximo gargalo de escala depois do fix do Error 1102 (que atacou só o `computeLayout`):

1. **Payload cresce sem teto** — `buildPayload` (`src/web/graph-data.ts:76-173`) materializa notes + edges + similar_edges inteiros e serializa um JSON único. Com ~1,9k notas já são **7,5k+ linhas** de `similar_edges` trafegando do D1 pro Worker por rebuild; em 5-10k notas viram 20-40k linhas e o JSON passa de poucos MB pra dezenas de MB — estoura memória do isolate, tempo de resposta e experiência no browser. Não existe teste que fixe um orçamento: o crescimento só aparece quando quebra em produção (exatamente como aconteceu no 1102).
2. **Cap de similar edges é feito tarde demais** — o `SELECT` sem limite (`src/db/queries.ts:87-89`) traz tudo e a dedup roda em JS (`src/web/graph-data.ts:104-112`). O D1 poderia devolver só o top-N por nó.
3. **3 queries D1 por request MESMO em cache hit** — `getPayload` chama `computeSourceHash` a cada request (`src/web/graph-data.ts:181`), e o hash faz 3 `await` sequenciais (`src/web/graph-data.ts:55-57`). São 3 round-trips D1 pra no fim das contas servir um value do KV.
4. **Lixo versionado no KV** — cada bump manual de `CACHE_KEY` (`graph:v6` → `graph:v7`, `src/web/graph-data.ts:43`) abandona o value anterior no KV **pra sempre**: o `put` não tem `expirationTtl` (`src/web/graph-data.ts:186`) e nada apaga as chaves antigas. Payloads de MB órfãos se acumulam a cada deploy que bumpa a versão.
5. **KV não comprime sozinho** — o JSON é armazenado e cobrado em bytes crus; um payload de grafo (strings repetitivas: ids, `"type":"similar"`, coordenadas) comprime 5-10x com gzip.

## Objetivo

O `/app/graph/data` continua funcional com 5k notas dentro de um orçamento de payload explícito e testado (assert que quebra ao estourar), com no máximo 1 query D1 de hash por request e zero values órfãos permanentes no `GRAPH_CACHE`.

## Design proposto

Nenhuma migration é necessária — todas as mudanças são read-path e cache. Números **antes/depois** de cada etapa devem ser medidos e registrados na seção "Resultados medidos" no fim desta spec (gate de aceite).

### 1. Teste sintético de orçamento de payload (N=5k)

Em `src/web/graph.test.ts`, novo `describe('orçamento de payload em escala')`:

- Semear via `env.DB.batch` (em chunks, pra não estourar binds): **5.000 notas** vivas (títulos realistas de ~60 chars, `domains` JSON de 1-2 itens), ~1.000 edges explícitas e **4 similar edges por nota** (espelhando `SIMILARITY_TOP_K = 4` de `src/web/similarity.ts:8`), com pares simétricos parciais pra exercitar a dedup.
- Buscar `/app/graph/data` autenticado, medir `new TextEncoder().encode(await res.text()).length`.
- **Assert de orçamento explícito**: `expect(bytes).toBeLessThan(PAYLOAD_BUDGET_BYTES)` com a constante exportada de `src/web/graph-data.ts` (proposta inicial: `5_000_000` — 5 MB; calibrar com o número medido ANTES das otimizações e apertar depois; o limite hard de value do KV é 25 MB, o orçamento fica bem abaixo).
- Assert adicional de sanidade: o request completa sem erro e `nodes.length === 5000`.
- Se o teste ficar lento demais pro CI, isolar num `describe` próprio; NÃO usar `skip` — o teste é o gate anti-regressão.

Rodar este teste ANTES das etapas 2-5 pra registrar o baseline.

### 2. Cap de similar edges no SELECT (top-3 por `from_id`)

Nova função em `src/db/queries.ts` (manter `getAllSimilarEdges` intocada se ainda houver outro consumidor; hoje o único consumidor é o grafo — nesse caso pode substituir):

```sql
SELECT from_id, to_id, score FROM (
  SELECT from_id, to_id, score,
         ROW_NUMBER() OVER (PARTITION BY from_id ORDER BY score DESC, to_id) AS rn
  FROM similar_edges
) WHERE rn <= ?
```

```ts
export async function getTopSimilarEdges(env: Env, perNode: number): Promise<SimilarEdgeRow[]>
```

- D1 é SQLite moderno — window functions são suportadas. O `ORDER BY score DESC, to_id` dá desempate determinístico.
- `buildPayload` (`src/web/graph-data.ts:104`) passa a chamar `getTopSimilarEdges(env, 3)` com constante nomeada (ex.: `GRAPH_SIMILAR_PER_NODE = 3`) documentada ao lado de `SIMILARITY_TOP_K`.
- A tabela `similar_edges` NÃO muda (o write path continua gravando top-4) — o cap é só de leitura, reversível por config.
- `computeSourceHash` continua hasheando a tabela INTEIRA (`COUNT + SUM(score)`) — isso permanece correto: qualquer mudança no conteúdo invalida o cache, mesmo em linhas fora do top-3.
- Atualizar o teste de dedup existente (`src/web/graph.test.ts:67-98`) se necessário (com 4 similar edges por nó de teste, garantir que o cap não altera o resultado esperado nos fixtures pequenos).

### 3. `computeSourceHash` em 1 query D1

Substituir as 3 queries (`src/web/graph-data.ts:55-57`) por uma única com subselects:

```sql
SELECT
  (SELECT COALESCE(MAX(updated_at), 0) FROM notes WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task')) AS nm,
  (SELECT COUNT(*)                     FROM notes WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task')) AS nc,
  (SELECT COALESCE(MAX(created_at), 0) FROM edges)                        AS em,
  (SELECT COUNT(*)                     FROM edges)                        AS ec,
  (SELECT COUNT(*)                     FROM similar_edges)                AS sc,
  (SELECT COALESCE(SUM(score), 0)      FROM similar_edges)                AS ss
```

- **Manter o formato da string idêntico** (`n{m}x{c}_e{m}x{c}_s{c}c{sum.toFixed(4)}`) pra não invalidar o cache vigente à toa no deploy.
- Preservar TODO o comentário existente sobre por que `COUNT + SUM(score)` (anti-stale de reembed, `src/web/graph-data.ts:46-54`) — ele é a memória institucional do bug.
- Reutilizar `NON_TASK_FILTER` de `src/db/queries.ts:31` em vez de repetir o filtro inline.

### 4. TTL no KV + sourceHash na chave (aposentar o bump manual)

Migrar `getPayload` (`src/web/graph-data.ts:180-188`) pro padrão identidade-na-chave:

- Chave passa a ser `graph:v8:${sourceHash}` (prefixo de versão continua existindo pra mudanças de FORMATO do payload; o bump deixa de ser necessário pra invalidação de conteúdo).
- `get`: como a chave já embute o hash, um hit dispensa a comparação `cached.sourceHash === sourceHash` (mantê-la como cinto de segurança é aceitável e barato).
- `put` com `{ expirationTtl: 7 * 24 * 3600 }` (7 dias) — mesmo padrão de `src/web/api-keys.ts:50`. Todo value expira sozinho: chaves de hashes antigos e de versões antigas deixam de ser lixo permanente.
- `handleGraphLink` (`src/web/graph-data.ts:301`) faz `GRAPH_CACHE.delete(CACHE_KEY)` hoje; com o hash na chave isso vira redundante (inserir edge muda `COUNT`/`MAX(created_at)` de `edges` → hash novo → chave nova). Remover o `delete` ou trocá-lo por comentário explicando por que não é mais necessário.
- Limpeza one-shot (manual, fora do código): apagar as chaves `graph:v6`/`graph:v7` órfãs via `wrangler kv key delete` após o deploy — documentar o comando no PR.

### 5. Compressão do value no KV (avaliar com números)

KV não comprime automaticamente. Avaliar gzip via `CompressionStream('gzip')` (nativo em Workers):

- `put`: comprimir `JSON.stringify(payload)` e gravar `ArrayBuffer`; `get(key, 'arrayBuffer')` + `DecompressionStream` no hit.
- Medir: tamanho comprimido vs. cru no cenário N=5k do teste da etapa 1, e latência de compressão/descompressão.
- **Decisão pelo número**: só adotar se reduzir ≥50% do storage E a latência extra do hit ficar desprezível (<50ms). Se adotar, considerar também servir o payload comprimido ao browser com `Content-Encoding: gzip` (evita descomprimir no Worker só pra recomprimir no edge). Se os números não justificarem, registrar a medição e NÃO adotar.

### Resultados medidos (execução — onda G, 03/07/2026)

Medidos no teste sintético N=5k (`src/web/graph.test.ts` + medição pontual via `CompressionStream`), vault semeado com 5.000 notas + ~1.000 edges explícitas + 4 similar edges/nó (20.000 linhas em `similar_edges`).

| Métrica (N=5k sintético) | Antes | Depois |
| --- | --- | --- |
| Bytes do payload `/app/graph/data` | ~5,5 MB (est., top-4 sem cap) | **2.343.594 B (2,34 MB)** |
| Similar edges SERVIDAS por payload | ~18-20k (top-4, todos) | **14.000 (cap top-3)** |
| Linhas de `similar_edges` LIDAS por rebuild | 20.000 (SELECT sem cap) | ≤14.999 (window function, top-3/nó) |
| Queries D1 por request em cache hit | 3 | 1 |
| Queries D1 de hash por request em cache MISS | 2 (getPayload + buildPayload) | 1 (hash passado a buildPayload) |
| Value órfão no KV após bump/rotação | permanente | expira ≤7d (expirationTtl) |

**Decisão sobre compressão (gate):** gzip do payload N=5k mede **285.762 B (12,2% do cru — redução de 87,8%)**. O critério de adoção da etapa 5 (≥50% de redução E latência desprezível) é atendido pela redução, MAS: (1) o payload cru já cabe FOLGADO no orçamento após o cap top-3 (2,34 MB « 5 MB « 25 MB limite do KV), então armazenamento não é o gargalo; (2) comprimir muda o FORMATO do value no KV (put `ArrayBuffer` + `DecompressionStream` em todo hit), adicionando complexidade e um passo de descompressão no caminho quente sem resolver um problema real de custo hoje. **Decisão: NÃO adotar compressão nesta onda.** Registrada a medição (a spec permite explicitamente "registrar a medição e NÃO adotar"). Se o vault crescer a ponto de o cru aproximar do orçamento, reavaliar — o número está aqui.

## Fora de escopo

- Streaming ou particionamento do payload (chunks, paginação de nós) — só entra se o teste de orçamento da etapa 1 provar que 5-10k notas não cabem no orçamento mesmo após as etapas 2-5.
- Qualquer mudança no client (`src/web/client/graph.ts`) — o formato do JSON servido ao browser não muda.
- Mudanças no write path de similaridade (`SIMILARITY_TOP_K`, `refreshSimilarEdges` em `src/web/similarity.ts`) e na tabela `similar_edges`.
- Mudanças no subgrafo ego (`handleNoteGraph`) e no `/app/graph/meta` — ambos herdam os ganhos via `getPayload` sem alteração própria.
- O grafo de contatos (`src/web/contacts-data.ts` é só proxy; o cache dele mora no Worker do Expert Console).

## Critérios de aceite

- [ ] Teste sintético N=5k existe em `src/web/graph.test.ts`, roda no `vitest` e **falha** se o payload estourar `PAYLOAD_BUDGET_BYTES` (constante exportada e documentada).
- [ ] `buildPayload` lê similar edges via `getTopSimilarEdges(env, 3)` (window function no D1) — não existe mais `SELECT` sem cap no caminho do grafo.
- [ ] Teste de dedup existente (`src/web/graph.test.ts:67-98`) continua verde com o cap ativo.
- [ ] `computeSourceHash` faz exatamente **1** `env.DB.prepare(...).first()` e produz string no formato idêntico ao atual (asserção em teste: mesmo dado → mesmo hash de antes da mudança).
- [ ] `GRAPH_CACHE.put` usa `expirationTtl` de 7 dias e chave `graph:v8:${sourceHash}`; não existe mais comparação obrigatória de bump manual pra invalidação de conteúdo.
- [ ] Inserir edge via `POST /app/graph/link` resulta em payload atualizado no request seguinte SEM depender de `GRAPH_CACHE.delete` (teste cobrindo).
- [ ] Decisão sobre compressão registrada nesta spec com números (adotada ou rejeitada — nunca "depois a gente vê").
- [ ] Tabela "Resultados medidos" preenchida com antes/depois.
- [ ] Nenhuma migration nova; `runMigrations` intocado; dados existentes intactos.

## Validação

```bash
npm run typecheck          # (ou npx tsc --noEmit, conforme package.json)
npx vitest run src/web/graph.test.ts
npx vitest run             # suite completa
```

Manual (preview local): `npx wrangler dev`, logar no `/app`, abrir o grafo, confirmar render + criar um link pelo painel e ver a edge aparecer no reload. **Deploy em produção SÓ com OK explícito do dono do repo.** Pós-deploy: apagar chaves `graph:v6`/`graph:v7` órfãs (`wrangler kv key delete --namespace-id <GRAPH_CACHE_ID> "graph:v7"` etc.) e conferir `/app/graph/data` no vault real.

## Arquivos afetados

- `src/web/graph-data.ts` — `computeSourceHash` (1 query), `getPayload` (chave com hash + TTL), `buildPayload` (cap top-3), `handleGraphLink` (delete redundante), constante `PAYLOAD_BUDGET_BYTES`, compressão (se adotada)
- `src/db/queries.ts` — nova `getTopSimilarEdges`; `getAllSimilarEdges` removida ou marcada como sem consumidor
- `src/web/graph.test.ts` — teste sintético N=5k com assert de orçamento; ajuste dos fixtures de dedup; teste de invalidação via hash-na-chave

## Riscos e reversão

- **Window function no D1**: se `ROW_NUMBER() OVER` falhar em alguma versão do D1 local (miniflare) vs. produção, fallback: `SELECT` completo + cap em JS no Worker (mantém o ganho de payload, perde o de I/O D1). Testar nos dois ambientes antes do deploy.
- **Cap top-3 muda a teia visível**: edges de similaridade fora do top-3 somem do grafo. É intencional (redução de ruído), mas se o dono do vault estranhar, reverter é 1 linha (`GRAPH_SIMILAR_PER_NODE = 4` ≈ comportamento atual, ou trocar a chamada de volta pra `getAllSimilarEdges`).
- **TTL de 7d**: pior caso é um cache miss extra por semana num vault parado (rebuild de segundos). Sem risco de dado — o payload é derivado, a fonte de verdade é o D1.
- **Rollback geral**: `git revert` do PR restaura o comportamento atual imediatamente; nenhum estado persistente muda de formato (KV é cache descartável, D1 não é tocado por schema). Chaves novas `graph:v8:*` órfãs expiram sozinhas pelo TTL.
