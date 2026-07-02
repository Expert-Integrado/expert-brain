# Reativação do lembrete diário de tasks no Telegram (gated)

> **Status:** draft · **Prioridade:** P2 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** 30-features/32-task-lifecycle-e-digest-saudavel.md · 40-ops/43-observabilidade-e-alerting.md

## Contexto

O Worker já tem toda a infraestrutura do lembrete proativo de prazo — ela está apenas
**dormente** porque os secrets do Telegram foram removidos de propósito:

- `src/notify.ts:13` — `buildDueDigest()`: função pura que monta o texto do digest
  (atrasadas + vence hoje), com link por task quando `WORKER_URL` está setado.
- `src/notify.ts:35` — `sendTelegram()`: POST em `https://api.telegram.org/bot<token>/sendMessage`.
  **Degrada gracioso**: se `TELEGRAM_BOT_TOKEN` ou `TELEGRAM_CHAT_ID` estiverem ausentes,
  retorna `{ sent: false, reason: 'telegram não configurado (...)' }` sem lançar erro
  (`src/notify.ts:36-38`).
- `src/notify.ts:51` — `runDueReminder()`: orquestra `listTasksDueBefore(env, now + 24h)`
  (`src/db/queries.ts:288`) → `buildDueDigest` → `sendTelegram`.
- `src/index.ts:46` — handler `scheduled()` chama `runDueReminder()` via `ctx.waitUntil`,
  logando resultado (`src/index.ts:49`) ou erro (`src/index.ts:50`).
- `wrangler.toml` (e `wrangler.example.toml`) — `[triggers] crons = ["0 11 * * *"]`
  (11:00 UTC = 08:00 BRT). O cron **dispara todo dia** hoje; só o envio é no-op.
- `src/env.ts:35-36` — `TELEGRAM_BOT_TOKEN?` e `TELEGRAM_CHAT_ID?` declarados opcionais.
- `test/notify.test.ts` — testes existentes de `buildDueDigest`.
- Endpoint de inspeção do mesmo dado do digest: `GET /app/tasks/data?scope=due&horizon_hours=24`
  (`handleTasksData`, `src/web/tasks.ts:63-75`) — útil pra pré-visualizar o conteúdo
  sem enviar nada.

Esta spec é **operacional (runbook)**: quase zero código. O entregável principal é o
documento `docs/telegram-reativacao.md` + a execução gated da reativação.

## Problema / Motivação

1. **Finding backlog-14 — cron dormente sem plano de reativação.** O cron roda
   diariamente (`wrangler.toml`, `[triggers]`) e cai no no-op (`src/notify.ts:36-38`).
   Não existe documentação de COMO religar com segurança, qual bot/canal usar, nem como
   desligar de novo. Religar "na mão" sem critério repete o risco que motivou o
   desligamento.
2. **Religar antes do teto/snooze despeja o backlog inteiro num digest que falha.**
   `buildDueDigest` (`src/notify.ts:26-29`) concatena TODAS as tasks vencidas sem
   limite; a Bot API rejeita `text` > 4096 chars com HTTP 400, e `sendTelegram`
   (`src/notify.ts:44`) só devolve `{ sent: false, reason: 'telegram http 400' }` —
   falha silenciosa exatamente no dia com mais atrasadas. Por isso a spec
   `30-features/32` (cap < 4000 chars + snooze de atrasadas antigas + lifecycle básico)
   é **pré-condição dura**.
3. **Sem observabilidade, uma falha do envio passa despercebida.** Hoje o resultado do
   cron vai só pra `console.log` (`src/index.ts:49`). A spec `40-ops/43` (contador de
   falhas em KV + alerting) precisa estar ativa antes, senão o lembrete pode quebrar e
   ninguém saber.

## Objetivo

Religar o digest diário de tasks no Telegram (cron 11:00 UTC) com bot/canal dedicado,
primeira execução validada manualmente pelo dono e rollback documentado em
`docs/telegram-reativacao.md` — sem nenhum secret entrar no repo.

## Design proposto

### Passo 0 — Gate (não prosseguir sem TODOS)

