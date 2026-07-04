# Spec 29 — Grafo: câmera do fit/foco, prefs por superfície, boot 2D e busca no 3D

> PRD da rodada pós-typeahead (spec implícita no commit `93cdc10`). Quatro entregas
> que fecham o feedback do dono após o ship da busca com dropdown: (1) o palco não
> pode "se perder" depois de uma busca; (2) cada superfície tem a SUA configuração
> salva; (3) recarregar a página SEMPRE abre em 2D; (4) a busca acende/apaga nós
> no 3D igual ao 2D.

## Contexto e bug raiz (P0)

O dropdown typeahead (commit `93cdc10`) ligou `focusNode`/`fitToMatches` ao fluxo
principal de busca. Ambos passam **coordenadas cruas do graph** pra
`camera.animate()` — mas a câmera do Sigma trabalha no **espaço enquadrado**
(framed/normalizado), onde o bbox ativo (via `setCustomBBox` do settle) mapeia
pra ~[0..1] e o repouso é `{x: 0.5, y: 0.5, ratio: 1}`.

Medições em dev remoto (04/07/2026):

| Fase | Câmera |
|---|---|
| Repouso pós-settle | `{x: 0.5, y: 0.5, ratio: 1}` |
| Bbox do graph (posições cruas pós-simulação) | ±3.400 unidades |
| Pós-Enter na busca | `{x: 83.9, y: -3371.5, ratio: 0.35}` → **tela vazia** |
| Pós-"Ajustar à tela" | `{x: 0.5, y: 0.5, ratio: 1}` → recupera |

Cadeia do sintoma "borrado/lento" reportado: Enter joga a câmera pro vazio →
usuário caça o grafo com roda/pan → `minCameraRatio: 0.08` permite ratio onde
o pixel renderizado = `size/ratio` = **12,5× o tamanho normal** → bolha branca
borrada, overdraw pesado, sensação de travado.

Agravantes no código novo: `fullSpan` é congelado no boot ANTES da simulação
expandir o layout (denominador podre na razão `span/fullSpan`); o fit roda
durante o reveal e briga com o `animatedReset` periódico do settle; limpar a
busca não devolve o enquadramento.

## Entrega 1 — câmera correta no foco e no fit

Arquivo: `src/web/client/graph.ts`.

- **`focusNode`**: converter pra espaço enquadrado via
  `renderer.getNodeDisplayData(id)` (existe no Sigma 3 e devolve x/y framed);
  animar `{x: dd.x, y: dd.y, ratio: 0.35}`. Branch 3D (`g3d.flyTo`) intocado.
- **`fitToMatches`**: bbox dos matches em coordenadas **display** (mesma fonte
  `getNodeDisplayData`); centro = centro do bbox; `ratio =
  clamp(max(spanX, spanY) * 1.4, 0.25, 1.15)` — no espaço enquadrado ratio 1 ≈
  moldura do núcleo, então a razão é auto-normalizada e o `fullSpan` morre.
  Guardas: só com `cameraSettled === true` (não brigar com o reveal) e só 2D.
- **Voltar da pesquisa**: ao limpar a busca (`onSearch('')`), se houve
  foco/fit durante a busca (flag), `camera.animatedReset({duration: 400})` —
  o usuário SEMPRE volta pro enquadramento padrão. Esc na caixa já limpa a
  busca; o reset pega carona.
- Piso de ratio dos caminhos de busca ≥ 0.25 (nunca perto do 0.08 global, que
  infla nós 12,5×).

## Entrega 2 — prefs por superfície (contatos ≠ notas)

Hoje: UMA chave global `meta.graph_prefs` (D1) compartilhada por `/app/graph` e
`/app/contacts` — salvar sliders em Contatos sobrescreve Notas e vice-versa. A
separação 2D/3D JÁ existe DENTRO do blob (`forces`+visual legado = perfil 2D;
`forces3d`/`visual3d` = perfil 3D), então as três configurações pedidas mapeiam:

