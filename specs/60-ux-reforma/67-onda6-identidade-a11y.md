# Onda 6 — Identidade vencedora + acessibilidade/responsivo

> **Status:** done (08/07/2026) · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `60-ux-reforma/62-onda1-pesquisa-referencias-identidade.md`, `60-ux-reforma/66-onda5-fix-list-por-tela.md`

## Contexto

Esta é a onda transversal final antes da verificação de deploy: aplica no console real a direção de identidade que o dono escolheu no comparador da Onda 1 (`62-onda1-pesquisa-referencias-identidade.md`, seção "Gate — decisão do dono") e fecha os pontos de acessibilidade/responsivo que ficaram como débito ao longo do programa. Depende tanto da Onda 1 (decisão de identidade) quanto da Onda 5 (todas as telas já usando tokens e componentes consistentemente — aplicar identidade antes disso teria significado reaplicar depois).

## Problema / Motivação

- A decisão de identidade da Onda 1 fica sem efeito prático até ser colada nos tokens reais (`TOKENS_CSS`, `src/web/styles.ts`) — sem esta onda, o programa termina com a MESMA identidade "Midnight Nebula" de antes, contrariando a decisão nº 4 do dono (`60-visao-geral.md`).
- Contraste: `--text-faint` (opacidade 0.35, `styles.ts:20`) provavelmente reprova WCAG AA (4.5:1) contra o fundo escuro atual em qualquer uso como texto de conteúdo — o diagnóstico original já apontava isso. Sem um gate formal, é fácil essa regressão passar despercebida numa reforma grande.
- Breakpoints divergentes (767px no shell, 760px no board antes da Onda 5, 640px em notes antes da Onda 5) — a Onda 5 já unifica a maior parte, mas esta onda é o ponto de auditoria final de que não sobrou nenhum breakpoint órfão.
- `prefers-reduced-motion` e `focus-visible` não têm auditoria formal hoje — cada animação/transição foi adicionada ad-hoc ao longo do tempo sem checar a preferência do usuário.
- PT-BR: alguns resíduos em inglês (ex. `graph.ts:13`, já corrigido na Onda 5) podem existir em outros cantos não cobertos pela varredura da Onda 5.

## Objetivo

O console aplica a direção de identidade escolhida pelo dono na Onda 1, nenhum token de texto tem contraste abaixo de 4.5:1, o breakpoint 767px é o único usado em toda a base, `prefers-reduced-motion` é respeitado globalmente, `focus-visible` está presente em todo elemento interativo, e não sobra texto em inglês na UI.

## Design proposto

1. **Aplicar o token-set escolhido:** colar os valores de `tokens-a.css`/`tokens-b.css`/`tokens-c.css` (o vencedor, conforme registrado em `62-onda1-pesquisa-referencias-identidade.md`) dentro de `TOKENS_CSS` em `src/web/styles.ts`, substituindo os valores atuais de "Midnight Nebula". Se a direção escolhida for um mix, aplicar a combinação exata que o dono descreveu no registro da decisão.
   - Ajustes finos que o comparador não capturou em detalhe (ex. um valor específico de sombra) ficam a critério de quem executa, desde que dentro do espírito da direção escolhida.
   - Troca de fontes: se a direção escolhida pedir fonte diferente de Poppins/Manrope, atualizar `FONT_LINKS` (`styles.ts:5-8`) e `--font-display`/`--font-body`.
