# Fleet view: painel operacional da frota de agentes

> **Status:** shipped (12/07/2026) · **Prioridade:** P1 · **Esforço:** M-L · **Repo:** expert-brain
> Renumerada de 89→92 no ship (colisão com `89-watchdog-board-aprovacoes-deploy.md`).
> **Depende de:** `81-assinatura-por-credencial` (shipped), `86-chave-pertence-ao-usuario` (shipped), `82-mencao-mailbox-por-agente` (shipped) · suaves: `83-heartbeat-wakeup` (sinal de "visto por último"), `88-claim-comentarios-tipados-aprovacoes` (fila de aprovação), `91-experiencia-premium/98` (config redesign — o card de agente de lá linka pra cá)

## Contexto

Depois das specs 81-88, a frota existe DE VERDADE no dado: identidade por credencial
(`users` tipo agent + `api_keys.user_id`), autoria assinada em comentários e writes,
mailbox por agente com `/api/mailbox/summary`, claims/lease de task (migration 0027) e a
coluna "Validação humana" no board (11/07/2026) onde entregas aguardam o dono.

A ÚNICA superfície disso no console é a tabela de chaves em `/app/config`
(`src/web/api-keys.ts`) — uma lista administrativa, não um painel. O dono não tem onde
ver, de relance: quais agentes estão vivos, o que cada um fez hoje, o que está travado
esperando ele.

Sinais já disponíveis, sem coleta nova:

- **Vivo/último uso**: `api_keys.last_used_at` (`src/db/migrate.ts:91`), atualizado a
  cada request autenticada.
- **O que fez**: `task_activity` (`src/db/task-activity.ts`) + autoria por credencial em
  notas (`created_by`/`updated_by`) e comentários.
- **O que espera o dono**: tasks na coluna `Validação humana` + aprovações pendentes da
  spec 88 + menções não-ack no mailbox.
- **Identidade visual**: avatar/nome/tipo em `users` (spec 86).

## Problema / Motivação

- O diferencial do produto (frota de agentes operando o vault) é INVISÍVEL na UI — a
  única janela é `src/web/api-keys.ts`, que mostra hash de chave, não trabalho.
- A regra de Validação humana criou uma fila que o dono precisa varrer manualmente no
  board; não há contador nem visão "o que espera por mim, por agente".
- Sem "visto por último", diagnosticar agente mudo (container caído, PAT revogado)
  exige SSH — o console tem o dado (`last_used_at`) e não mostra.

## Objetivo

Uma tela onde o dono responde em 10 segundos: quem da frota está ativo, o que cada
agente fez hoje, e o que está parado esperando decisão dele.

## Design proposto

1. **Rota `/app/fleet`** (novo `src/web/fleet.ts`), entrada na navegação
   (`src/web/render.ts`) — nome visível: "Agentes".
2. **Grid de cards, 1 por usuário tipo agent** (dados de `users` + `api_keys`):
   - Cabeçalho: avatar, nome, badge de status derivado de `last_used_at`:
     ativo (< 15 min), hoje, dormindo (> 24h), sem uso (nunca) — thresholds em constante.
   - Linha de atividade: contagens de HOJE (BRT) — tasks tocadas (via `task_activity`),
     notas criadas/atualizadas (autoria por credencial), comentários.
   - Pendências que o AGENTE espera: menções não-ack no mailbox (mesma fonte do
     `/api/mailbox/summary`).
   - Link "ver trabalho" → journal/board filtrado pelo agente (reusar filtros existentes;
     se o journal não filtra por autor, adicionar query param é parte desta spec).
3. **Faixa "Esperando você"** no topo da tela (a razão de existir do painel):
   - Tasks na coluna "Validação humana", com card compacto (título, agente que entregou,
     há quanto tempo) e ações rápidas: aprovar (mover pra coluna done default) ou
     devolver (mover pra execução) — reusando `moveTaskToColumn` de `src/db/queries.ts`
     (invariante coluna→status preservado) e o log de atividade.
   - Aprovações tipadas pendentes da spec 88, quando houver.
4. **Card resumo na home** (`src/web/home.ts`): "Frota: N ativos · M esperando você" —
   clique leva a `/app/fleet`.
5. **Custo**: 1 query agregada por bloco (agentes+chaves, atividade do dia, fila de
   validação), payload server-rendered; sem polling — refresh manual/naveção (real-time
   fica fora de escopo).

## Fora de escopo

- Comandar agentes pelo console (mandar instrução, acordar container) — o barramento é
  o board (decisão board-only do grupo 80); no máximo criar task já atribuída.
- Telemetria nova, heartbeat push, WebSocket/real-time.
- Gráficos históricos de produtividade (é a `91-experiencia-premium/99`).
- Gestão de chaves (continua na config; o card linka).

## Critérios de aceite

- [ ] `/app/fleet` lista todos os usuários tipo agent com badge de status coerente com `api_keys.last_used_at` (validado manipulando o dado em dev).
- [ ] Contagens de "hoje" batem com SQL manual em base seedada (janela BRT).
- [ ] Faixa "Esperando você" mostra as tasks da coluna Validação humana; aprovar move pra concluída (com `completed_at`) e devolver move pra execução — ambos registrando em `task_activity`.
- [ ] Agente sem chave vinculada aparece com estado "sem credencial" (não some da lista).
- [ ] Card resumo na home mostra os dois números e navega pro painel.
- [ ] Tela legível em mobile 390px (cards empilhados).

