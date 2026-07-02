# Grafo client: overlay que não sequestra o mouse, física consistente, culling de linhas e modal de ligação alinhado

> **Status:** draft · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O grafo do vault é renderizado no client por Sigma.js (WebGL) + duas canvases 2D sobrepostas + um Web Worker com D3-force:

- `src/web/client/graph.ts` — bundle principal do grafo (~1.690 linhas). Cria o renderer Sigma no `#graph-canvas`, duas canvases 2D absolutas por cima (glow em `zIndex:1`, overlay de linhas semânticas/sugeridas em `zIndex:2`, ambas com `pointer-events:none` por padrão — linhas 269-288), o modo "conexões sugeridas" (linhas 1165-1351) e o modal de criação de ligação.
- `src/web/client/sim-worker.ts` — Web Worker com a simulação D3-force. Recebe `init`/`forces`/`pin`/`unpin`/`reheat`/`reset`/`collide` via `postMessage`.
- `src/web/graph.ts` — página server-side. A mesma função `renderGraphLikePage` serve o grafo de notas (`/app/graph`) e o de contatos (`/app/contacts`), trocando só a fonte de dados via `data-graph-src` (linha 558). Injeta as prefs salvas em `data-graph-prefs` (linhas 37-38).
- `src/web/graph-data.ts` — endpoints `/app/graph/{data,meta,link}`. `handleGraphLink` (linha 272) cria edge explícita a partir do modal.
- `src/web/graph-prefs.ts` — persistência das preferências do grafo na tabela `meta`, chave única `graph_prefs` (linha 7), com `sanitizeGraphPrefs` + `handleGraphPrefsPost`.
- `src/web/handler.ts` — roteamento: `/app/graph/prefs` POST na linha 70; rotas de contacts nas linhas 61-63.
- Testes existentes: `src/web/graph-prefs.test.ts` (sanitize + POST) e `src/web/graph.test.ts`.

O sistema tem uma regra canônica (MCP `link`, `src/mcp/tools/link.ts:44` e `save-note.ts:94`): `why` de edge exige **mínimo 20 caracteres**, e `relation_type` é um enum de 9 valores (`EDGE_TYPES` em `src/db/queries.ts:3`), com preferência declarada por `same_mechanism_as` sobre `analogous_to`.

## Problema / Motivação

Cinco defeitos independentes, todos no fluxo de interação/render do grafo:

1. **Modo "conexões sugeridas" congela toda a interação do grafo.** `syncOverlayPointer()` em `src/web/client/graph.ts:1258-1260` seta `overlay.style.pointerEvents = 'auto'` quando o modo está ativo. Como a overlay 2D cobre o container inteiro (`inset:0`, `zIndex:2` — linhas 282-287) e fica ACIMA das canvases do Sigma, ela intercepta TODOS os pointer events: hover de nó morre, drag morre, clique em nó morre, roda do mouse (zoom) morre e pan morre. O usuário liga o modo pra ver sugestões e o grafo inteiro vira uma imagem estática clicável só nas linhas amarelas.

2. **Slider de repulsão troca o modelo físico silenciosamente.** No `rebuildSimulation` do worker, a força `charge` usa strength escalado por raio: `(d) => -forces.repel * ((d.r ?? 10) / 12)` (`src/web/client/sim-worker.ts:86`). Mas o case `'forces'` (disparado por QUALQUER movimento de slider de força) reaplica flat: `(sim.force('charge') as any)?.strength(-forces.repel)` (`sim-worker.ts:139`). Um hub de raio 30 passa a repelir 2,5x menos (30/12 = 2.5) assim que o usuário toca em qualquer slider — o layout que ele vê ao ajustar NÃO é o layout que o "Salvar como padrão" reproduz no próximo load (o load usa o `init`, que volta ao modelo escalado). Tuning vira loteria.

3. **Pan/zoom engasga: milhares de linhas 2D redesenhadas sem culling.** `drawSimilarEdges` (`graph.ts:344-384`) e `drawSuggestedEdges` (`graph.ts:1194-1218`) rodam a cada `afterRender` (linha 389) — ou seja, a cada frame de pan/zoom. Para CADA linha: 2 chamadas `renderer.graphToViewport` + `beginPath`/`stroke` individuais, mesmo quando os dois endpoints estão fora da viewport. Num vault grande (milhares de similar edges) o pan cai pra <30fps.

