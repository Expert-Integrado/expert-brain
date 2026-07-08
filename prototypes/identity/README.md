# Protótipos de identidade — Onda 1 (specs/60-ux-reforma/62)

Três direções de identidade visual pro console, todas sobre o **mesmo markup**
(`shared/board.html`, `shared/home.html`) e a **mesma biblioteca de componentes**
(`shared/base.css`) — só o arquivo de tokens muda. É exatamente o mecanismo que a
Onda 2 (specs/63) implementa em produção: `base.css` consome só custom properties,
e cada `tokens-*.css` declara o mesmo contrato (documentado no topo do `base.css`).

## Como ver

Abrir `index.html` no browser (duplo clique serve — é tudo estático). O toggle
Board/Início troca a tela nos três iframes ao mesmo tempo. Também dá pra abrir uma
direção isolada: `shared/board.html?t=a|b|c`.

## As direções

| | Nome | Tese | Fontes | Densidade |
|---|---|---|---|---|
| A | Nebula Refinada | Evoluir o Midnight Nebula atual: manter identidade, consertar contraste e hierarquia de superfícies | Poppins + Manrope | 1.0 |
| B | Grafite Denso | Estilo Linear: quase-monocromático, cor só pra semântica, mais conteúdo por tela | Sistema | 0.9 |
| C | Claro ClickUp | Tema claro default, provando que o contrato de tokens re-tematiza de verdade | Poppins + Manrope | 1.0 |

## Critérios de avaliação (pro dono decidir)

1. **Legibilidade** — contraste WCAG medido (node, fórmula de luminância relativa):

   | Par (sobre superfície de card) | A | B | C | Gate |
   |---|---|---|---|---|
   | Texto primário | 17.03 | 14.72 | 16.05 | ≥ 4.5 |
   | Texto secundário (--text-dim) | 9.69 | 7.70 | 8.04 | ≥ 4.5 |
   | Texto terciário (--text-subtle) | 6.04 | 5.25 | 5.12 | ≥ 4.5 |
   | Acento (links/ações) | 6.55 | 5.88 | 5.54 | ≥ 4.5 |
   | Danger (vencida) | 7.55 | 7.07 | 5.60 | ≥ 4.5 |

   `--text-faint` é decorativo por contrato nas três (nunca texto informativo).
2. **Hierarquia** — "ache a task urgente em 3s" no board de cada direção.
3. **Personalidade** — qual parece o Expert Brain, não um template.
4. **Viabilidade de tema claro** — C prova o mecanismo; A e B ganham tema claro depois via token-set novo, sem reforma.
5. **Fadiga** — 14h/dia de uso: gradiente e brilho contam contra; contraste baixo também.

## Restrições

- Dados 100% fictícios (Ana Almeida, Bruno Castro, Empresa Exemplo Ltda) — repo público.
- Nenhum arquivo daqui é servido pelo worker; protótipo é artefato de decisão, não código de produção.
- A direção escolhida vira o token-set aplicado na Onda 6 (specs/67); Ondas 2-5 são neutras de identidade.
