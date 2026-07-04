# Recall: fechar vazamento de tasks via domains_filter, corrigir estouro de binds e semântica de limite

> **Status:** done · **Prioridade:** P0 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O `recall` é a busca híbrida do vault (vetor + FTS), implementada em `src/mcp/tools/recall.ts`. O pipeline hoje:

1. Embeda a query e busca top-30 no Vectorize + top-30 no FTS5 (`recall.ts:57-61`).
2. Se `domains_filter` foi passado, roda uma query D1 adicional que puxa até 50 ids de notas que contenham qualquer um dos domínios filtrados, e injeta esses ids no pool (`recall.ts:72-86`). Isso existe pra que "me mostra tudo que tenho sobre X" funcione mesmo quando as notas de X caem fora da janela semântica top-30.
3. Hidrata todos os ids acumulados num único `SELECT ... WHERE id IN (...)` (`recall.ts:90-93`).
4. Ordena (vetor > FTS > domain-only), filtra por `domains_filter` em memória, e aplica balanceamento cross-domain: no máximo 3 hits por domínio primário e no máximo 5 domínios distintos (`recall.ts:125-136`).

Tasks (`kind='task'`) moram na MESMA tabela `notes` (migration `0006_task_fields`), mas o contrato do sistema é que **task nunca aparece em recall**: elas não são embedadas (`insertTask` em `src/db/queries.ts:248-253` não chama `upsertNoteVector` de propósito) e todos os read paths de conhecimento usam o filtro `NON_TASK_FILTER = (kind IS NULL OR kind <> 'task')` (`src/db/queries.ts:31`). O `ftsSearch` já aplica esse filtro inline (`src/db/queries.ts:219`).

## Problema / Motivação

Três defeitos no caminho do `recall`, todos com evidência concreta:

1. **Tasks vazam pelo `domains_filter`.** A query de retrieval por domínio (`src/mcp/tools/recall.ts:75-81`) filtra só `n.deleted_at IS NULL` — não exclui `kind='task'`. Como toda task tem `domains`, um `recall(query, domains_filter=['operations'])` injeta as tasks de `operations` no pool. O SELECT de hidratação (`recall.ts:91-93`) tampouco exclui tasks, então elas sobrevivem até o resultado final (o filtro em memória de `recall.ts:115-123` filtra por domínio, não por kind). Isso quebra o contrato "task é excluída do recall" documentado em `src/db/queries.ts:17-21`. O caminho SEM filtro não vaza por acidente (task não tem vetor e o FTS já exclui), mas o caminho COM filtro vaza sempre.

2. **Estouro do limite de binds do D1 em vault grande.** O pool de ids pode chegar a 30 (vetor) + 30 (FTS) + 50 (domain retrieval) = até 110 ids únicos. A hidratação (`recall.ts:90-93`) monta UM `IN (...)` com um placeholder por id — o D1 capa em ~100 parâmetros bound por statement, então acima disso a query falha em runtime (`D1_ERROR: too many SQL variables`) e o recall inteiro erra justamente no cenário de vault grande + filtro de domínio. O próprio repo já tem o padrão correto: `getTagsForNotes` chunca em lotes de 100 (`src/db/queries.ts:159-164`).

3. **Limite prometido é inalcançável com `domains_filter`.** A tool aceita `limit` até 30 (`recall.ts:10`) e o description promete "everything on X" (`recall.ts:25`), mas o balanceador cross-domain capa em 3 hits por domínio primário e 5 domínios distintos (`recall.ts:130-131`) — teto real de ~15, e num filtro de domínio único, ~3 notas com aquele domínio como primário (+ até 12 de notas onde ele é secundário). Não há offset/paginação, então o restante do domínio é simplesmente inacessível via tool. O balanceador faz sentido no caminho exploratório sem filtro; com filtro explícito ele só atrapalha.

Findings cobertos: `recall-domains-filter-vaza-tasks`, `recall-task-leak-domain-filter`, `recall-estoura-100-binds-d1`, `recall-limit-inalcancavel-sem-paginacao`.

## Objetivo

Nenhuma task retornada por `recall` em nenhum caminho, nenhuma falha de binds com pool de até 110 ids, e `domains_filter` capaz de enumerar um domínio inteiro via `limit`+`offset` — com testes de regressão pros três itens.

## Design proposto

Tudo em `src/mcp/tools/recall.ts` (+ testes). Sem migration — nenhuma mudança de schema.

### 1. Excluir tasks nos dois pontos (defesa em profundidade)

Importar `NON_TASK_FILTER` de `../../db/queries.js` (já exportado) e aplicar:

a) Na query de `domainFilterIds` (`recall.ts:75-81`):

```sql
SELECT DISTINCT n.id
FROM notes n, json_each(n.domains) je
WHERE je.value IN (...) AND n.deleted_at IS NULL
  AND (n.kind IS NULL OR n.kind <> 'task')
ORDER BY n.updated_at DESC
LIMIT 50
```

b) No SELECT de hidratação (`recall.ts:91-93`):

```sql
SELECT id, title, tldr, domains, kind FROM notes
WHERE id IN (...) AND deleted_at IS NULL
  AND (kind IS NULL OR kind <> 'task')
```

O item (b) é redundante hoje (vetor e FTS já não retornam tasks), mas garante que qualquer fonte futura de ids no pool não reabra o vazamento. Usar a constante `NON_TASK_FILTER` interpolada (é SQL estático, sem input do usuário) pra não duplicar a string.

### 2. Chunkar a hidratação em lotes de 100

Substituir o SELECT único (`recall.ts:90-93`) por um loop no mesmo padrão de `getTagsForNotes` (`src/db/queries.ts:159-164`):

```ts
const allIds = Array.from(ids);
const hydrated: Array<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>> = [];
for (let i = 0; i < allIds.length; i += 100) {
  const chunk = allIds.slice(i, i + 100);
  const ph = chunk.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT id, title, tldr, domains, kind FROM notes
     WHERE id IN (${ph}) AND deleted_at IS NULL AND ${NON_TASK_FILTER}`
  ).bind(...chunk).all<...>();
  hydrated.push(...(r.results ?? []));
}
```

Opcional: extrair pra um helper `getNotesByIds(env, ids)` em `src/db/queries.ts` ao lado de `getTagsForNotes`, se ficar mais limpo — mas manter inline também é aceitável.

### 3. Relaxar o balanceador quando há filtro + offset opcional

a) **Input schema** (`recall.ts:8-12`): adicionar `offset: z.number().int().min(0).optional().default(0)`.

b) **Seleção** (`recall.ts:125-136`): quando `input.domains_filter?.length`, PULAR o cap de 3-por-domínio-primário e o cap de 5 domínios distintos — o usuário já escopou explicitamente; usar só `limit` + `offset` sobre o `pool` ordenado:

```ts
let picked: RecallHit[];
if (input.domains_filter?.length) {
  picked = pool.slice(offset, offset + limit);
} else {
  // balanceador cross-domain existente, INALTERADO (recall.ts:125-136)
}
```

No caminho sem filtro, `offset > 0` pode simplesmente ser ignorado ou aplicado como slice pós-balanceamento — decisão: **aplicar `slice(offset, offset+limit)` sobre o resultado balanceado** pra semântica uniforme, sem tocar na lógica do balanceador em si.

c) **LIMIT 50 do domain retrieval**: com paginação, 50 vira o teto real de enumeração de um domínio. Subir pra `LIMIT 200` na query de `domainFilterIds` (continua barato — é um SELECT de ids indexado; o chunking do item 2 absorve o pool maior: 30+30+200 = 260 ids → 3 chunks).

d) **Description da tool** (`recall.ts:14-27`): atualizar o parágrafo `DOMAINS_FILTER SEMANTICS` pra documentar a semântica real: com filtro, o balanceamento cross-domain é desligado, os resultados vêm ordenados por relevância (semânticos > keyword > domain-only por recência) e a enumeração completa usa `offset` (ex.: `limit=30, offset=0`, depois `offset=30`, até vir menos que `limit`). Documentar também o teto de 200 notas por domínio via retrieval e que, sem filtro, vale o balanceamento (máx 3 por domínio, 5 domínios, ~15 resultados).

### Regras invioláveis

- **NUNCA** indexar tasks no Vectorize — a exclusão é por design, não bug.
- **NUNCA** alterar o comportamento do balanceador no caminho SEM filtro (testes existentes `returns domain-balanced results` devem continuar passando sem edição).
- Sem migration; se alguma fosse necessária, seria aditiva — mas esta spec não muda schema nem dados.

### Testes de regressão (gate de deploy)

Em `test/tools/recall.test.ts`, seguindo os padrões da suíte existente (seed direto via `E.DB.prepare(INSERT INTO notes ...)`, mocks de `E.AI`/`E.VECTORIZE`):

1. **Task não vaza via filtro**: seedar uma nota `kind='task'` com `domains=["cognitive-science"]` (usar INSERT com colunas `status='open'` etc., espelhando `insertTask`), mockar Vectorize com `matches: []`, chamar `recall({ query: 'x', domains_filter: ['cognitive-science'] })` e assertar que o id da task NÃO está nos resultados (e que as notas de conhecimento do mesmo domínio ESTÃO).
2. **Pool > 100 ids não estoura**: seedar 120+ notas num domínio válido e chamar recall com `domains_filter` (com LIMIT 200 o pool passa de 100). Assertar `r.isError` undefined e resultados não vazios. Obs.: o D1 local do `cloudflare:test` pode não reproduzir o cap exato de binds do D1 remoto — o teste valida que o chunking funciona (mesmo racional do teste de `getTagsForNotes`).
3. **Paginação com filtro**: seedar N > limit notas no domínio, chamar `recall(limit=5, offset=0)` e `recall(limit=5, offset=5)` com o mesmo filtro; assertar que as duas páginas são disjuntas, e que iterando até resposta curta se enumera mais que 15 notas do domínio (prova que o cap de 3/domínio foi relaxado).
4. **Sem filtro, nada muda**: os testes existentes (`returns domain-balanced results...`, `response does not leak internal allDomains field` etc.) passam sem modificação.

## Fora de escopo

- Indexar tasks no Vectorize (nunca — exclusão é contrato).
- Mudar o balanceador cross-domain do caminho SEM `domains_filter` (máx 3 por domínio / 5 domínios permanece).
- Cursor-based pagination, ordenação configurável ou filtros por kind/tag no recall.
- Mudanças em `ftsSearch` (já exclui tasks corretamente em `src/db/queries.ts:219`).
- Qualquer mudança de schema/migration.

## Critérios de aceite

- [ ] `recall` com `domains_filter` nunca retorna nota com `kind='task'` (teste 1 passa).
- [ ] Query de `domainFilterIds` e SELECT de hidratação ambos contêm o filtro `(kind IS NULL OR kind <> 'task')` (defesa em profundidade — verificável por leitura do diff).
- [ ] Hidratação chunkada em lotes de 100 ids; recall com pool de 110+ ids não erra (teste 2 passa).
- [ ] Com `domains_filter`, o cap de 3-por-domínio e 5-domínios é desligado; `limit` é respeitado integralmente (teste 3 passa).
- [ ] Parâmetro `offset` aceito e funcional; páginas consecutivas são disjuntas (teste 3 passa).
- [ ] Description da tool documenta a semântica real de limite/paginação com filtro (não promete mais "everything" num só call sem mencionar offset).
- [ ] Caminho sem filtro inalterado: todos os testes pré-existentes de `test/tools/recall.test.ts` passam sem edição.
- [ ] `npm run typecheck` e `npm test` verdes.

## Validação

```bash
cd /c/repos/expert-brain
npm run typecheck
npx vitest run test/tools/recall.test.ts   # foco na suíte alterada
npm test                                    # suíte completa (inclui vitest.auth.config.ts)
```

Teste manual (ambiente de dev, antes do deploy):

1. `save_task` com `domains=['operations']` + `recall('qualquer coisa', domains_filter=['operations'])` → task NÃO aparece.
2. Num domínio com >15 notas: `recall(query, domains_filter=[dominio], limit=30)` → retorna até 30; `offset=30` → retorna a página seguinte.

**Deploy (wrangler) SOMENTE com OK explícito do dono do repo.** Gate: os 3 testes de regressão verdes ANTES do deploy.

## Arquivos afetados

- `src/mcp/tools/recall.ts` — filtro de task nas 2 queries, chunking da hidratação, offset, bypass do balanceador com filtro, description atualizado.
- `src/db/queries.ts` — só se optar por extrair helper `getNotesByIds` (reuso do padrão de `getTagsForNotes:156-172`); caso contrário, sem mudança.
- `test/tools/recall.test.ts` — 3 testes de regressão novos.

## Riscos e reversão

- **Risco: clientes que dependiam do balanceamento COM filtro.** Baixo — com filtro de 1 domínio o balanceamento devolvia no máximo ~3 notas primárias, comportamento já percebido como bug. A mudança é estritamente mais resultados, nunca menos.
- **Risco: pool maior (LIMIT 200) aumenta latência/custo da hidratação.** Mitigado pelo chunking (máx 3 subrequests D1 extras) e pelo fato de a hidratação selecionar só 5 colunas leves (sem body).
- **Risco: `offset` novo confundir clientes MCP antigos.** Nenhum — parâmetro opcional com default 0; contrato anterior preservado.
- **Reversão:** mudança é 100% código (zero migration, zero mutação de dados). Rollback = `git revert` do commit + redeploy do worker. Nenhum dado precisa ser restaurado.