1. Spec `30-features/32` implementada e deployada: digest com teto < 4000 chars,
   snooze de atrasadas antigas, lifecycle básico. Verificar em `src/notify.ts` que
   `buildDueDigest` aplica o cap (não confiar só no status da spec).
2. Spec `40-ops/43` ativa: falha do cron incrementa contador em KV / gera alerta.
3. **OK explícito do dono do deploy** registrado (issue/PR/comentário) autorizando a
   reativação. Sem OK, parar aqui.

### Passo 1 — Bot e canal dedicados

1. Criar um bot NOVO no `@BotFather` exclusivo pra estes lembretes — **não reutilizar**
   token de bot de nenhum outro sistema do dono (blast radius: se este token vazar,
   compromete só o canal de lembretes).
2. Criar chat/canal dedicado, adicionar o bot e obter o `chat_id` (ex.: enviar uma
   mensagem no chat e ler `https://api.telegram.org/bot<TOKEN>/getUpdates`).
3. Guardar token e chat_id no cofre de secrets do dono (fora do repo).

### Passo 2 — Configurar secrets no Worker (NUNCA no repo)

```sh
wrangler secret put TELEGRAM_BOT_TOKEN   # cola o token do bot dedicado
wrangler secret put TELEGRAM_CHAT_ID     # cola o chat_id do canal dedicado
```

- Secrets via `wrangler secret put` NÃO exigem redeploy — passam a valer no próximo
  invocation. Nenhuma mudança em `wrangler.toml` versionado (o `[vars]` continua sem
  esses valores; `src/env.ts:35-36` já os declara opcionais).
- Conferir com `wrangler secret list` que os dois aparecem.

### Passo 3 — Primeira execução manual, validada pelo dono

1. Pré-visualizar o conteúdo sem enviar: `GET /app/tasks/data?scope=due&horizon_hours=24`
   (autenticado — `src/web/tasks.ts:63`). Confirmar que a lista é a esperada e que,
   pós-spec 32, o volume está sob controle.
2. Disparar o cron manualmente UMA vez — opções:
   - Dashboard Cloudflare → Worker `expert-brain` → Settings → Triggers → Cron →
     "Run now" (ou equivalente na UI atual); ou
   - `wrangler dev --test-scheduled` local + `curl "http://localhost:8787/__scheduled?cron=0+11+*+*+*"`
     apontando pra secrets de teste (validação de formato antes do disparo em prod).
3. Dono confirma no canal Telegram: mensagem chegou, formato legível, links funcionam,
   contagens batem com o preview do item 1.
4. Se o conteúdo estiver errado: rollback imediato (ver seção Riscos) e corrigir antes
   de tentar de novo.

### Passo 4 — Runbook `docs/telegram-reativacao.md` (novo arquivo)

Documento com as seções:

1. **Estado do sistema** — onde vive o código (`src/notify.ts`, `src/index.ts:46`,
   `[triggers]` no `wrangler.toml`), horário do cron (11:00 UTC / 08:00 BRT).
2. **Pré-condições de reativação** — o gate do Passo 0.
3. **Procedimento de ativação** — Passos 1-3 acima, comando a comando.
4. **Comportamento esperado de falha** — `sendTelegram` retorna `{ sent: false, reason:
   'telegram http <status>' }`; o `scheduled()` loga `due-reminder {...}`; a
   observabilidade da spec 43 incrementa o contador de falhas em KV e alerta. Tabela
   rápida: `http 400` = payload inválido/estourado; `http 401/404` = token errado;
   `http 403` = bot removido do chat; `reason: 'telegram não configurado'` = secrets
   ausentes (estado dormente, não é erro).
5. **Rollback** — `wrangler secret delete TELEGRAM_BOT_TOKEN` +
   `wrangler secret delete TELEGRAM_CHAT_ID`. Volta ao no-op seguro
   (`src/notify.ts:36-38`) **sem deploy e sem mudança de código**. Se o token tiver
   vazado, revogar também no `@BotFather` (`/revoke`).
6. **Segurança** — token nunca no repo, nunca no `wrangler.toml` versionado, nunca em
   log; bot dedicado, sem permissões além do canal de lembretes.

