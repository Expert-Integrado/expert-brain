# save_note com gate soft de duplicatas, sugestões de link e dedupe_key

> **Status:** ready · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nada (PR independente). É o PR 1 do grupo 70 — deploy dele destrava o "Passo 0" (instruções do dono).

## Contexto

O censo de 09/07/2026 (26 contas, 4.449 notas em 3 dias de import) mostrou que a instrução
textual do handshake MCP ("rode recall antes de save_note") é ignorada em escala: ~65% do
vault órfão, duplicatas reais entre contas. O `save_note` hoje (src/mcp/tools/save-note.ts)
já faz UMA consulta ao Vectorize pós-insert (`refreshSimilarEdges`, best-effort) — mas joga
fora a informação: o caller nunca fica sabendo que acabou de salvar uma quase-cópia.

Bandas medidas no censo (bge-m3, cosseno): duplicatas reais 0.80–0.85; vizinhas legítimas
0.75–0.80; nada acima de 0.85. Daí o gate ser SOFT (nota `z6trwoy1aqk6`): bloquear a 0.80
induziria merge de teses distintas — dano pior que duplicata.

## Problema / Motivação

- `save_note` não devolve nenhum sinal de duplicata nem candidato a link — o agente salva
  às cegas e o link vira dever de casa que ninguém faz.
