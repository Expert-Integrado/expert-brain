# 72 — Onda 9b: caixas da home por manipulação direta (drag pra reordenar, borda pra redimensionar)

- **Status:** done
- **Data:** 08/07/2026
- **Origem:** feedback do dono sobre a Onda 9 (spec 71): "a função de editar as
  caixas tem que ser igual fizemos no ClickUp, e não do jeito que tá agora.. tem
  que poder clicar e arrastar as caixinhas". Referência de interação: home do
  ClickUp (cards com drag pra reordenar e resize direto, sem modal).

## O que morreu

O modal "Ajustar caixas" da spec 71 (botão no page-header + sliders + salvar) foi
REMOVIDO por inteiro — `renderHomePrefsModal`, `HOME_BOX_LABELS`, o CSS
`home-prefs-*` e o wiring `wirePrefs` do client. A persistência e os limites da
spec 71 continuam valendo; só a interface de edição mudou.

## Interação (padrão ClickUp)

- **Reordenar:** arrastar a caixa pelo TÍTULO (`h2.home-box-handle`, cursor grab).
  Threshold de 6px arma o drag (clique parado nos links do título continua
  navegando); um ghost clone (`.home-box-ghost`, position fixed, scale 1.02 +
  sombra) segue o ponteiro; o item original fica esmaecido (`.home-box-dragging`)
  e a grid REORGANIZA AO VIVO — `document.elementFromPoint` acha a caixa sob o
  ponteiro e o item entra antes/depois conforme a direção (compare de índice).
  Esc cancela e devolve o item pra posição de origem. `touch-action: none` na
  alça cobre touch com os mesmos Pointer Events.
- **Redimensionar:** alça na borda de baixo (`.home-resize`, cursor ns-resize,
  indicador visual no hover) — puxar aplica `--home-card-h` ao vivo no alvo
  `[data-home-box]`, clampado em `data-home-min/max` (220–960, SSR de
  home-prefs.ts — número único dos dois lados).
- **Persistência:** UMA chamada no fim do gesto (drop/soltar da borda):
  `POST /app/home/prefs { order, heights }`. `order` = filhos da `.home-grid` na
  ordem do DOM; `heights` só com o que difere do default (chave ausente =
  default). Toast SÓ no erro — sucesso é silencioso (o resultado já está na tela).
- **Hint:** `.home-arrange-hint` no page-header ("arraste pelo título pra
  reorganizar · puxe a borda de baixo pra redimensionar") no lugar do botão morto.

## Estrutura

- **Atividade virou filha da grid** (`grid-column: 1 / -1`) pra entrar na
  reordenação junto com os cards. O item reordenável leva `data-home-item`; o
  alvo de altura leva `data-home-box` (nos cards é o MESMO elemento; na
  Atividade o alvo é a `.home-activity-box` interna).
- `.home-grid > * { min-width: 0 }`: item de grid tem `min-width: auto` por
  default e o min-content do feed (chips nowrap) INFLAVA as tracks — a Atividade
  em span total estourava a página na horizontal (pego no QA de browser).
- **home-prefs.ts:** o estado salvo virou `{ heights, order }`
  (`HomePrefsState`). Sanitize do `order`: só chaves conhecidas, sem duplicata,
  faltantes completadas na ordem default (pref antiga nunca esconde caixa nova
  — mesma filosofia do drop de altura inválida). Digest ausente da página é
  simplesmente pulado na renderização; a chave continua válida na ordem.

## Testes

- `test/web/home-prefs.test.ts`: sanitize de order (desconhecida/duplicata/
  completação), heights+order juntos, SSR na ordem salva, alças/limites
  presentes, modal AUSENTE, shape persistido `{heights, order}`.
- `test/web/home.test.ts`: atributos `data-home-item/box/default/min/max` +
  alça no card.
- `e2e/home.spec.ts`: drag REAL com mouse (title → caixa vizinha) reordena ao
  vivo e persiste no reload; puxar a borda redimensiona 420→540 e persiste;
  limpeza via POST de reset entre specs.
- QA manual (Playwright MCP, wrangler dev): ghost/cursor/live-reorder, Esc
  restaura, link do título navega, resize dos dois tipos de alvo, mobile 390px
  sem overflow, zero erros de console.
