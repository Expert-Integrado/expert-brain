# Grafo 3D: tiers de qualidade (Auto / Extra / Equilibrado / Leve)

> **Status:** in-progress (13/07/2026) · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** spec 104 (palco 3D cosmos — bloom, gaiola, gânglios, sinapses)

## Contexto

O dono reportou o 3D "extremamente pesado" no vault real e pediu "uma versão extra
gráfico e uma menor". Diagnóstico MEDIDO (13/07/2026, vault real com 6.576 notas):

- **~25,7k Meshes/draw calls por frame**: 6.576 esferas (1 `Mesh` por nó —
  three-forcegraph não instancia; `SphereGeometry` compartilhada por `val` não
  funde draw calls) + ~4,2k cilindros de links explícitos + **~15k cilindros das
  linhas SEMÂNTICAS, visíveis por padrão** (hideSimilar=false, similarOpacity
  0.18 → `linkVisible` true; 60% dos objetos, quase invisíveis na tela).
- Render loop **rAF contínuo incondicional** (3d-force-graph não tem FPS cap nem
  render-on-demand; único controle é pauseAnimation/resumeAnimation, já usado no
  exit3D/enter3D).
- **Bloom multi-pass em pixelRatio 2** no desktop (clamp 1.5 só mobile).
- Física: cooldown de 15s reiniciado a cada reheat de slider; forceCollide até
  4 iterações com "não sobrepor"; communityGravity O(n)/tick.
- Guards existentes cobrem SÓ mobile (nodeResolution 8, pixelRatio 1.5, glow
  off). "Esconder isoladas" já remove ~3,4k esferas de verdade (nodeVisibility
  filtra ANTES do digest — objeto nem é criado).

## Decisões de design

- **Pref `visual3d.quality: 'auto' | 'extra' | 'balanced' | 'low'`** (default
  `'auto'`), persistida no perfil visual 3D (mesmo fluxo do `glow`, spec 104).
- **Chips "Qualidade (3D)"** no painel Visual — chips, NÃO `<select>` (o select
  nativo foi banido do painel de propósito; ver comentário A.35 no graph.ts).
- Tiers:

  | Tier | Sims 3D | Glow | nodeResolution | pixelRatio cap | collide forte | cooldown |
  |---|---|---|---|---|---|---|
  | extra | visíveis | permitido | 16 | 2 (lib) | 4 iter | 15s |
  | balanced | ocultas | permitido | 16 | 1.5 | 4 iter | 15s |
  | low | ocultas | forçado OFF | 8 | 1 | 2 iter | 8s |

- **`auto` (default): mede o FPS real e escolhe sozinho.** Boota em `balanced`
  (o dono JÁ reclama de peso — medir em extra imporia jank garantido), amostra
  ~60 frames válidos com rAF próprio (mediana do frame time; descarta amostras
  com `document.hidden`/palco pausado), decide 1x por sessão: mediana ≤18.2ms
  (~55fps) → promove pra `extra`; ≤33.3ms (~30fps) → fica `balanced`; senão →
  `low`. Persiste só `'auto'`; a resolução é por sessão/máquina.
- **Guards mobile COMPÕEM com o tier (min dos dois)** — nunca são substituídos.
  Glow em `low`: switch "Brilho" desabilitado com help text (mesmo estilo do
  guard mobile); o tier efetivo do auto chega ao client via callback
  `ctx.onQualityResolved(tier)` → re-sync dos controles.
- **Sims ocultas em balanced/low = gate LOCAL do palco** no `linkVisible` —
  `state.hideSimilar` é compartilhado POR REFERÊNCIA com o 2D e não pode ser
  mutado. Help text avisa que o 2D não muda.
- **Baseline pra TODOS os tiers**:
  - Sims renderizadas como `THREE.Line` em vez de cilindro (`linkWidth` 0 pra
    `_sim`): corta a geometria Lambert de ~15k cilindros (LineBasicMaterial sem
    iluminação), visual quase idêntico em opacity 0.18. FIXADO no init — trocar
    o accessor `linkWidth` em runtime faz `linkDataMapper.clear()` e recria os
    ~19k objetos de link; tiers só mexem em `linkVisibility` (re-digest por
    diff, barato).
  - Guard de background nas sinapses: `setTimeout` continua rodando em aba
    oculta e `emitParticle` acumularia photons pra consumir na volta — gate
    `!document.hidden` no disparo. (O rAF em si o browser já pausa sozinho.)