## Validação

- Typecheck + vitest verdes; testes das queries de status/atividade/fila (seed com 2
  agentes + 1 pessoa) e das ações aprovar/devolver (invariante coluna→status).
- Teste manual em dev com dados reais anonimizados: derrubar/usar uma chave e ver o
  badge mudar.
- Gate de deploy: OK explícito do dono.

## Arquivos afetados

- `src/web/fleet.ts` (novo), `src/web/handler.ts` (rota), `src/web/render.ts` (nav)
- `src/web/home.ts` (card resumo)
- `src/db/queries.ts` / `src/db/task-activity.ts` (agregações; reuso de `moveTaskToColumn`)
- `src/web/styles.ts` (cards de agente/badges — reusar biblioteca da onda 3)

## Riscos e reversão

Read-heavy e aditivo; as únicas escritas (aprovar/devolver) reusam o caminho já testado
do board. Risco de interpretação: `last_used_at` é da CHAVE, não do processo — agente
com múltiplas chaves ou chave compartilhada mostraria status enganoso; a spec 86 (1 PAT
por dispositivo) é pré-condição e deve ser afirmada na tela (tooltip do badge).
Reversão: remover rota + card da home.

## Decisões do ship (12/07/2026)

- **Badge sem gap**: o draft dizia "dormindo > 24h", deixando buraco entre o fim do dia
  BRT e 24h. Régua final: ativo agora (< 15min) → ativo hoje (dia BRT corrente) →
  dormindo (antes do dia corrente, com carimbo de quando) → sem uso (chave nunca usada)
  → sem credencial (nenhuma chave ativa vinculada). Thresholds em `FLEET_ACTIVE_WINDOW_MS`.
- **"Ver trabalho" → board** (`/app/tasks`): nem o journal nem o board têm filtro por
  autor hoje; implementar filtro por autor no journal ficou FORA desta v1 (o board já
  mostra as bolinhas de responsável). Candidato a spec futura se doer.
- **Nav**: entrada "Agentes" só na sidebar desktop — o bottom-nav mobile já está saturado
  (8 itens); acesso mobile pela faixa da home.
- **Card da home = faixa acima do grid** (padrão do "Comece aqui"): linha de navegação
  compacta, fora do sistema de caixas arrastáveis — não mexe em home-prefs.
- **CSS via extraHead** (padrão do journal): nada no styles.css global, zero rebuild de
  bundle client. Banner de bloqueios reusa `.task-awaiting-*` do board via
  `awaitingBannerHtml` (mesma UI nas duas superfícies).
- **Contagens de hoje**: "task tocada" = edição em `task_activity` OU task criada hoje
  (criação não loga activity), deduplicada; "nota" = `kind != 'task'`; comentários por
  `author_user_id`. Autoria via JOIN em `api_keys` (actor = id da chave).
- **Mailbox no card** = total de não-lidas do agente (todas as kinds, mesma régua do
  `/api/mailbox/summary`), não só menções.
- Arquivos: `src/db/fleet-queries.ts` + `src/web/fleet.ts` (novos), rotas em
  `src/web/handler.ts`, nav em `render.ts`, faixa em `home.ts`, `dotHue`/`dotInitials`
  exportados de `util/task-badges.ts`. Testes: `test/fleet-web.test.ts` (11).

## Redesign 14/07/2026 (pedido do dono: "UX e UI péssima")

Alinhado ao design system da config (spec 91/106) e a padrões de dashboard
operacional (alertas primeiro, números com peso, estado escaneável por cor):

- **Subtítulo-resumo** sob o h1 — "X de N ativos hoje · M entregas esperando sua
  validação" — responde a pergunta da tela sem ler os cards; link "Abrir board"
  único no topo (o botão "Ver no board" repetido em TODO card foi removido —
  ação idêntica N vezes é ruído).
- **Badge → dot**: o pill de status virou `status-dot` + rótulo curto (verde
  pulsando = ativo agora, verde = hoje, âmbar = sem credencial, cinza =
  dormindo/sem uso), mesmo vocabulário do restante do console. O carimbo
  "visto há Xh" saiu do badge e virou linha sob o nome (`seenLine`); o
  timestamp completo continua no title. Pulse respeita prefers-reduced-motion.
- **Grid ordenado por estado** (`agentRank`): sem credencial (quebrado, pede
  ação — borda âmbar) → ativo agora → ativo hoje → dormindo (visto recente
  primeiro) → sem uso. Ordem de criação não diz nada num painel.
- **Stats com número forte** (`<strong>N</strong> tasks`); stat ZERADA some
  ("0 comentários" é ruído) — tudo zero mantém "Sem atividade hoje." (string
  dos testes). Mailbox: "N não lidos no mailbox" com title explicando.
- **Faixa Esperando você** na anatomia cfg-head (contagem `cfg-status warn` à
  direita), desc de 1 linha; entrega parada >24h ganha meta âmbar (`stale`).
  Devolver virou btn-ghost (hierarquia: Aprovar é a ação primária).
- Labels de status e strings asseridas nos testes preservadas; `agentStatus`
  agora retorna rótulo curto ("dormindo" sem o carimbo).