4. **Modal de ligação diverge das regras canônicas do MCP em 3 pontos.**
   - Mínimo de `why`: o client aceita qualquer string não-vazia (`graph.ts:1293-1298`), o server exige 8 chars (`src/web/graph-data.ts:287-289`), e o MCP exige 20 (`src/mcp/tools/link.ts:44`). Uma edge criada pelo grafo com why de 10 chars viola o princípio Latticework que o próprio sistema impõe via MCP.
   - `relation_type` fixo: `handleGraphLink` hardcoda `'analogous_to'` (`graph-data.ts:299`), contra o principle do sistema de preferir `same_mechanism_as` quando justificável — o usuário nem tem a opção.
   - Erro 4xx vira `alert('Erro ao criar ligação. Veja console.')` genérico (`graph.ts:1334`), descartando o `body.error` que o server manda (ex.: `why minimum 8 characters`, `one or both notes not found`).

5. **Prefs do grafo compartilhadas entre vaults.** `GRAPH_PREFS_META_KEY = 'graph_prefs'` é chave única (`src/web/graph-prefs.ts:7`); `renderGraphLikePage` injeta as MESMAS prefs pra `/app/graph` e `/app/contacts` (`src/web/graph.ts:37`), e o client sempre POSTa em `/app/graph/prefs` (`src/web/client/graph.ts:994`). Tuning de forças bom pro grafo de notas (denso, com semânticas) degrada o grafo de contatos (esparso, sem semânticas) e vice-versa — salvar num sobrescreve o outro.

## Objetivo

Com o modo sugeridas ativo, hover/drag/clique/zoom/pan do grafo continuam 100% funcionais; mover qualquer slider de força preserva o scaling por raio; pan com overlay visível mantém ≥50fps num vault de 2.000+ similar edges; o modal cria edges válidas pelas regras do MCP (why ≥20, relation_type selecionável); e salvar prefs em um vault não altera o outro.

## Design proposto

### 1. Overlay permanece `pointer-events:none` SEMPRE; hit-test migra pro clique do container

- Remover `syncOverlayPointer()` (`graph.ts:1258-1260`) e sua chamada no handler `toggle-suggested` (`graph.ts:1348`). A overlay nunca mais recebe `pointer-events:auto`.
- Mover o hit-test das linhas sugeridas (hoje em `overlay.addEventListener('click', ...)`, `graph.ts:1232-1254`) para o evento `clickStage` do Sigma (já usado em `graph.ts:821` pra fechar o painel):
  - No handler de `clickStage`, se `suggestedActive`, converter o evento pra coordenadas de viewport (o payload do `clickStage` traz `event.x/event.y` em viewport) e rodar o MESMO loop com `pointToSegmentDistance` (`graph.ts:1262-1270`) sobre `suggestedPairs`.
  - Se `best.d < 8`: `openSuggestModal(best.p.source, best.p.target)` e NÃO fechar o painel. Senão, comportamento atual (`closePanel()`).
  - Vantagem do `clickStage` sobre listener no container: o Sigma já resolve a precedência nó-vs-stage (clique em nó continua abrindo o painel da nota) e já ignora cliques que foram drag.
- Clique em nó (`clickNode`) permanece intocado — com a overlay em `none`, hover/drag voltam a funcionar com o modo ativo.

### 2. Case `'forces'` do worker reaplica a MESMA closure de strength

Em `src/web/client/sim-worker.ts`, extrair a closure pra função nomeada e usá-la nos dois lugares:

```ts
const chargeStrength = (d: SimNode) => -forces.repel * ((d.r ?? 10) / 12);
```

- `rebuildSimulation` (linha 86): `.strength(chargeStrength)`.
- Case `'forces'` (linha 139): `(sim.force('charge') as any)?.strength(chargeStrength);`
- Nada mais muda no protocolo de mensagens.

### 3. Culling + batching em `drawSimilarEdges`/`drawSuggestedEdges`

Nas duas funções (`graph.ts:344` e `graph.ts:1194`), por frame:

- **Cache de conversão por nó:** um `Map<string, {x:number,y:number}>` criado no início do `afterRender` (ou passado pras duas funções); `graphToViewport` roda no máximo 1x por nó por frame, não 2x por linha.
- **Culling de viewport:** obter `w = overlay.width / dpr`, `h = overlay.height / dpr` e pular a linha quando AMBOS os endpoints estão fora da viewport expandida por uma margem (ex.: 100px) — teste barato `x < -m || x > w+m || y < -m || y > h+m` nos dois pontos. (Margem cobre o caso de linha que cruza a tela com os dois endpoints fora; aceitável pro caso de uso — documentar no código.)
- **Batching de strokes:** agrupar linhas pelo mesmo par cor/alpha num único `beginPath()` + `moveTo/lineTo` acumulados + um `stroke()` por grupo. Em `drawSimilarEdges` os alphas possíveis por frame são poucos (base, boost de search/hover, dim) — acumular em buckets por alpha. `drawSuggestedEdges` já é cor única: um path só.
- **Opcional (se ainda engasgar):** throttle das duas camadas a ~30fps durante interação de câmera (flag setada em `downStage`/wheel, limpa após ~150ms sem evento), mantendo `drawHoverRing` a 60fps. Implementar só se a meta de fps não for atingida com culling+batching.

