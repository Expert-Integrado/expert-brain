# Onda 4 — Interações: drag-and-drop, clique no cartão, seletor de visibilidade

> **Status:** ready · **Prioridade:** P0 · **Esforço:** L · **Repo:** expert-brain
> **Depende de:** `60-ux-reforma/64-onda3-biblioteca-componentes.md`

## Contexto

Esta onda resolve os 3 bugs que motivaram o pedido de reforma na aula ao vivo. É a onda de maior risco funcional do programa (reescreve a mecânica de drag-and-drop e a lógica de clique do board de tasks), por isso vem depois da fundação visual (Ondas 2-3) mas antes do polish tela-a-tela (Onda 5) — corrigir a mecânica primeiro evita que a Onda 5 estilize um comportamento que ainda vai mudar.

Arquivos-chave e estado atual verificado:

- `src/web/client/tasks.ts:483-522` — implementação atual de drag: `dragstart` (linha 483) marca `.dragging` + `body.task-dragging`; `wireDropzones()` (linha 497-522) escuta `dragover`/`dragleave`/`drop` em cada `.task-col-body`, aplicando `zone.classList.add('drag-over')` na linha 504 e removendo na 509/513. Usa a API HTML5 nativa (`DataTransfer`), que não dispara em touch.
- `src/web/tasks.ts:1226-1229` — CSS `.task-col-body.drag-over { background: rgba(167,139,250,0.09); box-shadow: inset 0 0 0 2px var(--border-strong); }` — aplica o highlight à coluna INTEIRA, não a uma posição de drop.
- `src/web/tasks.ts:1015-1021` — `renderCardSSR()`: `<div class="task-card" ... draggable="true">` (linha 1015) contém `<a class="task-card-title" href=".../${id}">` (linha 1017, o único elemento que navega) e um botão redundante `<a class="task-btn task-open" href=".../${id}">abrir</a>` (linha 1021).
- `src/web/notes.ts:877-928` — sidebar do detalhe de task com as duas seções: "Compartilhamento público" (890-913, link `/s/<token>`, já opt-in) e "Privacidade" (917-928, com o texto confuso "Esta task é <strong>pública</strong>..." na linha 922). A mesma dualidade existe pra NOTA em `src/web/notes.ts:402-438` (compartilhamento) e `459-462` (toggle privada/pública no `note-edit`).
- Endpoints existentes que devem ser REUSADOS sem qualquer mudança de contrato: `POST /app/tasks/private` → `handleTaskPrivatePost` em `src/web/tasks.ts:654-684`; `POST /app/notes/{id}/private` → `handleNotePrivatePost` em `src/web/notes.ts:777-807`; share/unshare roteados em `src/web/handler.ts:103-106` (`/app/tasks/share`, `/app/tasks/unshare`, `/app/notes/share`, `/app/notes/unshare` — os dois últimos são aliases dos mesmos handlers de task, conforme comentário em `handler.ts:100-102`). O fail-closed de privacidade já existe no banco (`src/db/queries.ts:287-308` — reconferir número exato na execução).
- Geração de HTML de chip/ícone (fonte de verdade pra qualquer badge tocado nesta onda): `src/util/task-badges.ts` (NÃO `src/web/task-badges.ts` — esse path não existe no repo).

## Problema / Motivação

1. **DnD "acende a tela inteira":** ver evidência em `client/tasks.ts:504` + `tasks.ts:1226-1229` no Contexto acima. Sem indicador de posição, colunas largas (`minmax(260px,1fr)`, `tasks.ts:1194`) tornam o highlight de coluna inteira desproporcional ao gesto. HTML5 DnD nativo não funciona em touch — o board é inutilizável em mobile hoje.
2. **Cartão não abre no clique:** só o `<a class="task-card-title">` (`tasks.ts:1017`) navega; o card inteiro tem `draggable="true"` + `cursor: grab` (visualmente convida ao clique em qualquer ponto, mas só uma faixa de texto realmente navega). `mousedown` no card compete com o `dragstart`.
3. **Seletor de visibilidade induz erro de leitura:** confirmado em `notes.ts:917-928` — a palavra "pública" no bloco de Privacidade (linha 922) significa "visível às credenciais do dono", não "exposta na internet" (que é o que o link `/s/<token>` do bloco de cima, linhas 890-913, de fato faz). Um usuário lendo rápido pode interpretar "task pública" como "está na internet", gerando falsa sensação de exposição (ou o oposto: falsa sensação de segurança).

