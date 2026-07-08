# Onda 5 — Fix list por tela

> **Status:** done (08/07/2026) · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-brain
> **Depende de:** `60-ux-reforma/65-onda4-interacoes-dnd-clique-visibilidade.md`

## Contexto

Com a fundação de tokens (Onda 2), a biblioteca de componentes (Onda 3) e os 3 bugs de interação corrigidos (Onda 4), esta onda percorre cada tela do console aplicando tokens e componentes, na ordem: **home → board → shell/login → graph → notes/task detail → inbox/journal/contact/config/share**. É a onda de maior volume de arquivos tocados, mas de menor risco individual por item (cada fix é isolado).

## Problema / Motivação

Lista de defeitos verificados por tela (evidência arquivo:linha):

- **Home** (`src/web/home.ts`): grid `.home-grid` usa `grid-template-columns: repeat(auto-fit, minmax(300px, 1fr))` (linha 27) — transborda abaixo de ~336px de viewport. O card de digest (`digestCardHtml`, linha 149, dentro do bloco try dessa seção em `handleHomePage`, 143-153) já é envolto em `<div class="home-card">` mas sem a classe `.card`. Cada card busca sua fonte em try/catch isolado (linhas 126-153) e, na falha, retorna string vazia — o card some silenciosamente em vez de mostrar erro visível. O card "Últimas interações" é um skeleton server-side (`renderInteractionsCardSkeleton`, usa `id="home-events-list"`) populado depois via `home.bundle.js` — esse id precisa ser preservado em qualquer refatoração. Login não manda pra home: `src/web/login.ts:30,49,67` têm o literal `/app/graph` como destino default; `safeNextPath` em `login.ts:42-49` só aceita paths que começam com `/app/` (linha 46: `path.startsWith('/app/')`), então `/app` exato (sem barra final) cai no fallback e NUNCA chega na home mesmo se for passado como `next`.
- **Board** (`src/web/tasks.ts`): breakpoint mobile em 760px (`@media (max-width: 760px)`, linha 1407) diverge do breakpoint canônico do resto do app (767px, ver Shell abaixo). Cores de estado hardcoded em vez de tokens semânticos da Onda 2. Botões sem a hierarquia `.btn` da Onda 3. `.task-col-empty` definido em mais de um lugar (levantar via grep durante a execução — consolidar numa única definição).
- **Shell** (`src/web/styles.ts` + `src/web/render.ts`): bloco de CSS morto e contraditório — `.sidebar { display: none; }` dentro do `@media (max-width: 767px)` que começa em `styles.ts:1380` (regra em `styles.ts:1384`) CONTRA um segundo bloco `.sidebar { width: 64px; padding: 20px 6px; ... }` dentro de OUTRO `@media (max-width: 767px)` que começa em `styles.ts:1843` (regras em `styles.ts:1849-1875`) — os dois têm exatamente o mesmo seletor de breakpoint mas prescrevem layouts opostos pra `.sidebar` em mobile (esconder totalmente vs. colapsar pra ícone de 64px); o que "ganha" depende só da ordem de declaração no arquivo, não de intenção. Remover o bloco morto (determinar qual dos dois é o comportamento real hoje ANTES de remover — inspecionar visualmente no baseline da Onda 0). O item de nav "Journal" não existe: nem no tipo `active` de `renderShell()` (`src/web/render.ts:69`: `active: 'home' | 'notes' | 'graph' | 'tasks' | 'contacts' | 'inbox' | 'config' | 'api-keys'` — falta `'journal'`), nem nos links de sidebar (`render.ts:110-116`) ou bottom-nav (`render.ts:127-153`). Hoje `src/web/journal.ts:234` passa `active: 'home'` pra `renderShell()` como gambiarra (journal "pega emprestado" o highlight de home). `NAV_BADGE_CSS` (CSS do badge numérico de pendências no ícone de nav) deveria subir pro `SHELL_CSS` da Onda 2 em vez de ficar solto.
- **Login → home:** `login.ts:30` (`const next = url.searchParams.get('next') ?? '/app/graph';`), `login.ts:49` (fallback dentro de `safeNextPath`), `login.ts:67` (`const next = String(form.get('next') ?? '/app/graph');`) — os 3 defaults trocam de `/app/graph` pra `/app`. `safeNextPath` (linha 46) passa a aceitar `/app` exato além de `/app/*`. Atualizar `src/web/login.test.ts:25` e `:69` (ambos hoje esperam `expect(res.headers.get('location')).toBe('/app/graph')` — passam a esperar `/app`).
- **Graph** (`src/web/graph.ts`): título da página é literalmente `'Graph'` (linha 13, dentro de `renderGraphLikePage(req, env, { active: 'graph', graphSrc: '/app/graph', title: 'Graph' })`) — troca pra `'Grafo'` (o resto da UI já é PT-BR: "Grafo" aparece no nav de `render.ts`). Canvas usa cor hardcoded `#0c0c10` em vez de um token `--surface-canvas` novo (adicionar na Onda 2 se ainda não previsto, ou aqui mesmo como extensão pontual).
- **Notes/task detail** (`src/web/notes.ts`): hardcodes de cor/espaçamento no CSS de detalhe (`notes.ts:1132-1274`, faixa que cobre desde os estilos de `.task-share-*` até `.cmt-*` de comentários) — migrar pros tokens da Onda 2. Breakpoint 640px (`notes.ts:1289`, `@media (max-width: 640px)`) diverge do canônico 767px. `.task-d-btn` vira `.btn` (co-classe, via biblioteca da Onda 3).
- **Share público** (`src/web/share.ts`): 3 inlines completos de `NEBULA_CSS` — `share.ts:230` (`<style>${NEBULA_CSS}`), `share.ts:340` (`<style>${NEBULA_CSS}${SHARE_CSS}</style>`), `share.ts:557` (`<style>${NEBULA_CSS}${SHARE_CSS}${NOTE_SHARE_CSS}</style>`) — trocam pra `PUBLIC_CSS` (criada na Onda 2, `63-onda2-tokens-retematizaveis.md`).

