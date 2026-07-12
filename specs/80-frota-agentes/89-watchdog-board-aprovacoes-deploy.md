# 89 — Watchdog da frota, fila de aprovação no board e deploy sem janela

> Status: implementado. Origem: rodada 2 do benchmark de 11/07/2026 ("q mais pode
> melhorar?"), aprovada pelo dono ("Pode aplicar todos"). Completa a spec 88.

## Problema

1. **A frota falha em silêncio.** No mesmo dia: o heartbeat do PC ficou 2h morto
   (CronCreate de sessão nunca disparou) e o OpenClaw perdeu 2 ciclos (heartbeat
   global desligado por engano). Ninguém detecta agente mudo — o dono descobre
   quando sente falta.
2. **A fila "aguardando o dono" (spec 88) não tem superfície visual.** Existe via
   MCP (`awaiting_owner:true`) e push, mas o board — a tela que o dono realmente
   abre — não mostra nem a fila nem QUEM está trabalhando cada task (claim).
3. **Deploy tem janela de quebra.** O incidente da spec 88: `wrangler deploy` subiu
   código que lê colunas novas ANTES do provision aplicar a migration → ~3min de
   leituras quebradas. Com token de provision inválido, a janela vira indefinida.

## Desenho

### 1. Watchdog da frota (cron */30 + Telegram)

Zero config e zero falso-positivo para agentes esporádicos (Alexa, notebook),
usando só o `last_used_at` que `api_keys` já mantém por request:

- **Streak em KV** (`watchdog:<user_id>:streak`): a cada rodada do cron (30min),
  agente com atividade na janela recente incrementa o streak. Agente com
  `streak >= 4` (2h de batidas consistentes) é considerado MONITORADO — só quem
  provou cadência entra no radar. Uso esporádico nunca acumula streak 4 → nunca
  alerta.
- **Silêncio >= 2h** de um monitorado → alerta no Telegram (mesmo canal dos alertas
  de cron, no-op seguro sem secrets) UMA vez (flag `watchdog:<id>:alerted`), e o
  streak zera — sem spam de re-alerta a cada 30min.
- **Recuperação**: agente alertado que volta a bater → aviso de retorno + limpa a
  flag. O ciclo re-arma sozinho.
- Silêncio de 35min-2h = zona neutra (streak congela — beat perdido por /compact
  do tmux não desarma o radar).
- Dispatch por expressão EXATA (`*/30 * * * *`) em `scheduled.ts`, ANTES do
  fail-safe diário — expressão desconhecida cair no digest dispararia o lembrete
  48x/dia. `trackCronOutcome('fleet-watchdog')` cobre falha do próprio watchdog.

### 2. Board: fila "Aguardando você" + chip de claim

- `buildBoard` ganha `awaiting`: as tasks da fila da spec 88 (último `[bloqueio]`
  sem resposta do owner) com o trecho do bloqueio, quem travou e quando. O board
  renderiza um banner acima das colunas (SSR + client em sincronia); vazio = some.
  Clique leva ao detalhe da task (`/app/tasks/<id>`), onde responder no thread já
  tira da fila.
- Cada card ganha o **chip de claim** (spec 88): "⛏ <agente> · até HH:MM" quando
  há lease ATIVO — o dono vê quem está trabalhando o quê agora. Lease vencido não
  renderiza (livre). Helper compartilhado em `util/task-badges.ts` (SSR + client).

### 3. Deploy sem janela (scripts/deploy.mjs)

Preflight ANTES do `wrangler deploy`: resolve o bearer e chama POST
`/setup/provision` na URL do `WORKER_URL` do wrangler.toml (idempotente — aplica
migrations da versão ATUAL, no-op). 401 → **aborta antes de deployar** (o incidente
da spec 88 morre aqui: token inválido nunca mais deixa código novo no ar sem
migration). Sem bearer/URL → warning e segue (preserva o fluxo de primeira
instalação, que provisiona sem auth). Erro de rede no preflight → warning e segue
(transiente não bloqueia deploy; o provision pós-deploy re-tenta como sempre).

## Fora de escopo

- Notebook na frota (task m9uyj6mb7iqv — depende do dono).
- Webhook wake, subtasks, DoD/verifier, WIP/aging, telemetria (tasks do board,
  spec 88 "fora de escopo").

## Registro de implantação (12/07/2026)

Em prod ~00h25 (commits 3d1fdaa, 6646590, 41e42b6, ada3b68; suite 1153/1153 no
tree deployado). Primeiro firing do watchdog provado às 00:30 (outcome
`cron:fleet-watchdog` = sucesso + 5 streaks criados em KV).

**Incidente que mudou o desenho — limite de crons por CONTA:** o plano free do
Cloudflare limita a conta INTEIRA (todos os Workers somados) a 5 cron triggers.
Registrar o 4º cron deste Worker estourou o teto (erro 10072, "You have exceeded
the limit of 5 cron triggers") e o `wrangler deploy` publicava o código mas
falhava nos triggers. Solução de causa raiz: **consolidação em 1 trigger único**
`*/30 * * * *` — o braço do watchdog em `src/scheduled.ts` despacha os jobs de
horário fixo por relógio UTC (backup segunda 05:00, re-pass 08:00, fluxo diário
11:00; todos caem em minuto :00, que o */30 cobre). Braços por expressão exata
mantidos (compat + testes); `runScheduled` ganhou `nowMs` opcional pra teste.
Liberou 2 slots de cron na conta (3 → 1 neste Worker).

**Lição de working tree compartilhado:** duas sessões editando o mesmo repo =
commits por hunk (patch cirúrgico via `git apply --cached`, nunca stash/add -A)
e deploy SEMPRE de worktree limpo no HEAD commitado (`git worktree add` +
`cp wrangler.toml` + `npm ci`; o postinstall `install-hooks.mjs` falha em
worktree porque `.git` é arquivo — inofensivo).
