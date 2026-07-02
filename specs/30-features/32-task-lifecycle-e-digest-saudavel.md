# Lifecycle de tasks + digest Telegram com teto e snooze (anti alert-fatigue)

> **Status:** draft · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O Expert Brain tem um sistema de tasks (`kind='task'` na tabela `notes`, com colunas
`status`, `due_at`, `priority`, `completed_at` — migration `0006_task_fields`) e um
lembrete proativo de prazo:

- `src/notify.ts` — `buildDueDigest()` (função pura, linha 13) monta o texto do digest
  diário separando "Atrasadas" de "Vence hoje"; `sendTelegram()` (linha 35) faz o POST
  na Bot API do Telegram; `runDueReminder()` (linha 51) orquestra.
- `src/index.ts:46` — handler `scheduled()` do Worker chama `runDueReminder()` via cron
  diário (`[triggers]` no `wrangler.toml`, 08:00 BRT). O resultado vai só pra
  `console.log` (linha 49).
- `src/db/queries.ts:288` — `listTasksDueBefore()` retorna TODAS as tasks abertas
  (`open`/`in_progress`) com `due_at <= beforeMs`, sem `LIMIT`.
- `src/mcp/tools/list-tasks.ts` — tool MCP `list_tasks` retorna as tasks ativas com
  `overdue: boolean` (linha 66), mas nenhum indicador de task estagnada.
- `src/env.ts:35-36` — `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` são opcionais; ausentes,
  o cron roda em no-op seguro (hoje os secrets estão propositalmente desligados).
- `test/notify.test.ts` — já existe, com 3 testes de `buildDueDigest` (será estendido).

Nenhum mecanismo fecha tasks automaticamente: uma task `open` vencida há meses continua
aparecendo em `listActiveTasks`, `listTasksDueBefore`, no Kanban `/app/tasks` e no digest
— pra sempre, até alguém chamar `complete_task`/`update_task` manualmente.

## Problema / Motivação

1. **Digest sem teto estoura o limite do Telegram e falha INTEIRO, em silêncio.**
   `buildDueDigest` (`src/notify.ts:26-29`) concatena TODAS as atrasadas + todas as de
   hoje, cada linha com título + link (`src/notify.ts:19-24`, ~100-150 chars/task). A
   Bot API do Telegram rejeita `sendMessage` com `text` > 4096 chars (HTTP 400).
   `sendTelegram` (`src/notify.ts:44`) devolve `{ sent: false, reason: 'telegram http 400' }`
   e `src/index.ts:49` só loga. Resultado: justamente o dia com MAIS tasks atrasadas
   (~30+ tasks) é o dia em que NENHUM digest chega — falha silenciosa no pior momento.
2. **Sem lifecycle, o backlog só cresce.** Nada auto-arquiva: `listTasksDueBefore`
   (`src/db/queries.ts:288-297`) e `listActiveTasks` (`src/db/queries.ts:264-271`)
   acumulam tasks mortas, o digest re-avisa a mesma task atrasada todos os dias
   (comentário em `src/notify.ts:7-9` assume que isso "cutuca", mas com dezenas de
   atrasadas antigas vira ruído puro — alert fatigue), e `list_tasks` fica poluído.
3. **`listTasksDueBefore` sem `LIMIT`** (`src/db/queries.ts:289-295`): consulta ilimitada
   alimentando um consumidor com teto físico de 4096 chars.

Esta spec é pré-requisito da spec `40-ops/46` (religar os secrets do Telegram): sem teto
e sem anti-fatigue, religar a notificação hoje = spam diário ou 400 silencioso.

## Objetivo

O digest diário nunca ultrapassa 4000 chars (nunca mais toma HTTP 400 por tamanho),
atrasadas com mais de 14 dias viram contagem agregada em vez de linha a linha, e
`list_tasks` marca tasks estagnadas (`stale`) pro agente sugerir fechamento — tudo
verificado por testes unitários de `buildDueDigest`.

## Design proposto

Sem migration: nenhuma coluna nova. Tudo é mudança de código + (opcional) env var.

### 1. Cap por seção no digest (`src/notify.ts`)

Alterar `buildDueDigest(tasks, now, workerUrl?)` mantendo a assinatura pura (adicionar
parâmetro opcional de config com defaults, pra manter testável):

