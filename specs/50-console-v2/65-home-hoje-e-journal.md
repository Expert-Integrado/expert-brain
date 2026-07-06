# Home "Hoje" + Journal: o eixo temporal cross-módulo do console

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** ambos (expert-brain + 1 endpoint no expert-contacts)
> **Depende de:** `63` (card de inbox), `64` (bloco de digest). Coordena com `61` (filtro de privado no feed) e `57` (events como fonte do journal).
> **Agente sugerido:** Sonnet (UI/SSR + 1 endpoint) · **Esforço de execução:** padrão

## Contexto

- O console não tem "home": cada módulo (`/app/notes`, `/app/tasks`, `/app/graph`, `/app/contacts`) é uma ilha; o dono navega por memória de URL. O shell de navegação vive em `src/web/layout.ts`.
- A pergunta "o que aconteceu hoje/essa semana?" não tem resposta em NENHUMA tela: notas têm `created_at`/`updated_at`, tasks têm `completed_at` (migration `0006`), interações de contato têm `events.ts` (contacts) — três históricos que nunca se encontram.
- O contacts NÃO tem endpoint de eventos globais (só por entidade — e a `57` cria o paginado por entidade). O Brain acessa o contacts via service binding + Bearer read-only.
- O digest da `64` fica cacheado na tabela `meta`; o inbox da `63` tem contagem de pendentes.

## Problema / Motivação

- Abrir o console e "se orientar" custa 4 navegações. A home certa responde em 1 tela: o que vence hoje, o que entrou cru (inbox), o que o cérebro quer lembrar (digest), o que aconteceu por último.
- Sem eixo temporal, a sensação de progresso some — "concluí o quê essa semana?" exige varrer o board de tasks manualmente.

## Design proposto

### 1. Contacts: endpoint novo `GET /app/events/recent`

- Query params `offset=0&limit=30` (cap 100); retorna `{ total, events: [{id, entity_id, entity_name, kind, ts, context}] }` com JOIN em `entities` pro nome — ordenado `ts DESC`.
- Auth: mesma allowlist GET do Bearer read-only (`CONTACTS_PROXY_TOKEN`) + sessão. **Filtro de privacidade da `61`**: sem include-private, evento privado e evento de entidade privada ficam fora (e fora do `total`). Se a 61 ainda não rodou, servir tudo (colunas não existem) — anotar no código.
- Proxy no Brain: rota de sessão `GET /app/contacts/events/recent` → repassa via service binding (padrão dos proxies da 56/57).

### 2. Home `/app/` (rota raiz do console logado)

SSR + client bundle leve (padrão das páginas existentes), 4 cards em grid responsivo:

1. **Hoje** — tasks due hoje/atrasadas (query `listTasksDueBefore` existente), com quick-complete (checkbox → endpoint de complete existente) e link "board completo".
2. **Inbox** — contagem de pendentes + 3 mais recentes (1 linha cada) + link `/app/inbox` (63). Card omitido se a 63 não rodou.
3. **Do seu cérebro** — payload do digest da `64` (cache da `meta`), com as ações de 1 clique definidas lá. Card omitido sem cache.
4. **Últimas interações** — 5 mais recentes do endpoint novo (nome + kind + quando), link "journal completo".

A raiz `/app` (hoje redireciona — `src/web/handler.ts:21` já trata `/app`/`/app/`) passa a renderizar a home; os links do shell (`layout.ts`) ganham "Início". Ao rodar, atualizar também o `start_url` do `assets/manifest.webmanifest` pra `/app` (ver spec `68`).

### 3. Journal `/app/journal` (feed cronológico unificado)

- Feed paginado (30/página, "Carregar mais") mesclando 3 fontes por timestamp desc:
  - **Notas** criadas/atualizadas (D1 local: `created_at`/`updated_at`, dedupe: atualização de nota criada no mesmo dia = 1 entrada).
  - **Tasks** concluídas (`completed_at`) e criadas.
  - **Interações** de contatos (endpoint do item 1, mesma paginação por cursor de data).
- Cada entrada: ícone por tipo, hora BRT, título linkado, chip do módulo. Agrupamento por dia ("Hoje", "Ontem", data).
- Merge: buscar `limit` de cada fonte a partir do cursor, mesclar em memória, cortar em 30, devolver cursor por fonte (payload `{items, cursors}`) — sem tabela nova, sem índice novo (colunas de data já indexadas ou volume baixo).
- Filtros por tipo (checkboxes client-side: notas/tasks/interações).

### 4. Privacidade (herda tudo)

Home e journal são superfícies de SESSÃO (dono) — veem privados com badge (31/59) e pedem include-private no proxy (61). Nenhum caminho novo pra PAT/Bearer além do endpoint do item 1 (que filtra fail-closed).

## Fora de escopo

- Feed em tempo real/websocket (reload manual basta).
- Journal editável (é uma VISTA derivada; escrever é nos módulos).
- Métricas/analytics agregadas (contagens por semana, streaks).
- Notas de diário manuais estilo Logseq (se o dono quiser "nota do dia", é uma nota comum — candidata futura).
- Entrada de e-mails/WhatsApp no journal (fica com as specs de ingestão 35/45).

## Critérios de aceite

- [x] `/app` logado renderiza a home com os 4 cards; cards de specs não-rodadas são omitidos sem erro.
- [x] Quick-complete na home conclui a task (mesma semântica do board) e o card atualiza.
- [x] `/app/journal`: fixture com notas+tasks+eventos intercalados renderiza em ordem cronológica com agrupamento por dia; "Carregar mais" pagina sem duplicar nem pular item (teste do merge de cursores).
- [x] `GET /app/events/recent` no contacts: pagina, respeita cap, Bearer read-only funciona, path fora da allowlist segue 401; com a 61 aplicada, privados fora (e fora do total) sem include-private.
- [x] Falha do proxy de contatos: home e journal degradam (card/fonte omitidos com aviso), não quebram.
- [x] Navegação do shell ganha "Início"; nenhuma rota existente muda de comportamento.

## Validação

- Brain: `npm run typecheck` + `npm test`; Contacts: `npx tsc --noEmit` + `npm test` — verdes; testes novos: merge de cursores (3 fontes, empates de timestamp), endpoint recent (auth + paginação), render da home com cards parciais.
- Manual (`wrangler dev` nos dois): abrir home, concluir task, navegar journal.
- **Gate de deploy:** os DOIS workers só com OK explícito do dono.

## Arquivos afetados

- expert-brain: `src/web/home.ts` + `src/web/journal.ts` (novos), `src/web/client/` (bundles novos + entry no `scripts/build-bundles.ts`), `src/web/layout.ts` (nav), `src/web/handler.ts` (rotas `/app`, `/app/journal`, proxy recent), `src/web/contacts-data.ts` (proxy), `test/`
- expert-contacts: `src/web/` (handler `events/recent` + allowlist), `test/`

## Riscos e reversão

- **Risco**: merge de 3 fontes paginadas duplicar/pular itens em empates. Mitigação: cursor composto `(ts, id)` por fonte + teste dedicado.
- **Risco**: home lenta por depender do proxy no request. Mitigação: card de interações carrega async no client (SSR renderiza esqueleto); digest vem de cache local.
- **Reversão**: revert do código; rota `/app` volta ao comportamento anterior. Nenhuma migration.