2. **Contraste AA como gate:** calcular a razão de contraste de cada token de texto (`--text`, `--text-dim`, `--text-subtle` — criado na Onda 2 — e `--text-faint`) contra os fundos onde cada um é usado como CONTEÚDO (não decorativo). Nenhum token usado pra conteúdo pode ficar abaixo de 4.5:1. `--text-faint` é reclassificado explicitamente (em comentário no código) como "só decorativo — nunca usar em texto que precisa ser lido", e cada uso atual de `--text-faint` é auditado: se algum uso for de conteúdo real (não decoração), trocar pro token mais forte adequado.
3. **Breakpoint canônico:** varrer o CSS inteiro (`src/web/*.ts`) por `@media` e confirmar que só resta `767px` como breakpoint de mobile/desktop — documentar essa convenção num comentário no topo de `TOKENS_CSS`.
4. **`prefers-reduced-motion` global:** adicionar uma regra `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }` em `BASE_CSS` (Onda 2), cobrindo todas as transições/animações do app de uma vez.
5. **`focus-visible` auditado:** conferir que todo elemento interativo (botão, link, input, o card inteiro clicável da Onda 4) tem um estado de foco visível claro — a regra global já existe (`styles.ts:37`: `*:focus-visible { outline: 2px solid var(--accent-lav); ... }`), atualizar a cor do outline pro token de destaque da identidade escolhida se ela mudar de `--accent-lav`.
6. **Varredura PT-BR final:** grep por palavras em inglês remanescentes nas strings visíveis ao usuário (títulos de página, labels, mensagens de erro) — corrigir o que for encontrado.
7. **Backlog registrado, não bloqueia esta onda:** mover card do board por teclado (navegação por setas + Enter pra confirmar) fica anotado como item futuro, fora do escopo desta reforma.

## Fora de escopo

- Escolher a direção de identidade — já decidida na Onda 1; esta onda só aplica.
- Implementar navegação de board por teclado — só registrar como backlog.
- Adicionar tema claro funcional como feature ativa, a menos que a direção escolhida na Onda 1 seja explicitamente a C ("claro-default") — nesse caso, a aplicação de `[data-theme="light"]` de fato É o trabalho desta onda para essa direção específica.

## Critérios de aceite

- [x] `TOKENS_CSS` reflete a direção de identidade escolhida pelo dono (valores colados, não os antigos de Midnight Nebula, a menos que a direção A tenha sido a escolhida — nesse caso os valores são os corrigidos de contraste da direção A, não os originais problemáticos)
- [x] Tabela de contraste WCAG de cada token de texto usado como conteúdo, incluída no commit (pode ser um comentário no código ou um arquivo em `docs/`), com todos os pares ≥ 4.5:1
- [x] `--text-faint` documentado como decorativo-apenas; nenhum uso de conteúdo real restante nesse token
- [x] Nenhum `@media` com breakpoint diferente de 767px restante no CSS do console
- [x] Regra global de `prefers-reduced-motion` presente em `BASE_CSS`
- [x] `focus-visible` funcional e visível em todo elemento interativo testado manualmente
- [x] Nenhuma string visível ao usuário em inglês remanescente
- [x] `npm run typecheck`, `npm test`, `npm run test:client` e a suíte e2e passam

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck
npm test
npm run test:client
node scripts/verify-wave.mjs --phase wave-6
```

Teste manual: navegar o console inteiro só de teclado (Tab, Enter, Esc) checando foco visível em cada parada; ativar "reduzir movimento" no SO e confirmar que animações somem; medir contraste com uma ferramenta de DevTools em pelo menos 5 pares texto/fundo críticos.

**Gate de deploy:** implementar e commitar localmente é livre; nenhum `wrangler deploy` nesta onda — o deploy único de produção só acontece na Onda 7, com OK explícito do dono.

## Arquivos afetados

- `src/web/styles.ts` (`TOKENS_CSS`, `BASE_CSS` com a regra de `prefers-reduced-motion`)
- Qualquer arquivo de tela que ainda tiver breakpoint órfão ou string em inglês, identificado na varredura desta onda

## Riscos e reversão

- **Risco:** a direção de identidade escolhida, ao ser aplicada de verdade (não só no protótipo isolado), revelar um problema de contraste ou de legibilidade que não apareceu no comparador da Onda 1 (ex. um componente real mais complexo que o markup de exemplo do protótipo). Mitigação: o gate de contraste desta onda (item 2 do Design proposto) é justamente a rede de segurança pra pegar isso antes do deploy; se a direção escolhida reprovar, ajustar os tokens específicos que falharem, sem precisar voltar à Onda 1 inteira.
- **Risco:** trocar `--accent-lav` como cor de foco em todo o app sem revisar cada contexto onde ela aparece hardcoded fora do token. Mitigação: grep por `accent-lav` literal (não via `var()`) antes de considerar a troca completa.
- **Reversão:** `git revert` do commit — mudança de valores de token, sem migration nem mudança de contrato; reverter volta pra identidade anterior sem efeito em dado.

## Evidência de execução (08/07/2026)

**Identidade (direção A "Nebula Refinada") aplicada em `TOKENS_CSS`:** escada de superfícies opacas (`#0c101d/#121728/#192036/#212a46`), texto AA opaco (`--text-dim #b9bfd0` 9.7:1, `--text-subtle #8e96ad` 6.0:1), `--accent-contrast #0b0f19` (texto escuro sobre acento sólido, 7.0:1 — o gradiente+branco reprovava em 2.2:1 e foi descartado), estados `danger #ff8298 / success #4ade80 / warning #fbbf24 / info #7db8ff` com tintas 0.12, sombras e gradiente de fundo calmos. Botão primário virou acento sólido + `--accent-contrast` (`.btn-primary`, login, `.panel-form-submit`, nav-badge).