### 4. Modal de ligação alinhado ao MCP (why ≥20, relation_type, erro real)

- **Server** (`src/web/graph-data.ts`, `handleGraphLink`):
  - Trocar a validação da linha 287 de `why.length < 8` para `why.length < 20`, com erro `{ error: 'why minimum 20 characters — nomeie o mecanismo compartilhado' }` (mesma régua de `src/mcp/tools/link.ts:44`).
  - Aceitar `relation_type` opcional no body: válido somente se `∈ EDGE_TYPES` (importar de `../db/queries.js`); default `'analogous_to'` se ausente (compat com clients antigos — o Expert Console usa esse endpoint via Bearer). Valor inválido → 400 com `error` explicando os aceitos. Usar o valor no INSERT da linha 299.
- **Client** (`src/web/client/graph.ts` + HTML do modal em `src/web/graph.ts:577-595`):
  - Adicionar ao modal um `<select id="suggest-relation">` com as opções `analogous_to` ("análogo a") e `same_mechanism_as` ("mesmo mecanismo que"), default `analogous_to`. (Só os 2 tipos que fazem sentido pra sugestão por similaridade; os outros 7 do enum ficam pro MCP.)
  - Contador de caracteres ao lado do textarea (`0/20 mín`), atualizado em `input`; botão "Criar ligação" desabilitado enquanto `why.trim().length < 20`.
  - `createSuggestedLink` (`graph.ts:1290`): enviar `relation_type` no body; no `!res.ok`, ler `await res.json()` com try/catch e mostrar `body.error` (fallback pro texto genérico só se o parse falhar). Trocar os `alert()` por mensagem inline no modal (elemento `<p class="suggest-error">`), mantendo o modal aberto pra corrigir.
- **Sem migration**: a coluna `relation_type` já existe com CHECK cobrindo o enum (`src/db/migrations/0001_init.sql:45`). Edges antigas com why de 8-19 chars permanecem intactas — a regra vale só pra criação nova.

### 5. Prefs chaveadas por vault (`graph_prefs` e `graph_prefs:contacts`)

- `src/web/graph-prefs.ts`:
  - `getGraphPrefs(env, vault: 'notes' | 'contacts' = 'notes')` e `handleGraphPrefsPost(req, env, vault = 'notes')` passam a resolver a chave: `vault === 'contacts' ? 'graph_prefs:contacts' : 'graph_prefs'`.
  - A chave legada `graph_prefs` continua sendo a do vault de notas — **zero perda de dados**: quem já salvou prefs continua vendo o mesmo grafo de notas; contacts simplesmente começa sem prefs salvas (usa defaults dos inputs, comportamento já suportado — `getGraphPrefs` retorna `null`).
- `src/web/handler.ts`: adicionar rota `POST /app/contacts/prefs` → `handleGraphPrefsPost(req, env, 'contacts')` (junto das rotas de contacts, linhas 61-63). A rota existente `/app/graph/prefs` (linha 70) fica como está.
- `src/web/graph.ts:37`: `getGraphPrefs(env, isContacts ? 'contacts' : 'notes')`.
- `src/web/client/graph.ts:994` (`onSavePrefs`): POSTar em `` `${graphSrc}/prefs` `` em vez de `/app/graph/prefs` fixo — `graphSrc` já é `/app/graph` ou `/app/contacts` (linha 65).

### Ordem de implementação sugerida

2 (worker, menor e isolado) → 1 (overlay) → 4 (modal, client+server juntos) → 5 (prefs) → 3 (perf, medir antes/depois). Rebuild dos bundles (`npm run build:bundles`) após cada mudança em `src/web/client/*`.

## Fora de escopo

- Seed/layout server-side do grafo (spec 22).
- Otimização do payload `/app/graph/data` (tamanho, paginação) — spec 26.
- Novos tipos de relação no modal além de `analogous_to`/`same_mechanism_as`.
- Backfill/validação retroativa de edges antigas com why <20 chars.
- Migração das prefs de contacts a partir das de notas (contacts começa limpo de propósito).
- Mini-grafo da página da nota (`src/web/client/local-graph.ts`).

## Critérios de aceite

