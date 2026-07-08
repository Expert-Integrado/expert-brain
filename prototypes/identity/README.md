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

## Decisão do dono (07/07/2026)

**Direção A (Nebula Refinada), validada no comparador revisado**, com 3 ajustes decididos
no gate: navegação Início → Inbox → Grafo → Notas → Tarefas → Contatos; Configurações no
rodapé da sidebar junto do bloco do usuário (redesenhado); cards no padrão ClickUp (título
primeiro com clamp de 2 linhas, breadcrumb de projeto, uma linha de meta, UMA linha de tags
sem wrap). Heranças explícitas: da B, a disciplina de cor (saturação só em semântica); da C,
a arquitetura de tokens que deixa o tema claro plugável depois. Registro operacional:
`specs/60-ux-reforma/62` e `66`.

## Pesquisa web — padrões levantados (5 categorias da spec 62)

Notas de pesquisa em material público (docs/marketing das ferramentas + literatura de UX).
Sem captura de conta logada de terceiros; o ClickUp real do dono fica fora do repo.

### 1. Kanban / drag-and-drop

- Tríade canônica: elemento arrastável + drop zone + feedback visual contínuo. O arrastável
  anuncia que é arrastável (cursor grab, lift no hover); a drop zone responde ao hover com
  tinta sutil + borda — nunca preenchimento chapado (é exatamente o bug do nosso board hoje).
- Indicador de posição de drop explícito > adivinhar onde cai. No nosso caso (ordem vem do
  servidor), o indicador honesto é a COLUNA-alvo destacada, não uma linha de inserção falsa.
- Placeholder na origem com a mesma altura do card evita a coluna "pular" durante o drag.
- Touch: alvos maiores, long-press pra armar o drag (distinguir de scroll) e alternativa por
  teclado/menu registrada como backlog de a11y — tudo já contemplado na Onda 4 (spec 65).
- Fontes: [MDN Kanban DnD](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/Kanban_board),
  [LogRocket — DnD patterns](https://blog.logrocket.com/ux-design/drag-and-drop-ui-examples/),
  [uxpatterns.dev — drag-and-drop](https://uxpatterns.dev/patterns/content-management/drag-and-drop),
  [SubUX — accessible DnD](https://subux.pro/guides/article/accessible-drag-and-drop).

### 2. Task detail

- Padrão dominante (ClickUp, Asana, Linear): corpo principal (título, descrição, comentários)
  + painel direito de metadados/propriedades, com divisor. Metadados agrupados por natureza
  (status/prio/due juntos; relações e integrações abaixo). Nosso detalhe já segue o esqueleto;
  a Onda 5 alinha hierarquia e o seletor de visibilidade entra nessa sidebar (Onda 4).
- Fontes: [ClickUp — task layouts](https://help.clickup.com/hc/en-us/articles/29665520762647-Task-layouts),
  [Asana — task details pane](https://help.asana.com/s/article/navigating-asana?language=en_US).

### 3. Home / dashboard

- "Acima da dobra" nos produtos de planejamento diário: o dia de hoje (tasks com due),
  capacidade/quantidade, e captura rápida — não métricas frias. Sunsama é a referência de
  "revisão calma do dia"; Todoist Today é o contraexemplo (lista chapada sem orientação).
  Nossa home já tem os cards certos (Pra hoje, Ressurgindo, Interações, Captura); a Onda 5
  conserta integridade (erro visível, skeleton, grid).
- Fontes: [Sunsama](https://www.sunsama.com/), [Ellie — Sunsama vs Todoist](https://ellieplanner.com/comparisons/sunsama-vs-todoist).

### 4. Visibilidade / compartilhamento

- Notion: página privada por default; "Share to web" é um TOGGLE explícito com URL única e
  sub-opções progressivas (expiração, indexação, permissões) reveladas só depois de ligar.
  A lição de microcopy: o estado descreve QUEM VÊ ("visível só pra você", "qualquer pessoa
  com o link"), nunca um adjetivo ambíguo como "pública" — que é exatamente o erro de
  linguagem do nosso console (diagnóstico item 3). Valida o desenho da Onda 4: seletor único
  de 3 níveis com microcopy de audiência + sub-painel do link só no nível 3.
- Fontes: [Notion — sharing & permissions](https://www.notion.com/help/sharing-and-permissions),
  [Notion — understanding sharing settings](https://www.notion.com/help/guides/understanding-notions-sharing-settings).

### 5. Dark themes de qualidade

- Elevação por CLAREZA da superfície (mais alto = mais claro), não por sombra — é a escada
  --surface-0..3 da direção A. Material recomenda cinza escuro (#121212), nunca preto puro;
  nem branco puro sobre escuro (vibração/fadiga).
- Cores SATURADAS sobre fundo escuro vibram e reprovam AA — dessaturar acentos e estados
  (a direção A já rebaixou os acentos; a disciplina herdada da B aponta o mesmo).
- AA 4.5:1 vale em TODAS as elevações, não só no fundo base — por isso a tabela de contraste
  acima mede sobre a superfície de card, não sobre o body.
- Fontes: [Material — dark theme](https://m2.material.io/design/color/dark-theme.html),
  [Toptal — dark UI principles](https://www.toptal.com/designers/ui/dark-ui-design),
  [fourzerothree — scalable accessible dark theme](https://www.fourzerothree.in/p/scalable-accessible-dark-mode).

## Restrições

- Dados 100% fictícios (Ana Almeida, Bruno Castro, Empresa Exemplo Ltda) — repo público.
- Nenhum arquivo daqui é servido pelo worker; protótipo é artefato de decisão, não código de produção.
- A direção escolhida vira o token-set aplicado na Onda 6 (specs/67); Ondas 2-5 são neutras de identidade.