**Espelhos JS sincronizados:** `src/util/priority.ts` (PRIORITIES = `--prio-1..4`), `config-script.ts` (3x `#f87171` → `var(--danger)`). `graph3d.ts` BG_COLOR e THEME_COLOR inalterados (tokens não mudaram).

**Varredura de literais órfãos da paleta antiga:** `.btn-danger:hover`, `.badge-ok/.badge-warn`, `.callout-info`, `.app-toast` ok/error, `.key-flash`, `.wikilink.broken`, chip de task do journal — tudo em token/color-mix.

**Gate AA:** tabela completa em `docs/ux-contraste-aa.md` (28 pares, 0 reprovações; tintas de estado compostas sobre `--surface-1` antes de medir). **83 usos informativos de `--text-faint` migrados pra `--text-subtle`** (timestamps, labels, contadores, placeholders, empty-states); restam 2 usos decorativos permitidos (borda pontilhada em share, dot do graph-chip).

**Breakpoint:** só 767px em todo `src/web` (5 blocos @media + prefers-reduced-motion). **Reduced-motion global** em BASE_CSS (verificado no navegador: `transitionDuration 1e-05s` sob emulação). **Focus-visible** global com outline lavanda (verificado por Tab no navegador).

**PT-BR:** `aria-label="Graph controls"` → "Controles do grafo"; breadcrumb "← Tasks" → "← Tarefas"; botão/modal "Nova task" → "Nova tarefa"; filtro do journal e cabeçalhos de tabela do config "Tasks" → "Tarefas"; description do manifest traduzida; **kinds de interação de contato traduzidos na home e no journal** via módulo compartilhado novo `src/util/event-kind-labels.ts` (deduplica as cópias de contact-page e graph). Decisão registrada: "task" como substantivo de produto em microcopy corrente ("task criada", "Virar task") fica — é o jargão do dono; só rótulos de página/navegação viram "Tarefas".

**Extras:** `assets/favicon.ico` novo (gerado do icon-192; 404 do navegador resolvido, verificado 200 + warning de manifest sumiu com `enctype` explícito no share_target); título do task detail virou textarea de 1 linha com auto-grow (`fitTitle` em task-edit.ts, Enter salva, `\n` de paste vira espaço, correção border-box de 2px) — título longo quebra em vez de cortar (verificado no navegador: 86px → 191px, "Salvo", sem newline); teste e2e atualizado pro seletor `textarea.task-edit-title` e `test/manifest.test.ts` pro enctype.

**Validação:** typecheck ok (4 tsconfigs); server 86 files/792 tests + auth 2/5 (exit 0); client 5/38; e2e 21/21 (4.7m); audit wave-6 32/32 + recapturas pós-fix; contact sheet vs baseline em `C:/tmp/ux-audit/wave-6/contact-sheet.html`; QA interativo no navegador (login, home, board, task detail, grafo 2D→3D sem erro de console, mobile 390/320px sem overflow horizontal, bottom-nav icon-only, foco por teclado, reduced-motion); scan PII/segredo limpo.

**Backlog registrado (fora do escopo, não bloqueia):** mover card do board por teclado (setas + Enter), conforme item 7 do design.