| Configuração do dono | Storage |
|---|---|
| Contatos | chave nova `graph_prefs:contacts` (perfil 2D do blob; can3D=false) |
| Notas 2D | chave legada `graph_prefs` (perfil 2D do blob) |
| Notas 3D | chave legada `graph_prefs` (perfil `forces3d`/`visual3d`) |

Mudanças (`src/web/graph-prefs.ts`, `src/web/graph.ts`, `src/web/handler.ts`,
client `onSavePrefs`):

- `getGraphPrefs(env, surface)` / `setGraphPrefs(env, surface, prefs)` com
  `surface: 'notes' | 'contacts'`; notes usa a chave legada (zero migração),
  contacts usa `graph_prefs:contacts` com **fallback de leitura** na legada
  (primeira carga herda o estado atual em vez de resetar).
- `POST /app/graph/prefs` ganha `surface` no body (enum sanitizado; default
  `notes`). O client manda `surface: isContacts ? 'contacts' : 'notes'`.
- O server de página (`renderGraphLikePage`) injeta as prefs da superfície
  certa no `data-graph-prefs`.

## Entrega 3 — boot SEMPRE 2D

Hoje `initialMode` considera `prefs.mode === '3d'` — salvar padrão estando no
3D prende o boot no 3D. Regra nova (server, `src/web/graph.ts`):

```
initialMode = (can3D && queryMode === '3d') ? '3d' : '2d'
```

- `prefs.mode` sai da equação e deixa de ser persistido (o sanitize passa a
  dropar `mode`; blobs antigos com `mode: '3d'` são ignorados no boot).
- Deep-link `?mode=3d` continua funcionando (e o toggle continua refletindo na
  URL durante a sessão) — 3D é sempre escolha explícita, nunca default.

## Entrega 4 — busca acende/apaga no 3D (paridade com o 2D)

O 3D já lê o `state` do 2D **por referência** e o padrão de espelhamento é
`push3D((c) => c.applyX())` re-chamando accessors da lib. Falta exatamente:

- `graph3d.ts`: tipar `searchMatches: Set<string>` no `SharedState`; accessor
  `nodeColorFn` que devolve o fantasma `rgba(70, 70, 90, 0.22)` pra não-match
  quando `state.searchMatches.size > 0` (mesmo truque do `linkColor`, que já
  embute alpha na cor — `nodeOpacity` da lib é global, não serve); `nodeVal`
  compõe `×1.6` pro match (espelho do 2D). Método novo no controller:
  `applySearch: () => { graph.nodeColor(nodeColorFn); graph.nodeVal(nodeVal); }`.
- Interface `Graph3DController` atualizada nas DUAS cópias (graph3d.ts e a
  cópia local do graph.ts).
- `graph.ts`: `push3D((c) => c.applySearch())` nos 3 pontos do `onSearch` que
  mutam `searchMatches` (limpa, local, extras do server) e no `onResetAll`.
- `flyTo` no Enter já funciona hoje — fora de escopo.

## Fora de escopo

- Persistir posições/layout dos nós (spec 22 cobre).
- Fit-to-matches no 3D (o dim + flyTo bastam nesta rodada).

## Verificação

1. `npm run typecheck` + `npm test` + build bundles.
2. Playwright em dev remoto (2D notas): buscar → câmera enquadra os matches
   (ratio ∈ [0.25, 1.15], centro dentro de [0..1]); Enter → voa pro nó
   (câmera próxima de `getNodeDisplayData` do nó); limpar → `{0.5, 0.5, 1}`.
3. Contatos: salvar sliders em `/app/contacts` NÃO altera `graph_prefs`
   (chave nova no D1); recarregar cada página carrega a sua config.
4. Com pref antiga `mode: '3d'` gravada: recarregar `/app/graph` abre em 2D;
   `?mode=3d` abre em 3D.
5. 3D: ativar toggle, buscar — só matches acesos, resto fantasma; limpar
   busca restaura; voltar pro 2D sem resíduo.
