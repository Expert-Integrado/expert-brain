# Grafo: seed clusterizado por domínio + posições persistentes entre saves (layout estável)

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O grafo do dashboard (`/app/graph`) é montado no servidor e refinado no cliente:

- **Layout server-side** (`src/web/layout.ts`): `computeLayout(nodes, edges)` recebe `LayoutNode { id }` e `LayoutEdge { source, target }` e devolve `LaidOutNode { id, x, y }`. O seed inicial é um hash determinístico do id do nó (`seededPosition`, `src/web/layout.ts:11-22`) — dois hashes FNV/DJB2 viram coordenadas em `[-0.5, 0.5)`.
- **Guard de escala (fix do Error 1102)**: acima de `FA2_MAX_NODES = 900` nós (`src/web/layout.ts:33-40`), o forceAtlas2 é pulado por completo (estourava o CPU do Worker no vault grande) e o layout devolvido é SÓ o hash espalhado por `spread = 40 * sqrt(n)`. Abaixo do teto, o FA2 roda 150 iterações como refinamento do seed (`src/web/layout.ts:54-68`).
- **Montagem do payload** (`src/web/graph-data.ts`): `buildPayload` lê notas + edges explícitas + `similar_edges` do D1, monta `layoutNodes`/`layoutEdges` e chama `computeLayout` (`src/web/graph-data.ts:123-128`). O domínio primário de cada nota já é extraído por `firstDomain` (`src/web/graph-data.ts:63-74`) — mas só DEPOIS do layout, para colorir o nó (`src/web/graph-data.ts:136`). O layout não sabe de domínios.
- **Cache**: o payload inteiro (dados + posições) vive numa única chave KV `graph:v7` (`CACHE_KEY`, `src/web/graph-data.ts:43`) no namespace `GRAPH_CACHE` (`src/env.ts:10`). A validade é decidida por `computeSourceHash` (`src/web/graph-data.ts:45-59`), que combina `MAX(updated_at)`/`COUNT` de notas, `MAX(created_at)`/`COUNT` de edges e `COUNT`+`SUM(score)` de `similar_edges`. Ou seja: **qualquer** `save_note`, `update_note`, `link`, `delete_note` ou `reembed` muda o hash e invalida o cache; `getPayload` (`src/web/graph-data.ts:180-188`) então reconstrói TUDO — inclusive o layout, do zero. `handleGraphLink` ainda deleta a chave explicitamente (`src/web/graph-data.ts:301`).
- **Cliente** (`src/web/client/graph.ts`): Sigma renderiza as posições do servidor e um d3-force em Web Worker faz só ajuste fino com `alpha: 0.25` (`src/web/client/graph.ts:700-703`) — deliberadamente suave, pois assume que o seed do servidor já tem estrutura. Com alpha baixo, o d3 NÃO reorganiza uma nuvem aleatória em clusters.

Não existe `test/layout.test.ts` — o guard 1102 (fix de incidente de produção) não tem nenhum teste de regressão. O runner é `@cloudflare/vitest-pool-workers` (`vitest.config.ts`) com `GRAPH_CACHE` já declarado como KV de teste (`vitest.config.ts:13`).

## Problema / Motivação

1. **Acima de 900 nós o grafo nasce como nuvem aleatória.** O caminho pós-guard devolve hash puro espalhado (`src/web/layout.ts:34-40`) — zero relação entre posição e domínio/vizinhança. O d3 client-side com `alpha: 0.25` (`src/web/client/graph.ts:703`) só faz ajuste fino, então a nuvem nunca se organiza: linhas de similaridade cruzam o canvas inteiro e o mapa vira estática visual. Em vaults reais com ~1800+ nós (o cenário que motivou o guard, comentário em `src/web/layout.ts:25-32`) essa é a experiência permanente.

