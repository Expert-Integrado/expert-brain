# 94 — WIP cap por agente + aging automático de task parada

> Status: implementado. Origem: item diferido da spec 88 (benchmark 11/07/2026,
> "fora de escopo — vira tasks no board"), executado em 14-15/07/2026.

## Problema

A spec 88 deu à frota claim/lease, comentários tipados e a fila "aguardando o
dono" — mas dois riscos de acúmulo continuavam sem controle ativo:

1. **Um agente pode acumular claims demais.** Nada impedia uma instância de
   claimar 10 tasks em sequência e nunca soltar nenhuma — outras instâncias
   ficam sem trabalho disponível mesmo com capacidade ociosa.
2. **Task esquecida em `in_progress` fica presa "para sempre" (na prática).**
   O único sinal passivo era o `stale: true` do `list_tasks` (60 dias, só
   informativo — ninguém age). Um agente que travou no meio de um trabalho e
   nunca chamou `release`/`complete` deixava a task ocupando a fila
   indefinidamente (mesmo com o lease técnico expirando, o `status` continuava
   `in_progress` e a task não voltava a aparecer como disponível pra ninguém
   decidir retomar).

## Desenho

### 1. WIP cap (`claim_task`)

Env var opt-in `FLEET_WIP_CAP` (ausente/vazia = sem limite, compat
retroativo — mesmo padrão de `TASK_AUTOCANCEL_AFTER_DAYS`). Setada com N > 0:
`claim_task` conta quantos claims ATIVOS (lease não vencido) o usuário já
detém via `countActiveClaims` (nova query em `src/db/queries.ts`) e rejeita um
claim **novo** (task diferente da já detida) quando a contagem já está no
teto — erro orientado nomeando o teto e instruindo a soltar/terminar algo
antes, nunca retry em loop.

Duas exceções deliberadas, ambas cobertas por teste:
- **Renovar o claim da MESMA task nunca conta contra o teto** — senão o
  próprio agente trabalhando ficaria travado de renovar o lease da task que já
  é dele.
- **Lease vencido não conta** — mesma semântica de `claimActive`/`claimTask`:
  expiração é avaliada na leitura, sem cron de limpeza.

### 2. Aging automático (`runTaskAging`, `src/task-lifecycle.ts`)

Env var opt-in `TASK_AGING_AFTER_DAYS` (ausente/vazia = DESLIGADO, mesmo
padrão do autocancel). Setada com N > 0, roda no braço diário já existente do
cron consolidado (`dispatchDaily` em `src/scheduled.ts` — **não** cria um 6º
cron trigger; o plano free do Cloudflare já está no teto de 5 desde a spec 89):

- Alvo: task `status = 'in_progress'` sem NENHUM update (`updated_at`) há mais
  de N dias.
- Ação: `status` volta a `open` (realocada pra coluna default da categoria,
  mesmo invariante do Kanban que o autocancel já respeita), o claim é limpo
  (`claimed_by`/`claimed_at`/`claim_expires_at` = NULL — reabrir sem soltar
  deixaria a task fora da fila `available:true` mesmo livre pro board), nota
  apensada ao `body` (nunca substitui) e um comentário `[info]` automático no
  thread (`author: 'agent'`, sem `author_user_id` — escrita de sistema, sem
  credencial por trás; `author_name: 'cron:aging'` como rótulo).
- **Nunca cancela, nunca apaga** — devolve pra fila com rastro auditável.
  Reversível manualmente via `update_task` se o dono discordar do reopen.

## Por que não uma migration nova

Nenhuma coluna nova: o aging só lê/escreve `status`, `updated_at`, `body` e as
3 colunas de claim já criadas na migration 0027 (spec 88). O WIP cap só lê
essas mesmas colunas de claim via `COUNT`. Puramente aditivo em código.

## Testes

- `test/tools/claim-task.test.ts` — describe `WIP cap por agente`: sem env var
  = sem limite; com o teto, novo claim acima do limite é rejeitado; renovar a
  mesma task no teto é sempre permitido; lease vencido não conta.
- `test/task-lifecycle.test.ts` — describe `runTaskAging`: sem env var =
  no-op; com a var, reabre só `in_progress` parada há N+ dias (não mexe em
  `open`/`done`, nem em `in_progress` tocada recentemente), solta o claim e
  grava exatamente 1 comentário `[info]`; var inválida = no-op.

## Fora de escopo (não tocado nesta spec)

- Webhook wake, definition-of-done + verifier, telemetria de custo por task —
  seguem como itens futuros do roadmap da frota (spec 90).