## Objetivo

Cada uma das telas listadas usa os tokens e componentes das Ondas 2-3, sem regressão visual fora do escopo de cada fix, com o baseline da Onda 0 servindo de referência de comparação tela a tela.

## Design proposto

Ordem de execução dentro desta onda (cada item pode ser um commit separado, todos referenciando esta spec):

1. **Home:**
   - `.home-grid` → `grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr))` (o `min(100%, ...)` impede transbordamento abaixo de 300px de viewport).
   - Digest vira `<section class="card home-card">` de verdade (mantendo o `id` usado por `resurface-digest-card` intacto, se esse id existir dentro de `renderDigestCard` — conferir em `notes.ts` onde a função é definida).
   - Erro de carregamento de card vira `.error-state` (componente da Onda 3) visível, com mensagem curta, em vez de string vazia.
   - Skeleton real (componente `.skeleton` da Onda 3) no lugar do texto "Carregando…" estático, mantendo `id="home-events-list"`.
   - `h2` de cada card herda o estilo padrão do `.card` (remover override pontual, se houver).
2. **Board:**
   - Breakpoint `760px` → `767px` (`tasks.ts:1407`, alinhando com o canônico do shell).
   - Cores de estado (colunas, badges) → tokens semânticos da Onda 2.
   - Botões do card e da toolbar → co-classe `.btn`/`.btn-sm`.
   - Consolidar `.task-col-empty` numa única definição.
   - **Anatomia do card no padrão ClickUp (decisão do dono, 07/07/2026, no gate da Onda 1):** título PRIMEIRO no card (clamp de 2 linhas), depois contexto de projeto como breadcrumb muted ("Em <projeto>", substitui o chip de projeto no head), depois UMA linha de meta (prio + due + comentários + selo privada), depois UMA ÚNICA linha de tags sem wrap (excesso corta com overflow hidden — considerar sufixo "+N"; hoje as tags empilham e poluem). Altura mínima consistente entre cards. Referência de proporção/título: capturas do ClickUp real em `C:/tmp/ux-refs/clickup/` (local, fora do repo) e protótipo `prototypes/identity/shared/board.html`.