2. **Toda escrita re-semeia o layout inteiro.** `computeSourceHash` muda a cada `save_note`/`link`/`reembed` (`src/web/graph-data.ts:45-59`) e `getPayload` reconstrói o payload completo (`src/web/graph-data.ts:180-188`), recomputando `computeLayout` do zero (`src/web/graph-data.ts:128`). Como dados e layout dividem a MESMA chave KV (`graph:v7`), salvar UMA nota redistribui os outros ~1800 nós — o usuário perde o mapa mental ("aquele cluster ficava ali") a cada save. Bônus negativo: em vaults abaixo de 900 nós (ex.: vaults de alunos), o FA2 de 150 iterações roda inteiro a CADA escrita, gastando CPU do Worker à toa.

3. **O guard 1102 não tem regressão.** `FA2_MAX_NODES` é constante local não exportada (`src/web/layout.ts:33`) e não há `test/layout.test.ts`. Nada impede que um refactor futuro reative o FA2 acima do teto e reintroduza o Error 1102 em produção.

## Objetivo

Grafo acima de 900 nós nasce visualmente clusterizado por domínio em O(n), posições existentes sobrevivem a qualquer escrita de nota/edge (só nós novos são semeados), e o guard 1102 ganha teste de regressão — sem nenhuma migration de D1.

## Design proposto

Nenhuma mudança de schema D1 — persistência do layout via chave KV própria (aditiva; a chave nova não conflita com `graph:v7`).

### 1. Seed clusterizado por domínio — `src/web/layout.ts`

Estender `LayoutNode` com o domínio primário (opcional, para não quebrar chamadores existentes) e exportar o teto do guard:

```ts
export interface LayoutNode { id: string; domain?: string; }
export const FA2_MAX_NODES = 900;
```

Nova função `clusteredSeed(nodes: LayoutNode[]): LaidOutNode[]`, O(n), determinística:

1. Coletar os domínios distintos presentes (fallback `'misc'` quando `domain` ausente) e **ordená-los** (sort lexicográfico — garante determinismo independente da ordem das notas no D1).
2. Cada domínio `i` de `D` domínios ganha um centro de cluster num círculo:
   - `ângulo = (i / D) * 2π`
   - `R = 40 * Math.sqrt(nodes.length)` (mesma escala do `spread` atual, `src/web/layout.ts:35`)
   - `centro = (R * cos(ângulo), R * sin(ângulo))`
3. Cada nó = centro do cluster do seu domínio + jitter determinístico derivado do hash do id (reutilizar os dois hashes de `seededPosition`, `src/web/layout.ts:11-22`): um hash vira ângulo do jitter, o outro vira raio. Raio máximo do jitter `≈ 12 * Math.sqrt(nósDoDomínio)` — cluster grande ocupa mais área, cluster pequeno fica compacto. Usar distribuição radial `r = rMax * sqrt(u)` (u uniforme do hash) pra densidade uniforme no disco, não amontoada no centro.

`computeLayout` passa a usar `clusteredSeed`:

- **Acima de `FA2_MAX_NODES`**: devolver `clusteredSeed(nodes)` direto (substitui o bloco `src/web/layout.ts:34-40`). Continua O(n), sem FA2 — o guard 1102 fica intacto.
- **Abaixo do teto**: usar `clusteredSeed` como posição inicial dos nós do grafo FA2 (substitui `seededPosition` em `src/web/layout.ts:44`) — o FA2 converge mais rápido partindo de clusters.

Como as `similar_edges` conectam majoritariamente notas do mesmo domínio, as linhas de similaridade ficam majoritariamente intra-cluster — o d3 client-side com alpha 0.25 só precisa acomodar, não reorganizar.

### 2. Layout persistente separado dos dados — `src/web/layout.ts` + `src/web/graph-data.ts`

**Separar LAYOUT de DADOS no cache.** Nova chave KV no mesmo namespace:

```ts
const LAYOUT_KEY = 'graph-layout:v1'; // Map<id, {x, y}> serializado como Record
```

Assinatura de `computeLayout` ganha um terceiro parâmetro opcional (aditivo — chamadores antigos seguem compilando):

```ts
export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  existing?: ReadonlyMap<string, { x: number; y: number }>,
): LaidOutNode[]
```

Comportamento com `existing`:

- Nó com posição em `existing` → devolve a posição gravada, **sem tocar** (nem FA2 sobrescreve: se o FA2 rodar, nós existentes entram com `fixed`/posição preservada na saída — o mais simples e suficiente é: se `existing` cobre ≥ 1 nó, PULAR o FA2 por completo e só semear os novos; o refinamento fica 100% a cargo do d3 client-side, que já existe).
- Nó novo (sem posição) → semeado com `clusteredSeed` calculado sobre o conjunto TOTAL de nós (pra usar os mesmos centros de cluster), ou seja, nasce perto do cluster do seu domínio primário.
- Consequência direta: o FA2 recorrente a cada escrita desaparece também nos vaults < 900 nós — ele só roda no PRIMEIRO build (KV de layout vazio) de vaults pequenos.

Em `buildPayload` (`src/web/graph-data.ts:76`):

1. `layoutNodes` passa a carregar o domínio: `notes.map((n) => ({ id: n.id, domain: firstDomain(n.domains) }))` (reusa `firstDomain`, `src/web/graph-data.ts:63-74`; hoje a linha 123 monta só `{ id }`).
2. Antes de `computeLayout`, ler `LAYOUT_KEY` do `env.GRAPH_CACHE` (`get(LAYOUT_KEY, 'json')`), converter em `Map` e passar como `existing`. KV ausente/corrompida → `undefined` (primeiro build, comportamento atual).
3. Depois de `computeLayout`, gravar de volta em `LAYOUT_KEY` o layout resultante **apenas dos nós vivos** (`aliveIds`) — poda automática de nós deletados, a chave não cresce sem limite.

`getPayload` e `computeSourceHash` não mudam: o `sourceHash` continua invalidando os DADOS a cada escrita (correto — nota nova precisa aparecer), mas o rebuild agora reutiliza as posições e só semeia os nós novos. `handleGraphLink` (`src/web/graph-data.ts:301`) continua deletando só `CACHE_KEY` — **não** deletar `LAYOUT_KEY` ali (criar edge não deve mexer em posições).

**Bump do cache de dados**: `CACHE_KEY` de `graph:v7` → `graph:v8` (`src/web/graph-data.ts:43`), seguindo o padrão dos bumps anteriores — descarta payload antigo no deploy e força o primeiro build com o seed novo.

**Reset manual**: deletar a chave `graph-layout:v1` no KV re-semeia tudo do zero (documentar no comentário da constante). Não criar endpoint de reset nesta spec.

### 3. Teste de regressão do guard 1102 — `test/layout.test.ts` (novo)

Arquivo novo rodando no pool workers padrão (`vitest.config.ts`). `computeLayout` é função pura — não precisa de D1/KV. Casos:

1. **Guard existe e vale 900**: `expect(FA2_MAX_NODES).toBe(900)` — assert explícito contra regressão silenciosa do teto (exige o export do item 1).
2. **901+ nós sintéticos não passam pelo FA2**: gerar 950 nós (`id: note-${i}`, `domain` ciclando por ~10 domínios sintéticos tipo `dom-${i % 10}`) + algumas centenas de edges; medir `performance.now()` em volta do `computeLayout` e assertar tempo trivial (ex.: `< 500ms` — FA2 com 150 iterações em 950 nós levaria ordens de magnitude mais).
3. **Posições finitas**: todo `x`/`y` do resultado passa `Number.isFinite`.
4. **Determinísticas**: duas chamadas com o mesmo input → resultados profundamente iguais (`toEqual`).
5. **Distintas**: nenhum par de nós com posição idêntica (usar `Set` de `"x,y"` e comparar tamanho) — pega regressão de "todo mundo no centro".
6. **Clusterizadas**: para cada nó, a distância ao centroide do SEU domínio é menor que a distância ao centroide de qualquer outro domínio (ou versão estatística: ≥ 95% dos nós satisfazem — jitter não cruza clusters por construção, mas a versão estatística tolera ajustes futuros de raio).
7. **Persistência**: chamar `computeLayout` com `existing` cobrindo N-1 nós → os N-1 voltam com posição idêntica à de `existing` e só o nó novo ganha posição nova, finita e próxima do centroide do seu domínio.

