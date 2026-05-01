# Obsidian Graph View — Reverse Engineering

**Date:** 2026-05-01
**Source:** `obsidian.asar` (instalado em `%LOCALAPPDATA%\Programs\Obsidian\resources\`)
**Status:** Findings — não aplicado ao Brain ainda

## Stack

| Camada | Obsidian | Brain (atual) |
|---|---|---|
| Renderer | **PIXI.js** (WebGL 2D, low-level) | Sigma.js (WebGL graph-specific) |
| Layout | D3-force (cliente, anima) | graphology-forceatlas2 (servidor, estático + lerp animado client) |
| Labels | PIXI.Text | Sigma built-in (canvas) |

## Forces (defaults oficiais)

```js
{
  centerStrength: 0.1,   // slider 0..1
  repelStrength: 10,     // slider 0..50
  linkStrength: 1,       // slider 0..1
  linkDistance: 250      // slider 30..500
}
```

Brain hoje: ForceAtlas2 com `scalingRatio=18, gravity=0.5` (quase equivalente).

## Sizing (escala do nó)

PIXI render do nó:
```js
r.scale.x = r.scale.y = c/100 * f;
```
- `c` = node size (vem de degree/links)
- `f` = nodeScale global (slider 1..5)

→ Nó é desenhado com radius 1 e escalado por `c/100 * f`. Pra ter nó visualmente proporcional ao número de links, `c` cresce com degree.

## Linha (highlight ring no hover)

```js
E = Math.max(1, 1/scale/f);   // line width SEMPRE >=1px na tela, inverso ao zoom
o.lineStyle(E, M.rgb, 1);
o.drawCircle(0, 0, c + E/2);
```

**Insight crítico**: Obsidian linhas/anéis são **sempre 1px de tela**, não escalam com zoom. Se você dá zoom in, a linha NÃO engrossa. Sigma default escala a edge size com zoom — por isso nosso parece grosso quando dá zoom in.

## Cores oficiais (CSS vars no `app.css`)

```css
--graph-line:                var(--color-base-35, var(--background-modifier-border-focus));
--graph-node:                var(--text-muted);
--graph-node-unresolved:     var(--text-faint);
--graph-node-focused:        var(--text-accent);
--graph-node-tag:            var(--color-green);
--graph-node-attachment:     var(--color-yellow);
--graph-text:                var(--text-normal);
```

**Default do Obsidian: 3 cinzas + 2 acentos = 5 cores TOTAIS.**

| Tipo | Cor |
|---|---|
| nodes normais | cinza-claro (text-muted) |
| nodes não resolvidos (links quebrados) | cinza-fantasma (text-faint) |
| nó atualmente aberto | accent (laranja/azul/violeta — varia por tema) |
| tags | verde |
| attachments | amarelo |
| linhas | cinza médio |

Cores extras só via **groups** que o usuário CONFIGURA manualmente (grupos por query). O default é monocromático.

## Labels

```js
new PIXI.TextStyle({
  fontSize: 14 + c/4,    // base 14, +1 a cada 4 size units
  fill: e.colors.text.rgb,
  fontFamily: 'ui-sans-serif, ...',
  wordWrap: true,
  wordWrapWidth: 300,
  align: 'center',
})
```

**Posição**: `y = i + (c+5)*f + l/scale` — abaixo do nó, com offset 5px + gap dinâmico baseado em zoom.

**Visibilidade** (`textFadeMultiplier`):
- default = `0` → labels invisíveis até hover ou zoom alto
- usuário pode setar -1 a +1 via slider
- fórmula que vai aparecer: `Math.max((zoomScale-1) / 3.75, 0)` (de Quartz, mesma fórmula)

**Hover/active**:
- alpha do label hovered = 1.0
- `moveText` gradualmente desce mais 15px (b=15) quando hovered

## Highlight ring (efeito visual de hover)

Quando você passa mouse num nó:
```js
o.lineStyle(E, M.rgb, 1);   // linha (E=1px na tela)
o.drawCircle(0, 0, c + E/2); // anel ao redor do nó (radius = node + half line)
```
Não é glow blur — é **linha fina circular ao redor**. Mais sutil/clean.

E neighbors (vizinhos):
- Não-vizinhos têm `fadeAlpha → 0.3`
- Vizinhos mantêm `fadeAlpha = 1`
- Tween de ~200ms

## Slider limits do painel de Display

| Slider | Range |
|---|---|
| Node size | 1–5 |
| Font size | 0–24 |
| Line thickness | 1–5 |
| Forces | 0–1 (cada) |
| Link distance | 30–500 |

## Diferenças GAP do Brain hoje

| Item | Obsidian | Brain (após A.5) |
|---|---|---|
| Cores | 5 max (3 cinzas + 2 acentos) | **12 saturadas** ✗ |
| Linha width | 1px tela (constante) | escala com zoom ✗ |
| Highlight | anel fino ao redor | escala 1.4x + glow radial ✗ |
| Default node color | text-muted (cinza claro) | domain color saturado ✗ |
| Labels | textFadeMultiplier=0 (invisível default) | threshold=18 (ainda renderiza em zoom alto) ~ |
| Glow per-node | **não existe** | Adicionei (overlay 2D mix-blend screen) ✗ |
| Tween hover | 200ms suave | sem animação ✗ |

## Resposta ao feedback do Eric (01/05)

**1. "Muita cor, não faz sentido"** → Confirmado: Obsidian usa 5 cores, Brain força 12. Domain color como **destaque** (acento) deveria ser opcional, default ser cinza neutro com tom frio.

**2. "Linha grossa pra bolinha"** → Sigma default escala edge com zoom (Obsidian não). Solução: `edgeReducer` que ajusta `size` baseado em `camera.ratio` invertido. **Phase B**.

**3. "Bolinhas pequenas sumindo"** → Cor muted que apliquei na A.4 + cor saturada na A.5 fundindo com fundo escuro. Solução: usar **text-muted-equivalente cinza-claro** (#b8b8c8) como default, não cor por domínio. Cor por domínio só em **focused/hover** ou via grupos opcionais.

**4. "MCP Tools, Personal Finance — bolinhas escuras"** → Esses não são domínios canônicos da lista de 12 (`management|sales|marketing|education|ai-applied|leadership|product|operations|personal-development|entrepreneurship|music|cognitive-science`). Usaram fallback `#64748b` (cinza). Decisão: `update_note` pra normalizar OU adicionar à paleta canônica.

## Plano proposto (não aplicado)

### Phase A.6 — Monochromatic-by-default

1. Trocar default node color para `#b8b8c8` (cinza-claro frio, equivalente a `--text-muted` no tema dark do Obsidian)
2. Manter glow per-node mas com cor cinza-clara (não saturada por domínio)
3. **Domain color** opcional, ativado por toggle no overlay ("Cores: ON/OFF")
4. Removed/reset os 12 domain colors saturados do default

### Phase A.7 — Edges constantes na tela

5. `edgeReducer` que ajusta `attrs.size = 1.0 / camera.ratio` → linha sempre ~1px de tela
6. Hover com **anel fino** ao redor do nó (igual Obsidian) em vez de scale 1.4x
7. Remover o glow 2D mix-blend (substituir por anel fino)

### Phase A.8 — Animações

8. Tween 200ms em transitions de fadeAlpha (custom em vez de instantâneo do Sigma)
9. `moveText` 15px no hover

### Phase B — Pixi.js refactor (longo prazo)

Sigma.js tem limitações que Obsidian não tem (nodeProgram custom é trabalhoso). Pixi.js dá controle total. Trocar Sigma → Pixi seria refatoração de 2-3 dias. Só fazer se A.6/A.7/A.8 não bater visualmente.

## Conclusão

Eric pediu "fica igual Obsidian". O que falta é menos sobre **paleta** e mais sobre **comportamento visual**:
- Linha sempre 1px de tela (não escala)
- Default monocromático
- Hover = anel fino, não glow expandido
- Animações de 200ms

Phase A.6 + A.7 cobrem 80% do gap visual. Phase A.8 é polimento.
