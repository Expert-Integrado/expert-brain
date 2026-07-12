# Gate de contraste AA — tokens Nebula Refinada (direção A)

> Spec: `specs/60-ux-reforma/67-onda6-identidade-a11y.md` · Fonte dos tokens: `src/web/styles.ts` (TOKENS_CSS) e `prototypes/identity/tokens-a.css`.
> Razões computadas com a fórmula de luminância relativa WCAG 2.1 (script auditável em anexo no fim). Gate: nenhum token de **texto informativo** abaixo de 4.5:1 (3:1 para elementos gráficos/large text).

## Tabela de contraste (08/07/2026)

| Par (fg sobre bg) | Razão | Veredito | Uso |
| --- | --- | --- | --- |
| `--text` sobre `--bg` | 18.9:1 | AA | texto principal |
| `--text-dim` sobre `--bg` | 10.8:1 | AA | texto secundário |
| `--text-subtle` sobre `--bg` | 6.7:1 | AA | texto terciário |
| `--text` sobre `--surface-0` | 18.1:1 | AA | |
| `--text-dim` sobre `--surface-0` | 10.3:1 | AA | |
| `--text-subtle` sobre `--surface-0` | 6.4:1 | AA | |
| `--text` sobre `--surface-1` | 17.0:1 | AA | |
| `--text-dim` sobre `--surface-1` | 9.7:1 | AA | |
| `--text-subtle` sobre `--surface-1` | 6.0:1 | AA | labels, timestamps, contadores |
| `--text` sobre `--surface-2` | 15.4:1 | AA | |
| `--text-dim` sobre `--surface-2` | 8.8:1 | AA | |
| `--text-subtle` sobre `--surface-2` | 5.5:1 | AA | |
| `--text` sobre `--surface-3` | 13.5:1 | AA | |
| `--text-dim` sobre `--surface-3` | 7.7:1 | AA | |
| `--text-subtle` sobre `--surface-3` | 4.8:1 | AA | topo da escada de superfícies |
| `--accent-contrast` sobre `--accent-lav` | 7.0:1 | AA | botão primário, nav-badge |
| `--accent-lav` sobre `--surface-1` | 6.5:1 | AA | links, títulos de destaque |
| `--accent-cyan` sobre `--surface-1` | 12.0:1 | AA | chip de task no journal |
| `--danger` sobre `--surface-1` | 7.5:1 | AA | erros, botão danger |
| `--danger` sobre tinta `--danger-bg` | 6.3:1 | AA | badge/botão de estado |
| `--success` sobre `--surface-1` | 10.2:1 | AA | confirmações, key-flash |
| `--success` sobre tinta `--success-bg` | 8.1:1 | AA | badge/botão de estado |
| `--warning` sobre `--surface-1` | 10.7:1 | AA | avisos |
| `--warning` sobre tinta `--warning-bg` | 8.4:1 | AA | badge/botão de estado |
| `--info` sobre `--surface-1` | 8.6:1 | AA | informativos |
| `--info` sobre tinta `--info-bg` | 6.9:1 | AA | badge/botão de estado |
| `--prio-4` sobre `--surface-1` | 7.0:1 | AA | bandeirinha prio Baixa |
| `--text-faint` (α 0.34) sobre `--surface-1` | 3.0:1 | DECORATIVO | ver regra abaixo |

**Resultado do gate: 0 reprovações em pares informativos.**

Notas de composição: as tintas de estado (`--*-bg`, α 0.12) foram compostas sobre `--surface-1` antes de medir — é o pior caso real (badge dentro de card). O botão primário usa `--accent` sólido + `--accent-contrast` (gradiente + texto branco reprovava em 2.2:1 e foi descartado na direção A).

## Regra do `--text-faint`

`--text-faint` (3.0:1) é **exclusivamente decorativo**: divisores, ornamentos, dots de chip, bordas pontilhadas. **Nunca** em texto informativo (timestamps, labels, contadores, placeholders, empty-states) — pra isso existe `--text-subtle` (6.0:1 AA sobre `--surface-1`).