- Mudança ao vivo dos knobs VERIFICADA na lib: `nodeResolution` re-digesta
  trocando a geometria (Meshes preservados), `setPixelRatio` no renderer E no
  composer refaz os render targets, `cooldownTime` é linked prop lida por tick,
  `linkVisibility` re-digesta por diff.
- **Gotchas pegos na validação (13/07):** (1) `data-quality-3d` NÃO vira
  `dataset.quality3d` — traço seguido de dígito não converte pra camelCase;
  atributo renomeado pra `data-quality3d`. (2) O sampler do auto media DURANTE
  o assentamento da física e a mediana caía pra 'low' até em máquina forte —
  movido pro primeiro `onEngineStop` (regime permanente, que é o que o dono
  vive 95% do tempo). (3) Os seletores dos chips de coloração eram globais
  (`.graph-color-chip`) e roubariam o `active` dos chips novos — escopados por
  container (`#color-mode-chips` / `#quality-3d-chips`).

## Estimativa de ganho

| Otimização | Ordem de grandeza |
|---|---|
| Sims cilindro→Line (baseline) | 10-30% do frame |
| balanced: sims ocultas (-15k objetos, 58% dos draw calls) | 2-3x no frame time |
| pixelRatio 2→1.5 / →1 | -44% / -75% dos pixels (bloom escala junto) |
| low: glow off | 30-50% do frame em GPU fraca |
| low: nodeResolution 16→8 (~3,3M → ~0,8M tris) | grande em vertex-bound |
| low: collide 4→2 + cooldown 15s→8s | settle ~2x mais curto/leve |

Composto: **balanced ~2-3x, low ~4-8x** mais leve que o estado atual.

## Plano de commits

1. **Spec + pref server**: `graph-prefs.ts` (interface, `VISUAL3D_DEFAULTS.quality`,
   sanitize com enum-guard padrão colorMode) + testes roundtrip/sanitize.
2. **Palco baseline**: sims→Line no `linkWidth`, gate `document.hidden` nas
   sinapses, listener `visibilitychange` (respeita o `paused` do exit3D) +
   cleanup no dispose.
3. **Motor de qualidade (sem UI)**: novo `graph3d-quality.ts` PURO
   (`TIER_SETTINGS`, `resolveTier`, `medianOf`) + testes client; `graph3d.ts`
   ganha `effectiveTier`, `applyQuality()` (aplica os knobs ao vivo), gate de
   glow/sims por tier, sampler rAF do auto, `applyQuality` no controller.
4. **UI chips + persistência**: SSR gated `can3D` + classe `graph-3d-only`
   (cobrir `div` no CSS), callback `onQuality3D`, `syncVisualSliders` reflete
   chip + disabled do glow, save/reset; teste SSR.
5. **Bundles + calibração**: `build:bundles`, validação visual nos 4 tiers no
   vault real com FPS anotado aqui.

## Fora de escopo (futuro)

- **InstancedMesh pros nós** via `nodeThreeObject` (1 draw call pra 6,5k
  esferas) — spike separado; maior ganho estrutural restante.
- **`LineSegments` único pra TODAS as sims** (1 draw call em vez de 15k Lines).
- FPS cap / render-on-demand (o rAF da lib é incondicional — exigiria fork).
- `linkResolution` 6→4 nas explícitas (marginal); `warmupTicks` (bloqueia main
  thread).

## Critérios de aceite

- [ ] Chips Auto/Extra/Equilibrado/Leve no painel Visual (só no 3D), persistindo
  em "Salvar como padrão" e restaurando no reload.
- [ ] `auto` resolve por medição e reflete o tier efetivo nos controles (glow
  disabled em low).
- [ ] `balanced`: sims ocultas no 3D, 2D intacto; glow/sinapses funcionando.
- [ ] `low`: sem bloom/sinapses, esferas 8 segmentos, pixelRatio 1.
- [ ] Guards mobile continuam valendo (min com o tier).
- [ ] Typecheck + vitest + test:client verdes em cada commit.

## Validação

Suite completa + visual local (wrangler dev, 4 tiers forçados pelos chips) +
medição de FPS no vault real antes/depois (anotar aqui). Gate de deploy: OK
explícito do dono.

## Riscos e reversão

Aditivo e atrás de pref (default `auto` muda o boot pra `balanced` — se o dono
estranhar a ausência das sims no 3D, chip `extra` restaura o estado antigo em um
clique). Sims como Line é a única mudança visual baseline — reversível em 1
linha. Nenhuma mudança de schema/dado.