## Objetivo

Um usuário (dono ou aluno, desktop ou mobile) arrasta um card entre colunas com feedback visual preciso (borda + header da coluna-alvo, não fundo pintado inteiro), clica em qualquer ponto do card pra abrir o detalhe (exceto controles internos), e entende em uma leitura qual dos 3 níveis de visibilidade (Privado / Normal / Link público) a task ou nota está — tudo coberto por teste automatizado (jsdom + e2e), sem nenhum endpoint novo.

## Design proposto

### 1. Drag-and-drop via Pointer Events

Novo arquivo `src/web/client/board-dnd.ts` (~200-250 linhas, vanilla — sem lib externa), entra no bundle `tasks.bundle.js` (via `scripts/build-bundles.ts`):

- **State machine:** `idle → armed → dragging → dropped/cancelled`. Threshold de 6px de movimento (mouse) ou long-press de 300ms (touch) antes de armar o drag — evita que um clique rápido seja interpretado como arrasto.
- **Ghost element:** clone visual do card, `pointer-events: none`, segue o ponteiro durante `dragging`.
- **Autoscroll:** ao arrastar próximo às bordas horizontais do `#task-board`, rola automaticamente (o board usa `grid-auto-flow: column` com `overflow-x: auto`, `tasks.ts:1194`).
- **Delegação de evento:** um único listener em `#task-board` (não um por card) — elimina o re-wire manual a cada render que a implementação atual não faz hoje de forma centralizada.
- **Affordance de drop:** borda + header da coluna-alvo ganham uma classe `.drag-target` na `<section>` da coluna (NÃO no `.task-col-body` inteiro) — remove o `background`/`box-shadow` de fundo pintado de `tasks.ts:1226-1229`. Coluna vazia ganha borda tracejada quando é alvo válido.
- **Remoção da implementação antiga:** apagar `draggable="true"` dos DOIS lugares que renderizam o card (SSR em `tasks.ts:1015` e o client-side equivalente, se houver renderização espelhada em `client/tasks.ts`); remover `wireDropzones()` e os listeners `dragstart`/`dragover`/`dragleave`/`drop` antigos (`client/tasks.ts:483-522`); o `<a class="task-card-title">` ganha `draggable="false"` explícito (evita que o browser tente iniciar um drag nativo de link).
- **Seams pra teste:** a lógica de hit-test (qual coluna está sob o ponteiro) fica numa função pura exportada, testável em jsdom sem precisar simular eventos de ponteiro reais.
- **Sem reordenação intra-coluna:** confirmado no diagnóstico (`60-visao-geral.md` item 5, `src/db/queries.ts:693-696`) — o servidor decide a ordem; o DnD novo só decide "pra qual coluna", igual ao comportamento atual, só que com mecânica e feedback novos.

### 2. Cartão inteiro clicável

- `pointerup` no card, SE nenhum drag foi armado (state machine da seção 1 permanece em `idle`), navega pro detalhe da task.
- **Exceções** (não navegam, deixam o elemento interno agir): `a`, `button`, `input`, `select`, `textarea`, `label`, `.task-card-edit`.
- **Guarda de seleção de texto:** se o usuário estava selecionando texto (ex. copiando o título), o `pointerup` correspondente não deve disparar navegação.
- Remover o botão `<a class="task-btn task-open">abrir</a>` (`tasks.ts:1021`) — fica redundante.
- Foco visível via `.task-card:focus-within` — o `<a class="task-card-title">` continua sendo o único tab-stop do card (sem `tabindex` novo no `<div>`), preservando a ordem de tabulação existente.

### 3. Seletor de visibilidade unificado (task E nota)