- [ ] Com "Mostrar conexões sugeridas" ativo: hover destaca ego network, drag de nó funciona, clique em nó abre o painel, roda do mouse dá zoom e pan funciona — tudo idêntico ao modo desligado.
- [ ] Com o modo ativo, clicar a <8px de uma linha amarela abre o modal do par correto; clicar longe fecha o painel (comportamento anterior do `clickStage`).
- [ ] A overlay 2D mantém `pointer-events: none` em todos os estados (verificável via DevTools).
- [ ] Mover qualquer slider de Forças e depois recarregar a página com "Salvar como padrão" reproduz visualmente o mesmo layout (hubs mantêm a mesma repulsão relativa durante o ajuste e após reload).
- [ ] `sim-worker.ts` usa uma única função de strength de charge referenciada no `rebuildSimulation` e no case `'forces'`.
- [ ] `drawSimilarEdges`/`drawSuggestedEdges` pulam linhas com ambos os endpoints fora da viewport (+margem), convertem coordenada no máximo 1x por nó por frame e agrupam strokes por cor/alpha.
- [ ] Pan contínuo com intensidade de semânticas >0 num vault com 2.000+ similar edges mantém ≥50fps (medir com o performance panel do DevTools; baseline atual documentada no PR).
- [ ] `POST /app/graph/link` com why de 19 chars retorna 400 com `error` mencionando 20; com 20+ cria a edge.
- [ ] `POST /app/graph/link` aceita `relation_type: 'same_mechanism_as'` e grava esse valor; valor fora de `EDGE_TYPES` retorna 400; ausente grava `analogous_to`.
- [ ] Modal: botão desabilitado com <20 chars, contador visível, select de tipo de relação presente, e erro do server exibido inline (sem `alert`).
- [ ] Salvar prefs em `/app/contacts` grava em `graph_prefs:contacts` e NÃO altera `graph_prefs`; e vice-versa. Prefs de notas já salvas antes da mudança continuam sendo aplicadas em `/app/graph`.
- [ ] Testes novos em `src/web/graph-prefs.test.ts` cobrindo a chave por vault, e em `src/web/graph.test.ts` (ou novo teste) cobrindo why≥20 e relation_type no `handleGraphLink`.

## Validação

```bash
npm run typecheck          # tsc raiz + tsc do client (src/web/client/tsconfig.json)
npm test                   # vitest run + vitest run --config vitest.auth.config.ts
npm run build:bundles      # rebuild graph.bundle.js + sim-worker.bundle.js
npx wrangler dev           # teste manual local
```

Teste manual (gate: validação do dono nos DOIS vaults antes de deploy):
1. `/app/graph`: ligar sugeridas → hover/drag/zoom/pan OK; clicar numa linha → modal; why curto bloqueado; criar com `same_mechanism_as` → edge aparece; mover slider de repulsão → hubs não colapsam; salvar padrão → reload reproduz.
2. `/app/contacts`: ajustar forças diferentes das de notas, salvar, recarregar os dois — cada um mantém o seu.
3. Pan com semânticas visíveis: fluido (comparar com baseline).

**Deploy (`npm run deploy`) SOMENTE com OK explícito do dono.**

## Arquivos afetados

- `src/web/client/graph.ts` — remover syncOverlayPointer, hit-test no clickStage, culling/cache/batching nas duas draw*, modal (contador, select, erro inline), onSavePrefs com graphSrc
- `src/web/client/sim-worker.ts` — closure única de charge strength
- `src/web/graph-data.ts` — handleGraphLink: why ≥20 + relation_type validado
- `src/web/graph-prefs.ts` — chave por vault
- `src/web/graph.ts` — HTML do modal (select + contador), getGraphPrefs por vault
- `src/web/handler.ts` — rota POST /app/contacts/prefs
- `src/web/graph-prefs.test.ts` — testes da chave por vault
- `src/web/graph.test.ts` — testes do handleGraphLink (why/relation_type)

## Riscos e reversão

- **Risco:** hit-test no `clickStage` pode conflitar com o fechamento do painel (clique perto de linha fecha painel em vez de abrir modal, ou vice-versa). Mitigação: o threshold de 8px é o mesmo já validado no listener atual; testar os dois fluxos no manual.
- **Risco:** o culling com margem fixa pode esconder linhas longas que cruzam a tela com ambos endpoints fora. Mitigação: margem de 100px cobre a maioria; se incomodar, teste de interseção segmento×retângulo é o fallback (mais caro, documentado no código).
- **Risco:** endurecer o why pra 20 chars pode quebrar o Expert Console (usa `/app/graph/link` via Bearer). Verificar os callers antes do deploy; o erro 400 com mensagem clara torna a falha diagnosticável.
- **Reversão:** mudanças são client bundle + 2 handlers, sem migration e sem escrita destrutiva. Rollback = `git revert` do(s) commit(s) + `npm run deploy` da versão anterior. Prefs: a chave nova `graph_prefs:contacts` fica órfã no meta após revert (inócua); a chave legada `graph_prefs` nunca é renomeada nem apagada. Edges criadas com `same_mechanism_as` são válidas no schema atual e não precisam de rollback de dados.