```ts
export interface DigestOptions {
  maxPerSection?: number;   // default 15
  maxChars?: number;        // default 4000
  staleAfterMs?: number;    // default 14 dias (14 * 86_400_000)
}
export function buildDueDigest(
  tasks: TaskRow[], now: number, workerUrl?: string, opts?: DigestOptions
): string | null
```

Regras, nesta ordem:

1. **Snooze de atrasadas antigas:** particionar `overdue` em `recentes`
   (`now - due_at <= staleAfterMs`) e `antigas`. As antigas NÃO viram linha — entram só
   como uma linha agregada ao final da seção de atrasadas:
   `“…e mais N atrasadas há 14+ dias — revisar em {base}/app/tasks”`.
2. **Cap por seção:** cada seção (Atrasadas recentes, Vence hoje) lista no máximo
   `maxPerSection` tasks. As listas já chegam ordenadas por `due_at ASC, priority ASC`
   (garantido pelo `ORDER BY` de `listTasksDueBefore`, `src/db/queries.ts:294`) — o cap
   corta o excedente e adiciona rodapé `“…e mais X — {base}/app/tasks”`.
3. **Truncagem defensiva:** se mesmo com caps o texto passar de `maxChars`, remover
   linhas do fim (nunca cortar no meio de linha) até caber, preservando o rodapé
   `“…e mais X — {base}/app/tasks”` com X recalculado. Garantia dura:
   `digest.length <= maxChars` SEMPRE.

Os contadores de cabeçalho (`Tasks pra hoje — N`, `Atrasadas (N)`) continuam refletindo
o TOTAL real, não o número de linhas exibidas.

### 2. LIMIT defensivo em `listTasksDueBefore` (`src/db/queries.ts`)

Adicionar parâmetro `limit = 200` e `LIMIT ?` na query (linha 294). 200 é folga ampla
(o digest usa no máximo ~30 linhas), mas impede leitura ilimitada. Nenhum outro caller
muda de comportamento (`list-tasks-due-today` herda o default).

### 3. Marcador `stale` no `list_tasks` (`src/mcp/tools/list-tasks.ts`)

Abordagem menos invasiva primeiro (decisão do scopeNotes: começar por stale marker,
escalar pra auto-cancel só se não bastar). No mapeamento dos items (linha 58-69),
adicionar:

```ts
stale: (t.status === 'open' || t.status === 'in_progress')
  && now - t.updated_at > 60 * 86_400_000,  // sem update há >60 dias
```

E acrescentar 1 frase à `DESCRIPTION` da tool instruindo o agente: task com
`stale: true` → sugerir ao dono cancelar (`update_task` com `status: 'canceled'`) ou
repriorizar. Nenhuma escrita automática.

### 4. Auto-cancel atrás de env var (opcional, desligado por default)

Preparar a escalada sem impor aos usuários do repo (open-source, alunos usam):

- `src/env.ts`: nova var opcional `TASK_AUTOCANCEL_AFTER_DAYS?: string` (documentada:
  ausente/vazia = desligado).
- `src/notify.ts` (ou módulo novo `src/task-lifecycle.ts`): função
  `runTaskAutocancel(env, now)` — se a env var estiver setada e for número > 0, marcar
  como `canceled` toda task `open` com `due_at < now - N dias` E
  `updated_at < now - N dias` (as duas condições, pra não cancelar task tocada
  recentemente). Reusar o padrão de `setTaskStatus` (`src/db/queries.ts:301`) num UPDATE
  em lote, com append no `body`:
  `“\n\n**Auto-cancelada:** vencida há mais de N dias sem atividade (reversível via update_task).”`
- `src/index.ts` `scheduled()`: chamar `runTaskAutocancel` via `ctx.waitUntil` ao lado
  de `runDueReminder`. Com a var ausente, retorna `{ canceled: 0, reason: 'desligado' }`
  sem tocar o banco.
- É update de `status` — reversível por task via `update_task { status: 'open' }`.
  NUNCA deletar nem soft-deletar.

### Invariantes

- Nenhuma migration; nenhum dado existente é alterado sem a env var explícita.
- `buildDueDigest` continua função pura (sem `Date.now()`, sem I/O) — testável direto.
- Nenhum passo desta spec seta os secrets do Telegram nem religa notificação.

## Fora de escopo

