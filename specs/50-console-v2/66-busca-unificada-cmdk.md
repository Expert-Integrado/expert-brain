# Busca unificada: paleta de comando (Ctrl/Cmd+K) atravessando notas, tasks e contatos

> **Status:** ready · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma dura. Suave: `63` (ação Capturar), `56` (navegar pra página do contato), `58` (nova task com projeto).
> **Agente sugerido:** Sonnet (endpoint + client global) · **Esforço de execução:** padrão

## Contexto

- Existem TRÊS buscas separadas e nenhuma é global: notas via `GET /app/search` (`src/web/search.ts:10-21`, FTS5 com prefixo, retorna só ids — o client da página de Notas hidrata em memória); tasks via `ftsSearchTasks` (`src/db/queries.ts`, exposto SÓ pela tool MCP `list_tasks`, nenhuma UI); contatos via a busca do worker contacts (proxyada pro painel do grafo).
- Não há atalho de teclado global nem componente compartilhado entre páginas; cada página tem seu bundle client (`scripts/build-bundles.ts`), e o shell comum é `src/web/layout.ts`.
- Sessão é o auth de todas as superfícies envolvidas (`requireSession`); os filtros de privacidade (31/59/61) tratam sessão como dono — a paleta herda isso de graça.

## Problema / Motivação

- "Onde está X?" exige saber ANTES em qual módulo X vive — a pergunta errada pra um sistema integrado. A busca de tasks nem existe na UI (só via agente).
- Toda ação frequente (nova task, capturar ideia, achar contato) custa navegação; a paleta transforma em 2 teclas + enter.

## Design proposto

### 1. Endpoint agregador `GET /app/search/all?q=<termo>`

- Sessão obrigatória. Dispara em paralelo: `ftsSearch` (notas, cap 6), `ftsSearchTasks` (cap 6), busca de contatos via proxy `CONTACTS` (cap 6, include-private — sessão é dono).
- Retorna grupos tipados: `{ notes: [{id,title,kind,domain}], tasks: [{id,title,status,due_brt}], contacts: [{id,name,category}], degraded?: ['contacts'] }` — payload leve, títulos prontos (diferente do `/app/search` atual que só devolve ids; NÃO mudar o endpoint antigo, a página de Notas continua nele).
- Falha do proxy de contatos → grupo vazio + flag `degraded` (paleta mostra "contatos indisponíveis"), nunca 500.

### 2. Paleta global (client)

- Bundle novo `palette.ts` incluído pelo shell (`layout.ts`) em TODAS as páginas logadas. Abrir: `Ctrl/Cmd+K` (e botão de lupa no header pro mobile). Fechar: `Esc`/click-fora.
- Comportamento: input com debounce 200ms → `/app/search/all`; resultados agrupados com cabeçalho por tipo; navegação por setas + Enter (abre a página do item: nota → `/app/notes/<id>`, task → detalhe no board, contato → `/app/contacts/<id>` da 56, com fallback pro painel do grafo se a 56 não rodou).
- **Ações rápidas** (aparecem acima dos resultados, filtradas pelo texto):
  - `> nova task <título>` → quick-create (endpoint existente de criação de task; com a `58`, aceita `#projeto`).
  - `> capturar <texto>` → `POST /app/inbox/add` (63; ação omitida se a rota 404).
  - `> registrar interação` → navega pro form da 57 (na página do contato selecionado).
  - Prefixo `>` é opcional — sem resultados de busca, as ações casam por fuzzy no rótulo.
- Estado zero (input vazio): últimos 5 itens visitados (localStorage, gravado pelo próprio client ao navegar) + as ações.

### 3. Acessibilidade e consistência

- `role="dialog"` + focus trap + `aria-activedescendant` na lista; tema herda as variáveis CSS do console (styles.ts). Mesmo visual em todas as páginas (é UM componente, zero cópia por página — a lição do drift server/client do board vale aqui).

## Fora de escopo

- Busca semântica (recall/Vectorize) na paleta — FTS é instantâneo e suficiente pra lookup; recall continua sendo superfície do agente.
- Busca em corpo de comentários (53) e em `events.context` de contatos (a busca do contacts da `60` cobre isso no módulo).
- Resultados de inbox na busca (rascunho não indexado — por design da 63).
- Command-palette de administração (arquivar coluna, criar projeto etc. — ficam na config).

## Critérios de aceite

- [ ] `Ctrl/Cmd+K` abre a paleta em QUALQUER página logada; `Esc` fecha; setas+Enter navegam e abrem o item certo.
- [ ] Busca retorna os 3 grupos com caps; termo que só existe numa task acha a task (primeira UI de busca de tasks).
- [ ] `> nova task comprar cabo` cria a task e navega pro board; `capturar` grava no inbox quando a 63 existe e some quando não existe.
- [ ] Contacts fora do ar: grupos de notas/tasks funcionam, aviso de degradado aparece.
- [ ] Endpoint `/app/search/all` recusa sem sessão (401/redirect); o `/app/search` antigo segue intocado (página de Notas não regride).
- [ ] Estado zero mostra recentes do localStorage.

## Validação

- `npm run typecheck` + `npm test`; testes novos: agregador (3 fontes, caps, degraded), auth. Interação de teclado: teste manual roteirizado (`wrangler dev`) — abrir em 3 páginas diferentes, criar task, capturar.
- **Gate de deploy:** `wrangler deploy` só com OK explícito do dono.

## Arquivos afetados

- `src/web/search.ts` (handler `/app/search/all` ao lado do existente), `src/web/handler.ts` (rota)
- `src/web/client/palette.ts` (novo) + `scripts/build-bundles.ts` (entry) + `src/web/layout.ts` (include + botão)
- `test/` (agregador)

## Riscos e reversão

- **Risco**: atalho conflitar com atalhos nativos/extensões. Mitigação: `Ctrl+K` E `Cmd+K` com `preventDefault` só quando não há input focado; botão visível como alternativa.
- **Risco**: bundle global pesar nas páginas. Mitigação: palette lazy — o include no shell é um stub que importa o bundle no primeiro atalho.
- **Reversão**: revert do código; nenhum estado novo (localStorage é descartável).
