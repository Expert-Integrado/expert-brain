# 70 — Onda 8: board em largura total + busca/filtros, home em caixas fechadas, Inbox absorvido na home

- **Status:** done
- **Data:** 08/07/2026
- **Origem:** feedback do dono após o deploy da v3.1.0 (specs 60–69), com prints de produção:
  1. Board de tarefas com 4 colunas mostra só 3 e força scroll lateral numa tela larga.
  2. Falta busca no board (título + descrição) e filtros além de data/projeto (tag, prioridade).
  3. Home cresce sem limite: card "Hoje" com 26 tasks atrasadas estica a página; feed "Atividade" é infinito.
  4. Inbox sem clareza de propósito e com tela/menu próprios demais pra o que é (fila de rascunhos): absorver na home e instruir o agente a usar direito.

## 1. Board em largura total

O `.main` do shell capa em `980px` pra leitura (nota, config). O board é uma exceção
igual à lista de notas: `.main:has(#task-board) { max-width: none; }` (styles.ts).
Com isso 4+ colunas de `minmax(260px, 1fr)` usam a tela toda; o scroll lateral só
aparece quando as colunas genuinamente não cabem.

## 2. Busca + filtros no board

- **Payload** (`/app/tasks/data`): cada `TaskView` ganha `search_text` — título +
  corpo (quando não é eco do título) + tags, minúsculo e **sem acento**
  (`foldSearchText`, cap 800 chars). O client não precisa de fold próprio do texto,
  só da query ("reuniao" acha "Reunião").
- **Toolbar SSR** (`handleTasksPage`): input `#task-search` (busca por título,
  descrição ou tag) + selects `#task-prio-filter` (Todas | Urgente..Baixa | Sem
  prioridade) e `#task-tag-filter` (união das tags do board) ao lado do filtro de
  projeto existente. Os filtros rápidos de data (Todas abertas / Vencem hoje / Esta
  semana / Atrasadas) continuam como estavam.
- **Client** (`client/tasks.ts`): estado em memória (`searchQuery`, `tagFilter`,
  `prioFilter`) aplicado em TODAS as colunas por cima do filtro de projeto; o filtro
  de data continua restrito às colunas open/in_progress. Busca com debounce de
  120ms; termos separados por espaço são AND. O select de tag é re-populado a cada
  `load()` (edição inline muda tags sem reload).
- **Fora de escopo:** filtro por responsável — o Brain é single-owner, não existe
  campo de responsável; tags/projetos cobrem o caso.

## 3. Home em caixas de tamanho previsível

- `.home-card { max-height: 340px; display: flex; flex-direction: column; }` com
  scroll interno SÓ no conteúdo (`> :last-child`): título (e o form de captura do
  Inbox) ficam fixos; 26 tasks atrasadas rolam dentro da caixa em vez de esticar a
  página. Conteúdo curto não estica a caixa.
- Feed "Atividade" ganha caixa fechada `.home-activity-box` (max-height 460px,
  scroll interno). O "Carregar mais" e o aviso de degradação continuam sendo
  inseridos pelo client ao redor de `#journal-groups` — ambos caem DENTRO da caixa.

## 4. Inbox absorvido na home

- **Navegação:** o item Inbox saiu do menu lateral e do bottom-nav (com o badge de
  contagem — a contagem já aparece no título do card). `renderShell` perdeu o
  active `'inbox'` e a query `countPendingInbox` por página.
- **Card Inbox na home = superfície principal:** form de captura rápida (POST
  `/app/inbox/add`, CSP-safe) + até 20 pendentes (mais recentes primeiro), cada um
  com triagem inline — **nota** (`/app/inbox/to-note`, redireciona pro editor da
  nota), **tarefa** (`/app/inbox/to-task`, redireciona pro detalhe) e **descartar**
  (`/app/inbox/resolve`).
- **`next` nos endpoints:** `add` e `resolve` aceitam hidden `next` com allowlist
  fechada (`'/app'`; qualquer outro valor cai no default `/app/inbox`) pra devolver
  o dono pra home. Nunca redirect arbitrário.
- **A página `/app/inbox` segue viva:** é o "ver tudo" do card (corpo em markdown,
  itens além do cap de 20) e o destino do Web Share Target do PWA (spec 68). Na
  nav, Início fica ativo; a página ganhou o breadcrumb "← Início".

## 5. Agente usa o Inbox do jeito certo

`buildServerInstructions` (handshake MCP) ganhou o item 12: ideia/lembrete avulso
do dono → `capture` (zero estrutura, triagem depois), sem forçar `save_note`
(curadoria) nem `save_task` (compromisso); conversa comum não é capturável; dúvida
capture vs save_task = tem dono+prazo é task, semente de ideia é capture. Triagem
no card da home ou via `list_inbox` + `resolve_inbox`. `TOOL_NAMES` agora cita as
28 tools (entraram capture, list_inbox, resolve_inbox).

## Critérios de aceite

- [x] `/app/tasks` usa a largura toda; 4 colunas visíveis sem scroll lateral em 1440px+.
- [x] Busca filtra por título, descrição e tag, sem acento-sensibilidade; filtros de
  prioridade e tag compõem com projeto e data; contadores de coluna refletem o filtro.
- [x] Home: nenhum card cresce além do cap; conteúdo excedente rola dentro da caixa;
  feed "Atividade" contido com "Carregar mais" dentro da caixa.
- [x] Inbox: sem item de menu; captura e triagem completas pelo card da home;
  `/app/inbox` acessível pelo "ver tudo"; share target intacto; `next` com allowlist.
- [x] Instructions MCP citam capture/list_inbox/resolve_inbox com critério de uso.
- [x] Suítes server + client + e2e verdes; testes que asseravam o estado antigo
  (badge da nav, preview de 3 itens, 25 tools) atualizados no mesmo commit.

## Evidências

- Testes: `test/task-projects-web.test.ts` (toolbar + search_text),
  `test/web/home.test.ts` (card Inbox com captura/triagem), `test/inbox-web.test.ts`
  (nav sem Inbox, `next` com allowlist), `test/instructions.test.ts` (28 tools),
  `e2e/board.spec.ts` (busca filtra/zera/restaura), `e2e/home.spec.ts` (captura e
  descarte inline pela home; menu sem Inbox).
- Auditoria visual: `C:/tmp/ux-audit/wave-8/` (contact sheet vs baseline).