- Religar os secrets `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (spec `40-ops/46`, que
  depende desta). **Gate: nenhum deploy desta spec religa notificação.**
- Múltiplos canais de notificação (WhatsApp, e-mail, etc.).
- Snooze por task individual (coluna `snoozed_until`) — exigiria migration; só se o
  stale marker + agregação de antigas não bastarem.
- Mudanças no Kanban `/app/tasks` (UI web).
- Parse mode / formatação Markdown no Telegram (mantém texto puro).

## Critérios de aceite

- [ ] `buildDueDigest` com 100 tasks atrasadas + 50 de hoje produz digest com no máximo
      15 linhas por seção, rodapé "e mais X" em cada seção truncada e `length <= 4000`.
- [ ] Atrasadas há mais de 14 dias não aparecem linha a linha — só na contagem agregada
      com link pra `/app/tasks`.
- [ ] Contadores de cabeçalho (`Atrasadas (N)`, total) refletem o total real, não o
      número de linhas exibidas.
- [ ] Comportamento atual preservado pra volumes pequenos: com <= 15 tasks recentes por
      seção, o digest lista todas (testes existentes de `test/notify.test.ts` seguem
      passando sem alteração de expectativa).
- [ ] `listTasksDueBefore` tem `LIMIT` (default 200) e os callers existentes compilam
      sem mudança.
- [ ] `list_tasks` retorna `stale: true` para task open/in_progress com
      `updated_at` > 60 dias atrás, `false` caso contrário; `DESCRIPTION` orienta o uso.
- [ ] `runTaskAutocancel` sem `TASK_AUTOCANCEL_AFTER_DAYS` não executa nenhum UPDATE;
      com a var setada, cancela só tasks vencidas E sem update há N dias, com nota
      automática no body mencionando reversibilidade.
- [ ] Zero migration nova em `migrations/`.
- [ ] Nenhum secret do Telegram setado; nenhum trigger novo de notificação ligado.

## Validação

```sh
npm run typecheck            # (ou npx tsc --noEmit, conforme package.json)
npx vitest run               # suíte completa; foco em test/notify.test.ts (estender) e
                             # test/tools (list_tasks stale)
```

Teste manual (sem deploy): num teste vitest, gerar 200 tasks sintéticas e assertar
`buildDueDigest(...)!.length <= 4000`. Para `runTaskAutocancel`, teste com D1 de teste
(padrão dos testes em `test/db`) cobrindo var ausente (no-op) e var setada.

**Deploy (`wrangler deploy`) SOMENTE com OK explícito do dono do repo.**

## Arquivos afetados

- `src/notify.ts` — `DigestOptions`, cap por seção, agregação de antigas, truncagem
  defensiva; (opcional) `runTaskAutocancel` se não for pra módulo próprio
- `src/task-lifecycle.ts` (novo, opcional) — `runTaskAutocancel`
- `src/index.ts` — `scheduled()` chama `runTaskAutocancel`
- `src/db/queries.ts` — `LIMIT` em `listTasksDueBefore`; UPDATE em lote do auto-cancel
- `src/mcp/tools/list-tasks.ts` — campo `stale` + ajuste da `DESCRIPTION`
- `src/env.ts` — `TASK_AUTOCANCEL_AFTER_DAYS?`
- `test/notify.test.ts` — estender (já existe; a atribuição original dizia "novo", mas
  o arquivo existe com 3 testes de `buildDueDigest`)
- `test/tools/*` — teste do `stale` no `list_tasks`

## Riscos e reversão

- **Risco: truncagem esconde task crítica.** Mitigado pela ordenação `due_at + priority`
  (as mais urgentes entram primeiro) e pelos contadores totais + link `/app/tasks` no
  rodapé. Reversão: subir `maxPerSection`/`maxChars` via `DigestOptions` — 1 linha.
- **Risco: auto-cancel fecha task ainda relevante.** Mitigado: desligado por default
  (env var), dupla condição (vencida E sem update), nota automática no body. Reversão
  por task: `update_task { status: 'open' }` (o `completed_at` é limpo por
  `updateTask`, `src/db/queries.ts:355-360`). Reversão global: remover a env var.
- **Risco: `LIMIT` novo mudar resultado de `list_tasks_due_today`.** Default 200 é muito
  acima do volume real; se necessário, subir o default — mudança de 1 constante.
- **Rollback total:** revert do commit (mudanças são só de código, sem migration, sem
  dado alterado) + `wrangler deploy` da versão anterior.