- Imports em lote re-rodados criam a mesma nota N vezes (não há chave de idempotência).
- O `why` de edge aceita frases genéricas de 20+ chars ("essas notas são relacionadas
  entre si") — passa na régua de tamanho e polui o grafo.

## Design

### 1. Uma única consulta ao Vectorize alimenta 3 consumidores

Refactor em `save-note.ts`: a `queryVector` sai de dentro do `refreshSimilarEdges`
pós-insert e roda UMA vez logo após o `embed()` (pré-insert, top-6; o próprio id ainda não
está no índice), em try/catch. Os matches alimentam:

1. **`possible_duplicates`** — matches com `score >= DEDUP_MIN_SCORE` (0.80, exportada de
   `src/web/similarity.ts`). Complementados por match de título via FTS5 (nova query
   `findSimilarActiveNotesByTitle` em queries.ts, adaptação de
   `findSimilarActiveTasksByTitle:658` pra `kind != 'task'` + `deleted_at IS NULL`, LIMIT 5)
   — pega dup intra-lote que o Vectorize ainda não indexou (consistência eventual de ~1-2
   min). Shape do item: `{ id, title, tldr, score, reason: 'vector' | 'title' }` (score
   `null` quando `reason: 'title'`). O save SEMPRE acontece — o campo é informativo.
2. **`link_suggestions`** — matches com `LINK_SUGGESTION_MIN_SCORE (0.60) <= score < 0.80`,
   máx 3, shape `{ id, title, tldr, score }`. O tldr vai junto de propósito: é o que permite
   ao agente escrever um `why` de mecanismo sem precisar de um `get_note` extra.
3. **`replaceSimilarEdges`** — os MESMOS matches (filtro `score >= SIMILARITY_MIN_SCORE`,
   top `SIMILARITY_TOP_K`), persistidos pós-insert como hoje. Zero segunda chamada ao
   Vectorize — o teste trava `VECTORIZE.query` em exatamente 1 chamada por save.

Falha da `queryVector` NÃO derruba o save: dups/sugestões viram `[]` e as similar_edges
ficam pro re-pass (spec 72). Logar `console.log('save_note dedup', JSON.stringify({id,
top_scores}))` pra re-medição das bandas.

### 2. Privacidade (risco nº 1 do grupo)

`possible_duplicates` e `link_suggestions` expõem `title`/`tldr` de OUTRAS notas — a
hidratação é obrigatoriamente `getNotesByIds(env, ids, canSeePrivate(auth))`, mesmo padrão
do recall (src/mcp/tools/recall.ts:111). PAT sem escopo `private` não vê nota privada
nessas superfícies (o candidato some da lista, nunca aparece redigido).

### 3. `dedupe_key` — o único gate HARD (idempotência declarada)

Input opcional `dedupe_key: string` (1-120 chars). Semântica: identidade declarada PELO
caller pra imports/re-runs — não é heurística.

- Persistência: tag reservada `dedupe:<key>` (tabela `tags` — zero migration).
- Checagem ANTES do `embed()`: se existe nota viva com essa tag, retorna
  `{ deduped: true, id, url, title }` da existente SEM chamar Workers AI e SEM insert.
- DESCRIPTION documenta: usar SÓ quando o caller controla a chave (id de origem do import,
  hash do conteúdo-fonte); nunca inventar chave pra nota conversacional.

### 4. Blocklist de `why` preguiçoso

Novo `src/mcp/why-quality.ts` exportando `isLazyWhy(why: string): boolean` — rejeita why
cujo conteúdo é SÓ genérico (regex PT/EN: "relacionad(as|os)", "related", "mesmo tema",
"same topic", "similar", "conectadas", "both about" sem mais substância). Aplicado nos dois
pontos de criação de edge: `save-note.ts` (validação de `input.edges`) e a tool `link`.
Mensagem de erro reusa a pedagogia atual (nomear o MECANISMO compartilhado, exemplo bom e
ruim). A régua de 20 chars continua — esta é uma segunda régua, de conteúdo.

### 5. Resposta e DESCRIPTION

Resposta do `save_note` (aditivo, nada removido): campos atuais + `possible_duplicates` +
`link_suggestions`. DESCRIPTION ganha o parágrafo de comportamento: "se
`possible_duplicates` vier não-vazio, mostre ao usuário e ofereça `update_note` na
existente OU mantenha as duas se forem teses distintas — NUNCA mescle sem confirmar; se
`link_suggestions` vier, avalie criar edges via `link` com why de mecanismo".

### Passo 0 (pós-deploy, sem código)

Texto pronto pro dono colar em `/app/config` > Instruções do dono (entra no handshake das
26 contas). Entregar junto com o report do deploy — NÃO antes (referencia campos que só
existem depois do PR1 no ar):

```
Higiene do grafo: ao usar save_note, leia a resposta. Se vier possible_duplicates,
compare com a nota existente antes de qualquer outra ação (update_note nela OU manter as
duas se forem teses distintas — nunca mesclar sem confirmar com o usuário). Se vier
link_suggestions, crie os edges que tiverem mecanismo real via link (why explicando o
mecanismo, não "são relacionadas"). Em import em lote, sempre passe dedupe_key com o id
de origem do item.
```

## Arquivos afetados

- `src/web/similarity.ts` — exportar `DEDUP_MIN_SCORE = 0.80` e
  `LINK_SUGGESTION_MIN_SCORE = 0.60`; `refreshSimilarEdges` ganha overload que aceita
  matches já consultados (evita a segunda query).
- `src/mcp/tools/save-note.ts` — refactor da consulta, dedupe_key, campos novos, DESCRIPTION.
- `src/db/queries.ts` — `findSimilarActiveNotesByTitle`, `findActiveNoteIdByTag` (dedupe).
- `src/mcp/why-quality.ts` — novo, `isLazyWhy`.
- `src/mcp/tools/link.ts` — aplicar `isLazyWhy`.
- `test/tools/save-note-dedup.test.ts` — novo (TDD, escrito antes da implementação).

## Critérios de aceite

- [ ] Match >= 0.80 aparece em `possible_duplicates` com title/tldr/score e o save acontece.
- [ ] Match 0.60–0.79 aparece em `link_suggestions` com tldr; não aparece como duplicata.
- [ ] Título quase idêntico gera duplicata `reason: 'title'` mesmo com Vectorize vazio.
- [ ] `dedupe_key` repetida devolve a nota existente sem chamar `AI.run` e sem criar linha.
- [ ] PAT sem escopo `private` não vê nota privada em nenhuma das duas listas; sessão do dono vê.
- [ ] Falha do Vectorize não derruba o save (listas vazias, nota salva).
- [ ] `VECTORIZE.query` é chamada exatamente 1 vez por save (as similar_edges reusam os matches).
- [ ] `why` genérico com 20+ chars é rejeitado em save_note e link.
- [ ] Suite completa verde + typecheck.

## Validação

`npx vitest run test/tools/save-note-dedup.test.ts` + suite completa. Pós-deploy (com OK
do dono): `save_note` real com tldr quase idêntico a nota conhecida e conferir o campo na
resposta; só então entregar o Passo 0.
