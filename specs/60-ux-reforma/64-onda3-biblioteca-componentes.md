# Onda 3 — Biblioteca de componentes

> **Status:** done (08/07/2026) · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `60-ux-reforma/63-onda2-tokens-retematizaveis.md`
>
> **Evidência de conclusão:** `COMPONENTS_CSS` preenchida com toda a biblioteca do objetivo
> (card/btn/chip/estados/form/modal/banner-info), consumindo só tokens da Onda 2 (+ novo
> `--input-bg`). Duas decisões de execução documentadas no "Design proposto" abaixo:
> (1) ordem de cascata ajustada pra `TOKENS + BASE + SHELL + COMPONENTS + SURFACES` — o
> COMPONENTS antes do SHELL faria `.main h2` (shell) vencer `.card h2` (componente) em
> especificidade igual quando a Onda 5 remover duplicatas; (2) `.btn-primary`/`.btn-danger`/
> `.input-text` JÁ existiam no CSS da página config com esses nomes — a biblioteca coexiste
> com especificidade nivelada (hover sem `:not(:disabled)`) e a página continua vencendo
> empates até a Onda 5 remover as versões locais. `task-badges.ts` intocado.
> Validação: typecheck, 791+5 server, 12 client, harness 32/32 wave-3 com pixel-diff vs
> baseline — diffs só de timestamp relativo (reseed cruzou a meia-noite) e grafo; zero
> regressão visual.

## Contexto

A Onda 2 criou a constante `COMPONENTS_CSS` em `src/web/styles.ts` como placeholder. Esta onda preenche essa constante com uma biblioteca real de componentes reutilizáveis, absorvendo variações que hoje estão duplicadas pelo código.

Estado hoje (diagnóstico de `60-visao-geral.md`, item 6): botões com ~10 variantes divergentes espalhadas pelas páginas, chips com pelo menos 2 definições divergentes de `.task-tag-chip` (uma em `src/util/task-badges.ts` que gera o HTML, outra em CSS específico de página que estiliza — checar ambas antes de unificar), 9 empty-states construídos ad-hoc (um por tela, sem componente comum). Classes já asseridas em teste e que NÃO podem ser renomeadas nesta onda (confirmado por uso ativo no código): `task-project-chip` (gerada por `projectChipHtml()` em `src/util/task-badges.ts:29-39`), `task-tag-chip` (gerada por `tagChipsHtml()` em `src/util/task-badges.ts:17-24`), `task-detail-sidebar`, `nav-badge`.

## Problema / Motivação

- Botões: variantes visuais divergentes (`.task-btn`, `.task-d-btn`, `.note-edit-copy`, `.sidebar-toggle`, `.sidebar-logout`, etc. — nomes reais a levantar por grep de `class="[a-z-]*btn` e afins durante a execução) sem uma hierarquia clara de primary/secondary/ghost/danger.
- Chips: `src/util/task-badges.ts` já centraliza a GERAÇÃO de HTML de chip de tag e de projeto (`tagChipsHtml`, `projectChipHtml`, ambos com escape próprio — comentário no topo do arquivo explica que é self-contido de propósito pra servir tanto o SSR quanto o bundle client sem depender do `esc()` de nenhum dos dois lados), mas o ESTILO desses chips (`.task-tag-chip`, `.task-project-chip`) está definido em CSS de página (`src/web/tasks.ts`), não na biblioteca global — nova entrada duplicaria se alguma outra tela (ex. contatos) quiser um chip parecido.
- Empty-states, skeletons e estados de erro: cada tela resolve à sua maneira hoje (ex. `home.ts` já tem um padrão de "esconder card inteiro no erro" que a Onda 5 vai trocar por um `.error-state` visível — mas o COMPONENTE `.error-state` precisa existir ANTES, construído aqui).
- Modais: `task-modal` (criação de task, `src/web/client/tasks.ts` referencia `#task-create-modal`) e a paleta de comando (Ctrl+K, `src/web/client/shell.ts`) implementam modal cada um à sua maneira, sem um `.modal` genérico compartilhado.
- Banner "Novidades": hoje usa `style` inline (contrariando a política de CSP e de token) em vez de uma classe `.banner-info` reutilizável.

## Objetivo

`COMPONENTS_CSS` (em `src/web/styles.ts`) contém `.card`/`.card--interactive`, a hierarquia `.btn`/`.btn-primary`/`.btn-secondary`/`.btn-ghost`/`.btn-danger`/`.btn-sm`, o sistema `.chip` com modificadores, `.empty-state`/`.skeleton`/`.error-state`, `.field`/`.input`/`.textarea`/`.select`, `.modal` genérico e `.banner-info` — todos usando os tokens da Onda 2 (`--space-*`, `--text-*`, cores semânticas) — sem renomear nenhuma das 4 classes protegidas por teste.

## Design proposto

Tudo aditivo dentro de `COMPONENTS_CSS`:

1. **`.card` / `.card--interactive`**: canônico, absorvendo o padrão visual que `.card.home-card` já usa hoje em `home.ts` (fundo `--surface-1`, raio `--radius`, padding em `--space-*`). `.card--interactive` adiciona hover-lift pra cards clicáveis (ex. cartão de task, quando a Onda 4 tornar o card inteiro clicável).
2. **Hierarquia `.btn`**: `.btn` base + `.btn-primary`/`.btn-secondary`/`.btn-ghost`/`.btn-danger`/`.btn-sm`. Cada botão existente no código (`.task-btn`, `.task-d-btn`, `.note-edit-copy`, etc.) recebe uma CO-CLASSE da nova hierarquia (ex. `class="task-btn btn btn-sm"`) em vez de ser renomeado — absorve visualmente sem quebrar seletores JS que dependem do nome antigo (ex. `client/tasks.ts` seleciona `.task-btn.task-complete` por classe — isso continua funcionando, só ganha uma classe extra de estilo).
3. **Sistema `.chip`**: `.chip` base + modificadores `--tag`/`--project`/`--prio`/`--due`/`--privacy`/`--status`/`--kind`. A mecânica de `--chip` inline (variável CSS custom usada pra cor dinâmica, ex. `style="--chip: ${color}"`, padrão já em uso conforme spec `50-console-v2/54-taxonomia-configuravel-areas-e-kinds.md`) fica INTOCADA — o sistema novo é aditivo, absorvendo `.task-tag-chip` e `.task-project-chip` como aliases/co-classes, não substituições. Reconferir contra `src/util/task-badges.ts:17-39` antes de tocar no estilo.
4. **`.empty-state` / `.skeleton` / `.error-state`**: os 9 empty-states ad-hoc (levantar a lista exata via grep de `home-empty`, `task-col-empty` e padrões similares durante a execução) passam a usar `.empty-state` como classe base, com a classe específica de cada tela mantida como modificador (ex. `class="home-empty empty-state"`) — o alias evita quebrar qualquer seletor JS ou teste que dependa do nome antigo.
5. **`.field` / `.input` / `.textarea` / `.select`**: consolidam `--input-bg` num único token, eliminando as variações de fundo de input espalhadas pelas páginas.
6. **`.modal` genérico**: `#task-create-modal` (`client/tasks.ts`) e a paleta de comando (`client/shell.ts`) passam a consumir a mesma estrutura CSS de modal (overlay + dialog + close), sem duplicar a mecânica de abrir/fechar em JS (que continua específica de cada um).
7. **`.banner-info`**: o banner de "Novidades" sai de `style` inline pra essa classe.

## Fora de escopo

- Renomear `task-project-chip`, `task-tag-chip`, `task-detail-sidebar` ou `nav-badge` — essas 4 classes são absorvidas via co-classe/alias, nunca renomeadas.
- Aplicar os componentes novos em TODAS as telas — isso é trabalho da Onda 5 (`66-onda5-fix-list-por-tela.md`), tela a tela. Esta onda só CONSTRÓI a biblioteca em `COMPONENTS_CSS`.
- Mudar a mecânica JS de nenhum modal ou dropdown — só o CSS visual.
- Resolver os bugs de interação (drag, clique, seletor de visibilidade) — isso é a Onda 4.

## Critérios de aceite

- [x] `COMPONENTS_CSS` em `src/web/styles.ts` contém `.card`/`.card--interactive`, hierarquia `.btn-*`, sistema `.chip` + modificadores (`--tag`/`--project`/`--prio-1..4`/`--due`(+`.overdue`)/`--privacy`/`--status`/`--kind`, cor dinâmica via `--chip`), `.empty-state`/`.skeleton`/`.error-state`, `.field`/`.input`/`.textarea`/`.select` (com `--input-bg`), `.modal`, `.banner-info`
- [x] `task-project-chip`, `task-tag-chip`, `task-detail-sidebar`, `nav-badge` continuam existindo com o mesmo nome literal em todo o código e em todos os testes que os asseram
- [x] `src/util/task-badges.ts` não precisou ser alterado nesta onda
- [x] Todos os testes que passam hoje continuam passando sem alteração de asserção de classe (791+5 server, 12 client, zero edição de teste)
- [x] Nenhuma mudança visual perceptível (pixel-diff wave-3 vs baseline: diffs só de timestamp e grafo não-determinístico)

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck
npm test
npm run test:client
node scripts/verify-wave.mjs --phase wave-3
```

Teste manual: nenhuma tela deve parecer visualmente diferente ainda (a biblioteca existe mas não foi aplicada em lugar nenhum além do necessário pra não quebrar nada existente) — comparar contra o contact sheet da Onda 0.

**Gate de deploy:** implementar e commitar localmente é livre; nenhum deploy nesta onda.

## Arquivos afetados

- `src/web/styles.ts` (`COMPONENTS_CSS` preenchido)
- `src/util/task-badges.ts` (só leitura/conferência — não deve precisar de mudança; se precisar, documentar por quê)

## Riscos e reversão

- **Risco:** co-classes de `.btn`/`.chip` colidirem em especificidade CSS com o estilo específico de página que já existe, mudando aparência sem intenção. Mitigação: testar cada absorção isoladamente contra o baseline visual antes de acumular várias no mesmo commit.
- **Risco:** a tentação de "aproveitar e já renomear" uma das 4 classes protegidas. Mitigação: a lista de classes protegidas está explícita nesta spec e em `60-visao-geral.md`; qualquer renomeação delas é bloqueante.
- **Reversão:** `git revert` do commit — biblioteca aditiva em `COMPONENTS_CSS`, sem migration, sem mudança de contrato.