## Fora de escopo

- Mudanças no client Sigma/d3 (`src/web/client/graph.ts`, `src/web/client/sim-worker.ts`) — alpha, forças, física: spec 25.
- Porte do grafo pro expert-contacts — spec `10-backend/21` depende desta, não o contrário.
- Endpoint/tool de reset de layout ou pin de nós server-side.
- Persistir de volta as posições refinadas pelo d3 client-side (round-trip cliente→servidor).
- Qualquer migration de D1 (a persistência é 100% KV).

## Critérios de aceite

- [x] `FA2_MAX_NODES` exportado de `src/web/layout.ts` e assertado em teste.
- [x] Acima de 900 nós, `computeLayout` devolve seed clusterizado por domínio em O(n), sem FA2 (verificado por tempo trivial no teste).
- [x] `LayoutNode` aceita `domain?` e `buildPayload` o preenche via `firstDomain`; abaixo de 900 nós o FA2 parte do seed clusterizado.
- [x] Posições persistidas em chave KV própria (`graph-layout:v1`), separada do payload de dados.
- [x] Após qualquer escrita (save_note/link/reembed), o rebuild do grafo mantém a posição de todos os nós pré-existentes e semeia apenas nós novos perto do cluster do seu domínio primário.
- [x] Com layout persistido, o FA2 NÃO roda em rebuilds (inclusive vaults < 900 nós — só no primeiro build).
- [x] Nós deletados são podados da chave de layout no rebuild.
- [x] `CACHE_KEY` bumpado para `graph:v8`.
- [x] `test/layout.test.ts` cobre: guard 900, tempo trivial com 950 nós, posições finitas, determinísticas, distintas, clusterizadas e persistência com `existing`.
- [x] `npm run typecheck` e `npm test` verdes (falha isolada em `src/web/config.test.ts`, pré-existente, fora do escopo desta spec — não introduzida por esta mudança); nenhuma migration adicionada.

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck
npx vitest run test/layout.test.ts   # suite nova isolada
npm test                             # suite completa (inclui vitest.auth.config.ts)
```

Teste manual local: `npm run dev`, abrir `/app/graph`, conferir clusters por cor de domínio; criar uma nota de teste via dashboard/MCP local e recarregar o grafo — todos os nós antigos ficam onde estavam, só o novo aparece no cluster do domínio dele (deletar a nota de teste depois).

**Gate final: validação VISUAL pelo dono no vault real (produção) antes de considerar done.** Deploy (`npm run deploy`) SÓ com OK explícito do dono.

## Arquivos afetados

- `src/web/layout.ts` — `clusteredSeed`, export de `FA2_MAX_NODES`, `LayoutNode.domain?`, parâmetro `existing` em `computeLayout`.
- `src/web/graph-data.ts` — `LAYOUT_KEY`, leitura/gravação do layout no KV em `buildPayload`, `layoutNodes` com domínio, bump `CACHE_KEY` → `graph:v8`.
- `test/layout.test.ts` — novo, regressão do guard 1102 + clusterização + persistência.

## Riscos e reversão

- **Risco: seed clusterizado piorar a leitura em algum vault** (ex.: 1 domínio dominante vira um disco gigante). Mitigação: raio de jitter proporcional a `sqrt(nósDoDomínio)`; gate visual do dono antes do done.
- **Risco: posições "fósseis"** — nó que trocou de domínio mantém a posição antiga (comportamento intencional: estabilidade > pureza). Reset disponível deletando a chave KV.
- **Risco: chave de layout corrompida/formato inesperado no KV** → tratar erro de parse como `undefined` (primeiro build), nunca lançar.
- **Rollback concreto**: revert do commit + redeploy. O bump `graph:v8` faz o worker antigo (v7) reconstruir seu próprio cache na primeira request; a chave `graph-layout:v1` fica órfã e inofensiva (worker antigo não a lê) — pode ser deletada manualmente no KV. Zero migration = zero dado de D1 pra desfazer.
