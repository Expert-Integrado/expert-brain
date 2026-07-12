# Spec 90 — Wake fast-path: long-poll do mailbox (latência de minutos → segundos)

> Grupo 80-frota-agentes. Diferido do benchmark de 11/07/2026 (spec 88 §fora-de-escopo,
> task a5nr6dwfjxuz). Status: implementado 12/07/2026, aguardando deploy.

## Problema

A frota acorda por polling `*/30` (cron do host VPS, daemon residente do PC, heartbeat
do OpenClaw). Entre um `[pedido]`/menção/atribuição nascer no board e o agente reagir,
a latência média é ~15min (pior caso 30min). Pra conversa agente↔agente (spec 84,
máx 3 rodadas) isso vira ~45min por rodada — o board funciona, mas parece correio.

## Decisão: long-poll, não webhook

O sketch original da task propunha webhook (Worker → POST num endpoint por
dispositivo). Descartado na v1 pelo terreno real da frota:

- **PC Desktop está atrás de NAT** — o Worker não alcança um listener local sem
  túnel (Cloudflare Tunnel = mais uma peça de infra residente pra operar).
- **VPS precisaria de porta aberta + HMAC** — listener residente + secret distribuído
  + firewall. O custo residente é o mesmo do long-poll, com MAIS superfície.
- **OpenClaw não tem API de wake** — ficaria de fora de qualquer jeito.

Long-poll entrega o mesmo corte de latência com UMA peça só, do lado que já
autentica: o dispositivo segura um `GET /api/mailbox/wait` aberto (~25s); o Worker
responde na hora em que nasce item não-lido. Zero porta inbound, zero secret novo
(reusa o PAT do dispositivo), zero migration, e funciona idêntico pra PC e VPS.
Padrão híbrido 2026 (Linear/Copilot agents): fast-path + polling como reconciliador —
o `*/30` continua exatamente como está, cobrindo queda do long-poll, restart e drift.

## Worker: `GET /api/mailbox/wait`

Vive em `src/web/mailbox-api.ts`, ao lado do `/api/mailbox/summary` (spec 83), com a
MESMA identidade e régua de visibilidade:

- Auth: `Bearer eb_pat_...` (401 sem/inválido); credencial sem usuário vinculado →
  403 instrutivo (igual summary). Escopo `private` decide se task privada conta
  (fail-closed).
- Query: `?timeout=<s>` (clamp 0–25, default 25). `timeout=0` = check único imediato
  (vira um summary binário barato).
- Loop: checa `countMailboxUnread` na entrada; unread > 0 → responde na hora.
  Senão dorme `WAIT_POLL_MS` (3s) e re-checa, até o timeout. Latência de detecção ≤3s.
- Resposta: `{ user: {id,name}, wake: boolean, unread, waited_ms }`, `no-store`.
  SEM side-effect — `read_at` intocado (ack continua ato explícito pós-ação).
- Orçamento free tier: pior caso ~12 subrequests D1 por chamada (cap 50). Três
  long-pollers 24/7 ≈ 10,4k req/dia (cap 100k) + ~90k reads D1/dia (cap 5M). Folga.
- O núcleo do loop é `waitForUnread(check, timeoutMs, pollMs, sleep)` — função pura
  exportada, testável sem relógio real.

Rotas: `src/auth/handler.ts` (prod) + espelho em `src/web/worker.ts` (mesmo padrão
do summary/whoami).

## Consumidores

- **PC Desktop** (`~/.claude/fleet/brain-heartbeat-daemon.js`): ganha um loop de
  long-poll paralelo à batida :00/:30 (que fica como reconciliador). `wake:true` →
  mesmo `runClaude()` de sempre (lock e child único preservados), com guarda de
  re-spawn (mín 120s entre spawns disparados por wake — o ciclo já acka, mas se o
  ack falhar o wait re-dispararia em loop). Erro/404 (pré-deploy) → backoff
  exponencial até 15min, logando só transição (não enche o log). Seguro atualizar
  ANTES do deploy: o endpoint 404 cai no backoff e o daemon segue no timer.
- **VPS (2 containers)**: mesmo desenho como daemon residente no HOST (systemd),
  reusando os injetores existentes (`brain-mailbox-heartbeat*.sh`). Instalação é
  cirurgia por SSH e só faz sentido com o endpoint no ar → runbook completo em
  `docs/frota-heartbeat.md`, instalar PÓS-deploy.
- **OpenClaw**: fica no polling de 30min (heartbeat interno, sem loop residente
  nosso). Se um dia expuser wake API, o webhook clássico volta à mesa só pra ele.

## Fora de escopo (continua na fila da spec 88)

Subtasks/deps (a19zjy5k7cqe), DoD+verifier (94dx43u58s5v), WIP/aging (wconxc3a9p9c),
telemetria de custo (llidmyyusqvm).

## Registro de implantação

- 12/07/2026 ~01h-02h: endpoint + testes + daemon do PC implementados (sessão
  interativa do PC, task a5nr6dwfjxuz claimada). Deploy do Worker GATED em OK do
  Eric (regra de deploy de produção); instalação VPS na sequência do deploy.
