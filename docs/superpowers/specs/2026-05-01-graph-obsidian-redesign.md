# Graph View — Redesign Obsidian-style

**Date:** 2026-05-01
**Status:** Draft
**Owner:** Eric (visual director)
**Origin:** "design está mais ou menos ruim — copia o Obsidian"

## Context

Phase 1 do redesign Obsidian-style (commit `52167e7`) trouxe overlay com search, filter chips, slide panel e early-stop animation. Mas a aparência geral ainda diverge do Obsidian em pontos importantes — gradientes nebula muito densos, edges grossos demais, labels sempre visíveis, sem glow per-node ao invés de halo de canvas.

## Goal

Refinar a estética do graph view para se aproximar do graph view nativo do Obsidian, que é referência de mercado em visualização de knowledge graphs:

- **Minimalismo**: background neutro, sem gradientes "estéticos" disputando atenção dos nós
- **Edges sutis**: linhas finas (1px) brancas semi-transparentes (~18%) — informação contextual, não destaque
- **Labels condicionais**: só visíveis em zoom alto OU em hover, evitar poluição
- **Glow per-node**: halo radial leve atrás de cada nó com a cor do domínio, em vez de halo único cobrindo o canvas
- **Hover scale**: nó cresce ~20% no hover, animação `cubic-bezier(0.22, 1, 0.36, 1)` ~180ms
- **Background**: cor sólida ou gradiente muito sutil; tirar o "nebula" no canvas do graph (manter no resto do app)

## Comparativo (referência)

| Aspecto | Obsidian | Atual Brain | Após redesign |
|---|---|---|---|
| Background | Sólido `#1e1e1e` ou similar | Radial gradient lavender no canvas (`#graph-canvas::before`) | Sólido `#0a0a0e` (mais escuro que Obsidian, mantém marca) |
| Edges (cor/opacity) | `#fff` ~25% | Lavender `rgba(186, 140, 255, 0.78)` | `rgba(255, 255, 255, 0.18)` |
| Edges (size) | ~1px | 2.2 | 1.0 |
| Labels | Aparecem em zoom alto + hover | Renderizam sempre que cabem | Threshold maior (`labelRenderedSizeThreshold`) |
| Node glow | Pequeno halo radial per-node | Nenhum (só halo de canvas inteiro) | Halo `radial-gradient` per-node via custom Sigma program |
| Hover scale | Sim (1.2x) | Não (só fade dos outros) | `nodeReducer` aumenta size do hovered |
| Cursor | Crosshair em pan | Default | Adicionar `cursor: grab` / `grabbing` no canvas |

## Phases

### Phase A — Refinos CSS-only (low risk, este sprint)

**Implementáveis sem touch no Sigma renderer.** Reversíveis em 1 commit.

1. Substituir radial-gradient do canvas por sólido escuro
2. Reduzir opacity/size dos edges no payload do client (`graph.addEdgeWithKey` para `explicit`)
3. Aumentar `labelRenderedSizeThreshold` no Sigma settings (labels só zoom alto)
4. Adicionar `cursor: grab` / `grabbing` durante pan

### Phase B — Custom Sigma program (medium risk)

5. Implementar `NodeGlowProgram` (extends Sigma `NodeProgram`) que renderiza halo radial WebGL per-node usando a cor do domínio. Substitui o trick atual de halo único pelo canvas inteiro.

6. `nodeReducer` que escala size em 1.2x quando hovered (já há infra de hover, falta o reducer).

### Phase C — Animações (lower priority)

7. Re-rodar mini-physics ao filtrar/pesquisar (Obsidian re-anima quando muda filtro). Atualmente layout é precomputado server-side e nunca move. Custom: rodar 100 iterações de FA2 client-side ao mudar filtro.

8. Time-lapse animation (Obsidian feature: ver crescimento do graph ordenado por `created_at`). Slider temporal.

## Non-goals

- Light mode (deferido — manter dark)
- 3D graph (TagsRoutes-style) — fora de escopo
- Mobile-specific layout
- Multi-vault / multi-user

## Open questions

1. **Background sólido `#0a0a0e` ou manter um gradiente sutil de marca?** O atual `--bg: #070a13` + radial é muito denso pra graph; mas zerar tudo perde a identidade Expert. Proposta: gradient apenas radial sutil `from #0a0a0e to #050507` sem cor lavender.

2. **Glow color = domain color ou neutro branco?** Obsidian usa branco neutro. Brain tem cores por domínio. Sugestão: glow neutro fraco (`rgba(255,255,255,0.15)`) + ring fino na cor do domínio. Hibrido.

3. **Quão alto o `labelRenderedSizeThreshold`?** Sigma default 6. Obsidian estima ~15. Tunar com Eric assistindo.

## Performance budget

- Phase A: zero perf impact (CSS).
- Phase B: custom NodeGlowProgram adiciona 1 fragment shader por nó. Em 1k nodes deve manter 60fps. Validar em 2k.
- Phase C: re-running FA2 client-side por 100 iter em 1k nodes ~ 200ms (web worker pra não bloquear).

## Tests

- `src/web/graph.test.ts` — payload shape inalterado
- Visual: usar Playwright + screenshot diff. **Pre-condição:** sessão autenticada (TODO: criar fixture de auth pra Playwright)
- Manual: Eric valida em prod após `wrangler deploy`

## Rollout

Phase A → merge to master → wrangler deploy → Eric valida visualmente → segue Phase B.
Cada phase é PR separado pra rollback fácil.