Na Onda 6 (08/07/2026), 83 usos informativos de `--text-faint` foram migrados pra `--text-subtle`. Usos decorativos remanescentes (permitidos): `share.ts` borda pontilhada de wikilink quebrado; `styles.ts` background do dot de `.graph-chip`.

## Tabela de contraste — cartela CLARA `[data-theme="light"]` (12/07/2026, spec 91/96)

Mesma fórmula e mesmo gate. Superfícies claras: `--bg #f6f7fb`, `--surface-0 #ffffff`,
`--surface-1 #f4f5fb`, `--surface-2 #e9ebf5`, `--surface-3 #dfe3f0`.

| Par (fg sobre bg) | Razão | Veredito | Uso |
| --- | --- | --- | --- |
| `--text #171c2e` sobre `--bg` | 15.8:1 | AA | texto principal |
| `--text-dim #454e66` sobre `--surface-1` | 7.6:1 | AA | texto secundário |
| `--text-subtle #5a6480` sobre `--surface-1` | 5.4:1 | AA | terciário (4.6:1 até no topo `--surface-3`) |
| `--accent-contrast #ffffff` sobre `--accent-lav #6d28d9` | 7.1:1 | AA | botão primário |
| `--accent-lav #6d28d9` sobre `--surface-1` | 6.5:1 | AA | links, destaques |
| `--accent-cyan #0f766e` sobre `--surface-1` | 5.0:1 | AA | chips |
| `--danger #be123c` sobre `--surface-1` / tinta α0.10 | 5.8:1 / 4.9:1 | AA | erros, badges |
| `--success #166534` sobre `--surface-1` / tinta | 6.6:1 / 5.7:1 | AA | confirmações |
| `--warning #854d0e` sobre `--surface-1` / tinta | 6.3:1 / 5.4:1 | AA | avisos |
| `--info #1d4ed8` sobre `--surface-1` / tinta α0.08 | 6.2:1 / 5.3:1 | AA | informativos |
| `--prio-4 #475569` sobre `--surface-1` | 7.0:1 | AA | bandeirinha Baixa |
| `--accent-pink #a21caf` sobre `--surface-1` | 5.8:1 | AA | acentos |

**Resultado do gate claro: 0 reprovações em pares informativos.** Os acentos do dark
(`#a78bfa`, `#5eead4`, `#ff8298`...) reprovam sobre superfícies claras — por isso a
cartela clara escurece acentos e estados (violet-700, teal-700, rose-700 etc.).

## Espelhos JS (canvas/WebGL não leem custom property)

| Token | Espelho | Valor |
| --- | --- | --- |
| `--prio-1..4` | `src/util/priority.ts` (PRIORITIES) | `var(--prio-N)` — desde a spec 96 a cor É a custom property (os consumers injetam em SVG inline no DOM, que resolve var e acompanha o tema) |
| `--surface-canvas` | `src/web/client/graph3d.ts` (BG_COLOR) | resolvido via `getComputedStyle` no runtime (fallback `#0c0c10`) |
| `--bg` | `src/web/styles.ts` (THEME_COLOR `#070a13` / THEME_COLOR_LIGHT `#f6f7fb`) | metas `theme-color`; o shell troca em runtime |

Mudou token na tabela acima = atualizar o espelho no mesmo commit.

## Como reproduzir o gate

Script Python sem dependências (fórmula WCAG 2.1):

```python
def srgb_to_lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def lum(rgb):
    r, g, b = rgb
    return 0.2126 * srgb_to_lin(r) + 0.7152 * srgb_to_lin(g) + 0.0722 * srgb_to_lin(b)

def ratio(fg, bg):
    l1, l2 = sorted((lum(fg), lum(bg)), reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)

# tintas α sobre superfície: composite(fg, a, bg) = fg*a + bg*(1-a) por canal
```

Rodar contra os valores hex de `TOKENS_CSS` sempre que a paleta mudar; qualquer par informativo < 4.5:1 bloqueia o merge.