Substitui as 2 seções em `notes.ts:877-928` (task) e a dupla equivalente em `notes.ts:402-438,459-462` (nota) por um radiogroup segmentado de 3 opções:

- 🔒 **Privado** — mapeia pro `private=1` atual.
- 👥 **Normal** (default) — mapeia pro `private=0` sem share ativo. Microcopy explícita: "Você + seus agentes. NÃO fica na internet." — resolve DIRETAMENTE a confusão do diagnóstico item 3.
- 🔗 **Link público** — mapeia pro `private=0` COM share ativo. Abre um sub-painel com validade (dias), botão copiar, botão revogar. "Incluir mídia" só aparece pra nota (task não tem esse conceito hoje).
- **ZERO endpoint novo, ZERO migration.** Reusa exatamente: `POST /app/tasks/private` (`tasks.ts:654-684`), `POST /app/notes/{id}/private` (`notes.ts:777-807`), e os handlers de share/unshare já roteados (`handler.ts:103-106`). O fail-closed já existe no banco.
- **Transições encadeadas** (o componente client decide a sequência de chamadas, o servidor continua simples):
  - Link público → Privado: chama unshare, depois private=1. Confirmação via `confirm()` nativo (destrutivo — revoga o link).
  - Privado → Link público: chama private=0, depois share. Fail-safe: se o usuário cancelar no meio, o estado final é "Normal" (o lado menos exposto), nunca "Link público sem querer".
  - Normal → Privado / Normal → Link público: chamada única, sem confirmação (não é destrutivo).
  - Link público → Normal: chama unshare. `confirm()` (revoga o link).
- Novo `src/web/client/visibility-ui.ts` (evolui o `client/share-ui.ts` existente — não recomeçar do zero, herdar a lógica de copiar link/mostrar validade que já funciona).
- **Varredura da palavra "pública"/"privada" em contexto de confusão semelhante**, pra garantir consistência de linguagem em toda a superfície (mesmo fora da sidebar principal): `src/util/task-badges.ts:46-52` (`shareIconHtml()`, hoje usa "Link público ativo até..." — já correto, conferir se o texto do tooltip continua claro após a mudança), `src/web/tasks.ts:1011` (`PRIVATE_TASK_BADGE`, já usa "Task privada — invisível pra credenciais sem escopo private" — já correto, revisar por consistência de tom com o novo seletor), `src/web/home.ts:68` (badge de task privada no card "Hoje" da home, título "Task privada" — já correto, mas confirmar que nenhum lugar da home usa a palavra "pública" pro estado default/Normal).

### 4. Testes

- **jsdom** (`test/client/board-dnd.test.ts`, `test/client/visibility-ui.test.ts`, novos): casos — mover card entre colunas via simulação de pointer events, clique abre o detalhe, concluir (botão dentro do card) NÃO navega, long-press em touch vs. scroll normal não confundidos, os 3 estados do seletor de visibilidade disparam os POSTs certos na sequência certa com `confirm()` mockado.
- Atualizar `test/tasks-detail-sidebar.test.ts:97` (reconferir linha exata) pra refletir o novo markup do seletor unificado em vez das 2 seções antigas.
- **E2E Playwright** (fora do `npm test`, dentro da suíte `e2e/` criada na Onda 0): 4 specs de smoke cobrindo os mesmos casos acima em navegador real.

## Fora de escopo

- Reordenação manual de cards dentro da mesma coluna (confirmado fora de escopo desde o diagnóstico original).
- Qualquer endpoint novo, migration nova, ou mudança no contrato das tools MCP `mark_private`/`share_task`/`unshare_task`.
- Aplicar a biblioteca visual de componentes (`.btn`, `.chip`) em telas que esta onda não precisa tocar para resolver os 3 bugs — isso é trabalho da Onda 5.
- Drag de coluna inteira (reordenar colunas do board) — não fazia parte do pedido original.

## Critérios de aceite