3. **Shell/login:**
   - Remover o bloco de CSS morto identificado em `styles.ts:1849-1875` (ou `1380-1392`, o que for determinado como o comportamento NÃO-vigente após inspeção visual) — decisão registrada no commit.
   - **Ordem da navegação (decisão do dono, 07/07/2026):** Início → Inbox → Grafo → Notas → Tarefas → Contatos (+ Journal quando entrar, junto de Notas). **Configurações SAI do meio da lista e vai pro RODAPÉ da sidebar**, agrupada com o bloco do usuário. Aplicar em `render.ts:110-116` (sidebar) e na bottom-nav mobile (`render.ts:127-153`) na mesma ordem relativa.
   - **Bloco do usuário no rodapé (decisão do dono, 07/07/2026: "parte dos usuários ali não está legal"):** redesenhar o rodapé da sidebar como grupo coeso — Configurações, avatar/inicial + e-mail truncado com ellipsis, Sair — separado da navegação por borda superior. Referência: `prototypes/identity/shared/base.css` (`.sidebar-user`).
   - Adicionar `'journal'` ao tipo `active` em `render.ts:69`; adicionar o link de sidebar (perto de `render.ts:110-116`) e de bottom-nav (perto de `render.ts:127-153`) pro Journal, com ícone consistente com os demais.
   - `journal.ts:234` passa a usar `active: 'journal'` em vez de `'home'` emprestado.
   - `NAV_BADGE_CSS` sobe pro `SHELL_CSS` (Onda 2).
   - `login.ts:30,49,67`: default `/app/graph` → `/app`; `safeNextPath` (linha 46) aceita `/app` exato além de `/app/*`.
   - `src/web/login.test.ts:25,69`: atualizar a asserção de `location` pra `/app`.
4. **Graph:**
   - `graph.ts:13`: `title: 'Graph'` → `title: 'Grafo'`.
   - Canvas: `#0c0c10` → `var(--surface-canvas)` (token novo, adicionar em `TOKENS_CSS` da Onda 2 se não existir ainda).
5. **Notes/task detail:**
   - `notes.ts:1132-1274`: hardcodes de cor/espaço → tokens.
   - Breakpoint `640px` (`notes.ts:1289`) → `767px`.
   - `.task-d-btn` ganha co-classe `.btn`.
6. **Share público / inbox / journal / contact / config:**
   - `share.ts:230,340,557`: `NEBULA_CSS` → `PUBLIC_CSS`.
   - Demais telas (inbox, journal, contact page, config) recebem os mesmos princípios (tokens + componentes) conforme oportunidade — sem lista fechada de linha aqui, seguir o mesmo padrão dos itens 1-5 aplicado a cada arquivo (`src/web/inbox.ts`, `src/web/journal.ts`, `src/web/contact-page.ts`, `src/web/config.ts`).

## Fora de escopo

- Qualquer mudança de identidade visual definitiva (cor de marca, fonte) — isso é só a Onda 6, após a decisão do dono na Onda 1.
- Reescrever a mecânica de interação (drag, clique, visibilidade) — já resolvida na Onda 4; esta onda só aplica visual.
- Adicionar telas novas ou remover telas existentes do console.

## Critérios de aceite

- [x] Home: grid não transborda em 320px de viewport; digest com `.card`; erro visível em vez de card sumido; skeleton real preservando os ids usados por `home.bundle.js`
- [x] Board: breakpoint 767px; cores via token; botões com `.btn`; `.task-col-empty` consolidado numa única definição
- [x] Shell: CSS morto/contraditório de sidebar mobile removido (um único comportamento remanescente, verificado visualmente); Journal presente no tipo `active`, na sidebar e no bottom-nav; `NAV_BADGE_CSS` dentro de `SHELL_CSS`
- [x] Login → home: os 3 defaults trocados; `safeNextPath` aceita `/app` exato; `login.test.ts` atualizado e verde
- [x] Graph: título "Grafo"; canvas usa token de cor
- [x] Notes/task detail: hardcodes migrados pra tokens; breakpoint 767px; `.task-d-btn` com `.btn`
- [x] Share: as 3 ocorrências de `NEBULA_CSS` trocadas por `PUBLIC_CSS`, página pública renderiza idêntica visualmente (ou melhor) com payload menor
- [x] `npm run typecheck`, `npm test`, `npm run test:client` e a suíte e2e passam
- [x] Todos os testes na lista de "strings atualizadas no mesmo commit" (`60-visao-geral.md`) que forem afetados por esta onda foram de fato atualizados

