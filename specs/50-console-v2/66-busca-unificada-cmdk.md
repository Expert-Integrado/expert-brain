# Busca unificada: estender a paleta Ctrl+K existente pra tasks, contatos e ações rápidas

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma dura. Suave: `63` (ação Capturar), `56` (navegar pra página do contato), `58` (nova task com projeto).
> **Agente sugerido:** Sonnet (endpoint + extensão de client) · **Esforço de execução:** padrão

## Contexto

- **A paleta de comando JÁ EXISTE** no shell global (`src/web/client/shell.ts`, buildada em `assets/shell.bundle.js`): abre com `Ctrl/Cmd+K`, tem navegação por setas/Enter/Esc, focus-guard (não abre com input focado) e atalhos extras (`Ctrl+G` grafo, `Ctrl+N` notas, `Ctrl+T` tasks, `Ctrl+B` sidebar, `Ctrl+,` config).
- O que ela busca hoje: SÓ NOTAS — server-side via `GET /app/search` (`src/web/search.ts:10-21`, FTS5, retorna só ids que o client hidrata do cache de metadados) com fallback local Fuse quando o server falha. Suporta linhas de comando com prefixo `>`.
- O que NÃO existe: tasks nos resultados (a busca `ftsSearchTasks` de `src/db/queries.ts` só é alcançável pela tool MCP `list_tasks` — nenhuma UI), contatos nos resultados (a busca do contacts só aparece no painel do grafo), e ações de criação (nova task, capturar).
- Sessão é o auth de tudo (`requireSession`); filtros de privacidade (31/59/61) tratam sessão como dono — a paleta herda.

## Problema / Motivação

- "Onde está X?" na paleta só responde se X for nota — task e contato exigem saber ANTES em qual módulo procurar (a pergunta errada num sistema integrado).
- Criar task ou capturar ideia custa navegação; a paleta já está aberta a 2 teclas de distância e não cria nada.

## Design proposto

### 1. Endpoint agregador `GET /app/search/all?q=<termo>`

- Sessão obrigatória. Em paralelo: `ftsSearch` (notas, cap 6), `ftsSearchTasks` (cap 6), busca de contatos via proxy `CONTACTS` (cap 6, include-private — sessão é dono).
- Retorno tipado e leve: `{ notes: [{id,title,kind,domain}], tasks: [{id,title,status,due_brt}], contacts: [{id,name,category}], degraded?: ['contacts'] }`.
- **NÃO mudar o `/app/search` existente** (a página de Notas e o fallback atual da paleta continuam nele). Falha do proxy de contatos → grupo vazio + `degraded`, nunca 500.

### 2. Extensão da paleta (em `src/web/client/shell.ts` — SEM componente novo)

- O handler de busca da paleta passa a chamar `/app/search/all` (mantendo o Fuse local como fallback só pra notas, como hoje); render agrupa por tipo com cabeçalho (Notas / Tarefas / Contatos) — reusar o markup `.cmd-row` existente.
- Abrir item: nota → detalhe; task → board com o card focado (query param `?task=<id>` que o board já entende ou passa a entender); contato → `/app/contacts/<id>` (56; fallback: painel do grafo de contatos se a rota 404).
- **Ações rápidas** (estendem o sistema de comandos `>` que já existe):
  - `> task <título>` → cria task via endpoint de criação existente (com a `58`, `#projeto` no fim vira projeto).
  - `> capturar <texto>` → `POST /app/inbox/add` (63; comando omitido se a rota não existir).
  - `> interação` → navega pro form de registrar interação (57) do contato selecionado/buscado.
- Estado zero (input vazio): últimos 5 itens abertos via paleta (localStorage) + os comandos `>` disponíveis.

### 3. Consistência

- Grupos com `degraded` mostram linha "contatos indisponíveis" (sem quebrar os demais). A11y: manter os padrões do componente atual (`aria` na lista, focus trap) — só estender.

## Fora de escopo

- Busca semântica (recall/Vectorize) na paleta — FTS é instantâneo; recall é superfície do agente.
- Buscar comentários (53), `events.context` (coberto no módulo pela `60`) e inbox (não indexado por design da 63).
- Mudar atalhos existentes (Ctrl+G/N/T/B/,).
- Comandos administrativos (arquivar coluna, criar projeto — ficam na config).

## Critérios de aceite

- [x] Paleta retorna os 3 grupos; termo que só existe numa task acha a task (primeira UI de busca de tasks); termo de contato acha o contato.
- [x] `> task comprar cabo` cria a task e navega pro board; `> capturar ...` grava no inbox quando a 63 existe e o comando some quando não existe.
- [x] Contacts fora do ar: notas/tasks seguem funcionando + aviso de degradado.
- [x] `/app/search/all` recusa sem sessão; `/app/search` antigo intocado (página de Notas e fallback não regridem).
- [x] Comportamentos atuais preservados: focus-guard, setas/Enter/Esc, atalhos Ctrl+G/N/T/B, fallback Fuse pra notas.
- [x] Estado zero mostra recentes + comandos.

## Validação

- `npm run typecheck` + `npm test`; teste novo do agregador (3 fontes, caps, degraded, auth). Teclado: roteiro manual em 3 páginas (`wrangler dev`).
- **Gate de deploy:** `wrangler deploy` só com OK explícito do dono.

## Arquivos afetados

- `src/web/search.ts` (handler `/app/search/all`), `src/web/handler.ts` (rota)
- `src/web/graph-data.ts` (`firstDomain` exportado), `src/web/contacts-data.ts` (`fetchContactsSearchServerSide`)
- `src/web/client/shell.ts` (grupos + ações rápidas + recentes) + `src/web/styles.ts` (`.cmd-group-header`/`.cmd-empty-inline`)
- `src/web/tasks.ts` (`.task-card-focused`), `src/web/client/tasks.ts` (`focusTaskFromQuery`, `?task=<id>`)
- `src/web/client/contact-page.ts` (`#registrar-interacao` expande o form + foca o textarea)
- `assets/shell.bundle.js`, `assets/tasks.bundle.js`, `assets/contact-page.bundle.js` (rebuild via `scripts/build-bundles.ts`), `src/web/asset-version.ts`
- `test/search-all.test.ts` (agregador)

## Riscos e reversão

- **Risco**: regressão na paleta atual (é o componente mais usado do shell). Mitigação: mudanças aditivas no render; critério de preservação explícito acima.
- **Risco**: payload maior atrasar a digitação. Mitigação: debounce atual mantido + caps de 6 por grupo.
- **Reversão**: revert do código + rebuild do bundle; nenhum estado novo no banco.