### Passo 5 — Ajustes menores em `src/notify.ts` (somente se necessário)

Só se a validação do Passo 3 revelar problema pontual (ex.: formatação, ordem das
seções). Qualquer ajuste mantém `buildDueDigest` pura e coberta em `test/notify.test.ts`.
Sem mudança de schema, sem migration — esta spec não toca no banco.

## Fora de escopo

- Outros canais de notificação (WhatsApp, e-mail, push) — Telegram apenas.
- Digest com horário configurável ou múltiplos crons — fica `0 11 * * *`.
- Teto/snooze/lifecycle do digest — é a spec `30-features/32` (pré-requisito, não parte).
- Alerting/observabilidade do cron — é a spec `40-ops/43` (pré-requisito, não parte).
- Comandos interativos no bot (responder/completar task pelo Telegram).

## Critérios de aceite

- [ ] Gate cumprido e registrado: spec 32 deployada (cap verificado no código), spec 43 ativa, OK explícito do dono documentado.
- [ ] Bot e chat dedicados criados; nenhum token de outro sistema reutilizado.
- [ ] `wrangler secret list` mostra `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`; nenhum dos dois aparece em arquivo versionado (`git grep -i telegram_bot_token` só encontra código/docs, nunca valor).
- [ ] Primeira execução manual enviada e validada pelo dono no canal (conteúdo confere com `GET /app/tasks/data?scope=due`).
- [ ] Execução automática do dia seguinte (11:00 UTC) chegou no canal.
- [ ] `docs/telegram-reativacao.md` existe com as 6 seções (estado, pré-condições, ativação, falhas, rollback, segurança).
- [ ] Rollback testado ou verificado por inspeção: com secrets removidos, `runDueReminder` retorna `reason: 'telegram não configurado (...)'` (comportamento de `src/notify.ts:36-38`, coberto em `test/notify.test.ts`).

## Validação

```sh
npm run typecheck        # tsc --noEmit (duas passadas, ver package.json)
npm test                 # vitest run (inclui test/notify.test.ts)
```

Manual:

1. Preview: `GET /app/tasks/data?scope=due&horizon_hours=24` (autenticado).
2. Disparo manual do cron (dashboard "Run now" ou `wrangler dev --test-scheduled` +
   `curl .../__scheduled?cron=0+11+*+*+*`).
3. Conferir a mensagem no canal Telegram e o log `due-reminder` no Worker
   (`wrangler tail` durante o disparo).

Deploy (se houver ajuste de código do Passo 5) **somente com OK do dono**. A ativação
dos secrets em si também só ocorre após o OK do gate (Passo 0).

## Arquivos afetados

- `docs/telegram-reativacao.md` — **novo** (runbook, entregável principal)
- `src/notify.ts` — ajustes menores SOMENTE se a validação manual exigir
- `test/notify.test.ts` — estendido apenas se `src/notify.ts` mudar

Nenhuma migration. Nenhuma mudança em `wrangler.toml` versionado.

## Riscos e reversão

- **Digest estoura 4096 chars mesmo pós-spec 32** (regressão do cap): mensagem não
  chega, `reason: 'telegram http 400'` no log e no contador da spec 43. Reversão:
  remover os 2 secrets (abaixo) e corrigir o cap antes de religar.
- **Token errado / bot fora do canal**: `http 401/404/403` no log. Reversão idem;
  refazer Passo 1-2.
- **Ruído indesejado (dono acha o lembrete inútil ou invasivo)**: mesmo rollback.
- **Rollback canônico (sem deploy, sem código):**

  ```sh
  wrangler secret delete TELEGRAM_BOT_TOKEN
  wrangler secret delete TELEGRAM_CHAT_ID
  ```

  O cron volta ao no-op seguro no próximo disparo (`src/notify.ts:36-38`). Se houver
  suspeita de vazamento do token, revogar no `@BotFather` (`/revoke`) além de deletar
  os secrets. Nenhum dado do banco é tocado por esta spec, então não há rollback de
  dados a considerar.