## Evidência de execução (08/07/2026, branch ux-reforma)

Entregue conforme itens 1-6 do design, mais correções descobertas na verificação em navegador:

- **Anatomia ClickUp do card** (decisão do gate): SSR (`renderCardSSR` em `tasks.ts`) e client (`cardHTML` em `client/tasks.ts`) sincronizados — título primeiro (clamp 2 linhas), breadcrumb "Em <projeto>" via `projectCrumbHtml` (novo em `util/task-badges.ts`; `projectChipHtml` removido por ficar sem uso), uma linha de meta, uma linha de tags sem wrap, concluir fixado embaixo (`.btn .btn-sm .btn-ghost`).
- **Rodapé da sidebar** (decisão do gate): Recolher → Configurações → bloco de usuário (`.sidebar-user`: avatar-inicial + e-mail com ellipsis + botão Sair com hover danger); modo recolhido vira coluna de 44px.
- **Bottom-nav mobile icon-only**: com 9 destinos (Journal entrou) as labels truncavam ("Jour…", "Cont…") — labels agora são visualmente ocultas (clip) e seguem no aria-label/leitores de tela.
- **`.row button` → `.row button:not(.btn)`** (`styles.ts`): a regra genérica (0,1,1) vencia `.btn-primary` (0,1,0) e matava o gradiente dos botões primários do config.
- **Duplicatas legadas removidas de SURFACES_CSS**: `.btn-primary` (~895) e `.btn-danger` (~989) — o config adota `.btn .btn-primary` / `.btn .btn-danger .btn-sm`.
- **`.note-body` subiu de SURFACES_CSS pra COMPONENTS_CSS** — é compartilhado com a página pública `/s/` via `PUBLIC_CSS`.
- **Inbox**: `.inbox-btn` virou co-classe de `.btn`; cores de estado tokenizadas. **Journal**: chips tokenizados (nota=lavanda; task/contact via `color-mix` da cor própria).
- **Validação**: typecheck 4 tsconfigs OK; server 792+5 verdes; client 38 verdes; e2e 21 specs verdes; harness `wave-5` 32/32 capturas (contact page exige `npm run dev:full`, não `wrangler dev` puro); pixel diff vs baseline coerente com redesign deliberado (graph e alturas de página são as exceções conhecidas).
- **Pendências registradas pra Onda 6**: favicon.ico 404; warnings de enctype no manifest PWA; input de título no task detail trunca títulos longos.

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck
npm test
npm run test:client
node scripts/verify-wave.mjs --phase wave-5
```

Teste manual: percorrer as ~16 telas do baseline da Onda 0 em 1440x900 e 390x844, comparando contra o contact sheet — nenhuma regressão fora do escopo pretendido de cada fix; testar login sem `next` explícito e confirmar que cai na home.

**Gate de deploy:** implementar e commitar localmente é livre; nenhum `wrangler deploy` nesta onda.

## Arquivos afetados

- `src/web/home.ts`, `src/web/tasks.ts`, `src/web/styles.ts`, `src/web/render.ts`, `src/web/journal.ts`, `src/web/login.ts`, `src/web/graph.ts`, `src/web/notes.ts`, `src/web/share.ts`, `src/web/inbox.ts`, `src/web/contact-page.ts`, `src/web/config.ts`
- `src/web/login.test.ts` (linhas 25, 69)

## Riscos e reversão

- **Risco:** remover o bloco de CSS morto da sidebar mobile errado (remover o que estava de fato vigente em vez do morto) e quebrar a navegação mobile. Mitigação: inspecionar visualmente no navegador local ANTES de decidir qual bloco remover — comentar um de cada vez e observar o resultado, não assumir pela ordem no arquivo.
- **Risco:** mudar o default de `/app/graph` pra `/app` quebrar algum fluxo externo que dependa do redirect antigo (ex. link salvo, bookmark). Mitigação: `/app/graph` continua existindo como rota válida — só o DEFAULT muda; nada que aponte explicitamente pra `/app/graph` quebra.
- **Reversão:** `git revert` do(s) commit(s) desta onda — mudanças são localizadas por arquivo/tela, sem dependência cruzada forte entre os itens 1-6, o que permite reverter um item isoladamente se necessário.
