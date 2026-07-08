# Onda 6.5 — Consolidação: config segmentada em abas + home absorve o Journal

> **Status:** done (08/07/2026) · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `60-ux-reforma/67-onda6-identidade-a11y.md`

## Contexto

Onda extra nascida do feedback do dono ao revisar o resultado da Onda 6, ANTES do gate de deploy da Onda 7. Dois pedidos:

1. **"Journal + Início + Inbox é tela demais"** — mesclar em duas superfícies: uma pra visualizar tudo (Início absorvendo o Journal) e o Inbox seguindo como tela de triagem própria (opção A da proposta; a variante B — Início absorver também a triagem do Inbox — fica como evolução possível).
2. **"A tela de configurações está tudo muito acumulado"** — segmentar em blocos claros: blocos de conexão separados dos blocos de configuração do workspace, com hierarquia de interface melhor. "Tem que refatorar toda a tela ali."

## Problema / Motivação

- `/app/config` empilhava Status do vault + Backup + um título único "Conexões" cobrindo **7 acordeões numerados**, sendo que os itens 4–7 (Quadro de tarefas, Projetos, Áreas e tipos, Instruções) não são conexões — a numeração 1–7 atravessava grupos sem relação e o scroll era longo.
- Início, Journal e Inbox eram 3 itens de navegação pra conteúdos sobrepostos: o card "Últimas interações" da home era um subconjunto do feed do Journal (informação duplicada — exatamente o que o /goal da reforma proíbe).

## O que foi feito

### 1. Config em 3 abas segmentadas (`src/web/config.ts`, `config-script.ts`, `styles.ts`)

- **Abas** (`role="tablist"` + `role="tab"`/`aria-selected` + painéis `role="tabpanel"`):
  - **Conexões** — Agente no seu computador (aberto por padrão), Sistemas web, Agentes externos e automações (chaves de API), Instruções pros agentes (MCP).
  - **Organização** — Quadro de tarefas, Projetos, Áreas e tipos.
  - **Sistema** — Status do vault, Backup/export.
- Numeração "1.–7." removida dos títulos (não fazia sentido cruzando grupos).
- **Aba do primeiro paint decidida no servidor** pelos redirects existentes: `?saved=board|projects|taxonomy` abre Organização, `?saved=backup` abre Sistema, resto abre Conexões — zero mudança nos endpoints.
- **Deep links por hash** resolvidos no client (`config-script.ts`): `#organizacao` ativa a aba; `#board`/`#taxonomy`/`#prefs`/`#api-keys`/`#owner-instructions`/`#backup` ativam a aba pai, abrem o `<details>` e fazem scroll. Roda no load e em `hashchange` (navegação same-document não reexecuta script).
- **Teclado:** setas esquerda/direita + Home/End circulam as abas (roving tabindex).
- **Sem JS:** `<noscript>` mostra todos os painéis empilhados e esconde a barra de abas — nada fica inalcançável.
- CSS novo em `styles.ts` (`.config-tabs`, `.config-panel`): sublinhado lavanda na aba ativa, overflow-x com scrollbar oculta no mobile.

### 2. Início absorve o Journal (opção A) (`home.ts`, `journal.ts`, `client/journal.ts`, `client/home.ts`, `render.ts`)

- A home ganhou a seção **"Atividade"** abaixo dos cards: filtros (Notas/Tarefas/Interações) + feed agrupado por dia + "Carregar mais" — o Journal inteiro.
- **Lazy-load preservando a regra da spec 65** ("home lenta por depender do proxy"): o SSR entrega só o esqueleto (`#journal-groups data-lazy="1"`); `journal.bundle.js` busca a 1ª página em JSON de `/app/journal` (mesma resposta do "Carregar mais", que ganhou o campo `degraded`) e injeta. O proxy do Contacts continua FORA do request path da home.
- **Card "Últimas interações" removido** — era subconjunto do feed (informação duplicada). O código de fetch correspondente saiu de `client/home.ts`; o endpoint `/app/contacts/events/recent` permanece (API).
- **Journal saiu da navegação** (sidebar 7 itens, bottom-nav 8): ícone e item removidos de `render.ts`; `active` perdeu o membro `'journal'`.
- **Rota `/app/journal`:**
  - JSON (accept: application/json): inalterada — fonte de dados do feed (1ª página lazy + paginação).
  - HTML sem querystring: **302 → `/app`** (bookmark antigo cai na home).
  - HTML com querystring: página standalone "Atividade" (fallback de paginação sem JS + `<noscript>` da home aponta pra `/app/journal?feed=1`).
- Inbox permanece tela própria de triagem (PWA share_target continua em `/app/inbox`).

## Fora de escopo

- Variante B (home absorver também a triagem do Inbox) — decisão futura do dono.
- Remover o endpoint `/app/contacts/events/recent` — segue como API.
- Entrada no changelog de Novidades (`releases-data.ts`) — vai junto com o release da Onda 7.

## Critérios de aceite

- [x] Config: 3 abas com conteúdo correto; troca por clique, hash, `?saved=` e teclado; sem JS tudo visível — verificado no navegador (desktop 1440 e mobile 390, zero overflow horizontal).
- [x] Home: feed carrega lazy (30 itens), filtros funcionam, "Carregar mais" anexa 30 sem duplicar (chave título+href+tipo+hora: 0 duplicatas), estado degradado sinalizado.
- [x] `/app/journal` HTML sem query → 302 `/app`; com query → standalone "Atividade"; JSON → dados.
- [x] Journal fora da sidebar e da bottom-nav em todas as páginas.
- [x] Suítes verdes: typecheck 4 tsconfigs, vitest 86 arquivos/794 + auth 2/5, client jsdom 38/38, e2e Playwright 22/22.
- [x] Audit wave-6-5: 32/32 capturas + contact sheet vs baseline (`C:\tmp\ux-audit\wave-6-5\contact-sheet.html`).
- [x] Testes atualizados no MESMO commit: `test/web/journal.test.ts` (novo contrato da rota), `test/web/home.test.ts` (feed lazy + nav), `src/web/config.test.ts` (marcador da home), `e2e/home.spec.ts` (lazy + redirect), `scripts/ux-audit/screens.py` (07-journal → `?feed=1`).

## Evidência de execução (08/07/2026)

- Navegador (Playwright): abas trocam com clique/hash/hashchange/setas; deep link `#board` ativa Organização + abre a gaveta + scroll; `?saved=backup#backup` abre Sistema no primeiro paint. Home: 30→60 itens no Carregar mais, 0 erros de console, filtro Tarefas oculta/restaura itens.
- Capturas: `C:\tmp\ux-audit\wave-6-5\` (12-config e 02-home desktop+mobile revisadas manualmente; artefatos conhecidos de captura full-page — gradiente fixed e nav fixa pintada no meio — presentes como nas waves anteriores, não são bugs).