- [ ] `src/web/client/board-dnd.ts` existe, implementa a state machine com threshold 6px/300ms, ghost, autoscroll, delegação em `#task-board`
- [ ] `.drag-target` aplica borda + header na `<section>` da coluna, sem `background`/`box-shadow` de fundo pintado; `tasks.ts:1226-1229` removido ou substituído
- [ ] `draggable="true"` removido dos 2 renderizadores de card; `<a class="task-card-title">` tem `draggable="false"` explícito
- [ ] `wireDropzones()` e os listeners HTML5 DnD antigos (`client/tasks.ts:483-522`) removidos
- [ ] Card inteiro navega no `pointerup` sem drag armado, respeitando as exceções (a/button/input/select/textarea/label/.task-card-edit) e a guarda de seleção de texto
- [ ] Botão `<a class="task-btn task-open">` removido de `renderCardSSR`
- [ ] `.task-card:focus-within` aplica foco visível; tab stop único continua sendo o `<a class="task-card-title">`
- [ ] Seletor de visibilidade unificado (3 estados) substitui as seções antigas em `notes.ts:877-928` (task) e `notes.ts:402-462` (nota), sem nenhum endpoint novo
- [ ] Transições destrutivas (Link→Privado, Link→Normal) pedem confirmação; transições não-destrutivas não pedem
- [ ] `src/web/client/visibility-ui.ts` criado, evoluindo `share-ui.ts`
- [ ] Testes jsdom novos cobrindo os casos listados + `test/tasks-detail-sidebar.test.ts` atualizado
- [ ] 4 specs e2e de smoke passam localmente
- [ ] `npm run typecheck`, `npm test`, `npm run test:client` e a suíte e2e passam

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck
npm test
npm run test:client
node scripts/verify-wave.mjs --phase wave-4
```

Teste manual (checklist): arrastar card entre colunas no desktop; arrastar no mobile (viewport 390px, via DevTools ou dispositivo real) com long-press; clicar em qualquer ponto vazio do card abre o detalhe; clicar no botão "concluir" NÃO navega; testar os 3 estados de visibilidade em uma task e em uma nota, incluindo as transições destrutivas com confirmação.

**Gate de deploy:** implementar e commitar localmente é livre; nenhum `wrangler deploy` nesta onda — o deploy único de produção só acontece na Onda 7.

## Arquivos afetados

- `src/web/client/board-dnd.ts` (novo)
- `src/web/client/visibility-ui.ts` (novo, evolui `client/share-ui.ts`)
- `src/web/client/tasks.ts` (remoção da mecânica DnD antiga, `483-522`)
- `src/web/tasks.ts` (remoção de `draggable`, do botão "abrir", CSS `1226-1229`, `PRIVATE_TASK_BADGE` em `1011` revisado por consistência de tom)
- `src/web/notes.ts` (seletor de visibilidade unificado em `877-928` e `402-462`)
- `src/util/task-badges.ts` (revisão de texto do tooltip em `shareIconHtml`, linhas 46-52, sem mudança de assinatura)
- `src/web/home.ts` (revisão do texto do badge privado em `68`, sem mudança de comportamento)
- `test/client/board-dnd.test.ts`, `test/client/visibility-ui.test.ts` (novos)
- `test/tasks-detail-sidebar.test.ts` (atualização, linha 97 a reconferir)
- `e2e/*.spec.ts` (4 specs novas de smoke)

## Riscos e reversão

- **Risco:** a nova mecânica de Pointer Events se comportar de forma diferente em navegadores/dispositivos não testados localmente (ex. Safari iOS). Mitigação: testar manualmente em pelo menos 1 dispositivo touch real antes de considerar a onda concluída, além do e2e headless.
- **Risco:** a lógica de transição encadeada do seletor de visibilidade deixar o registro num estado intermediário se uma das 2 chamadas falhar (ex. unshare funciona mas o toggle de private falha depois). Mitigação: a UI deve refletir o estado real do servidor após cada chamada (reconsultar, não assumir sucesso otimista) e mostrar erro claro se a segunda chamada falhar, sem fingir que a transição completou.
- **Reversão:** `git revert` do commit — nenhuma migration, nenhum endpoint novo; a reversão de código é suficiente pra voltar ao comportamento anterior (incluindo os bugs), sem qualquer efeito em dado persistido.
