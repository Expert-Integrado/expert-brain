# Observabilidade mínima nos 2 Workers: logs persistidos + alerta de erro + health-check externo

> **Status:** done · **Prioridade:** P1 · **Esforço:** S · **Repo:** ambos
> Nota 07/07/2026: lado repo 100% entregue e deployado; os 2 critérios restantes (Notifications na conta Cloudflare e monitor externo) são ações do dono fora dos repos — runbook em docs/observability.md.
> **Depende de:** nenhuma

## Contexto

Dois Workers Cloudflare em produção, cada um em seu repositório:

- **expert-brain** (este repo). `wrangler.toml` e `wrangler.example.toml` na raiz; entrypoint `src/index.ts` com handler `fetch` (MCP + OAuth) e handler `scheduled` (`src/index.ts:46-53`) que roda o cron diário de lembrete de tasks (`[triggers] crons = ["0 11 * * *"]`). O helper `sendTelegram` (`src/notify.ts:36-47`) já existe e é no-op seguro quando os secrets `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` não estão setados. Endpoint público de status: `GET /status` (roteado em `src/auth/handler.ts:18`, implementado em `handleStatus`, `src/auth/setup.ts:66-76`) — responde 200 com `{ configured: false }` antes do setup, ou `{ configured: true, notes, edges, lastWrite, clients, tokens, connected }` depois (via `getVaultStatus`, `src/auth/setup.ts:27`). Bindings KV disponíveis (`src/env.ts:9-10`): `OAUTH_KV` e `GRAPH_CACHE`.
- **expert-contacts** (repo irmão, mesmo padrão Workers + D1 + Vectorize + KV, caminho próprio fora deste repo). Entrypoint `src/index.ts` com `fetch` e `scheduled` (`src/index.ts:671-677`) que roda o cron diário de sync do Pipedrive (`[triggers] crons = ["0 9 * * *"]`). Endpoint público de saúde: `GET /health` (roteado em `src/index.ts:688-691` ANTES do `requireAuth`, implementado em `handleHealth`, `src/index.ts:158-178`) — responde 200 com `{ ok: true, service: "expert-contacts", counts, ... }`. Binding KV: `CACHE` (`src/env.ts:15`).

Estado da observabilidade hoje:

- **expert-contacts** já tem `[observability] enabled = true` no `wrangler.toml` (linha 24) — logs de request são persistidos no Workers Logs do dashboard.
- **expert-brain NÃO tem** o bloco `[observability]` nem no `wrangler.toml` nem no `wrangler.example.toml` — logs só existem no `wrangler tail` ao vivo; depois, nada.
- **Nenhum dos dois** tem alerta configurado (Cloudflare Notifications) nem monitor externo batendo os endpoints de saúde.
- Falha de cron em ambos vira apenas `console.error` (`src/index.ts:50` no brain; `src/index.ts:675` no contacts) — invisível se ninguém estiver olhando o tail naquele segundo.

A spec `10-backend/22-contacts-cron-pipedrive-robusto.md` define, no contacts, o contador `maint:consecutive_failures` + chave `maint:alert` no KV e a exposição do bloco `maint` no `GET /health` — e delega explicitamente o **transporte** do alerta pra esta spec (`10-backend/22`, seção "Contador de falhas consecutivas + aviso").

## Problema / Motivação

Zero alerting hoje (findings `zero-alerting-observability` e `backlog-17` do inventário):

1. **O Error 1102 do grafo só foi descoberto porque o dono abriu a página.** Sem Notifications de error-rate/CPU-limit, um Worker pode ficar horas ou dias devolvendo erro sem ninguém saber — a spec `10-backend/21` documenta o incidente 1102 e mostra que o gatilho de descoberta foi manual.
2. **Falha de cron é `console.log` perdido.** No brain, `runDueReminder` falhando cai num `console.error('due-reminder failed', e)` (`src/index.ts:50`) que, sem `[observability]` habilitado, evapora — o dono simplesmente para de receber o digest e não há sinal de que parou. No contacts, idem (`src/index.ts:675`) até a spec `10-backend/22` ser executada.
3. **O brain nem tem `[observability]` habilitado** — `wrangler.toml` e `wrangler.example.toml` não têm o bloco; qualquer diagnóstico pós-incidente começa sem nenhum log histórico. Como o `wrangler.example.toml` é o template que os alunos copiam, toda instância nova herda o mesmo ponto cego.
4. **Nenhum health-check externo.** Os dois Workers já expõem endpoint barato e público (`/health` no contacts, `/status` no brain), mas nada consulta esses endpoints de fora — se o Worker inteiro cair (deploy quebrado, conta suspensa, DNS), nenhum sinal.

Esta é a **Fase 0** do roadmap: liga a observabilidade primeiro, pra que a execução de todo o resto das specs seja observável. Por isso não depende de nada e nada precisa esperar por ela.

## Objetivo

Qualquer erro sustentado nos 2 Workers (error-rate HTTP, estouro de CPU, falha de cron ou Worker fora do ar) gera alerta ativo no canal pessoal do dono em até 15 minutos, e os logs dos 2 Workers ficam persistidos no dashboard pra diagnóstico posterior.

## Design proposto

Quatro entregas independentes; podem ser feitas em qualquer ordem.

### 1. Brain: habilitar `[observability]` no `wrangler.toml` E no `wrangler.example.toml`

Adicionar o bloco abaixo nos dois arquivos (o `.example` é o template dos alunos — instâncias novas herdam):

```toml
# Workers Logs: persiste logs de request/cron no dashboard (Workers & Pages >
# expert-brain > Logs). Sem isso, console.log/error só existe no `wrangler tail`
# ao vivo. head_sampling_rate = 1 grava 100% das invocações (volume do vault
# pessoal é baixo; o free tier de Workers Logs comporta com folga).
[observability]
enabled = true
head_sampling_rate = 1
```

Posição sugerida: logo após o bloco `[triggers]`, mantendo o resto do arquivo intacto. No contacts nada a fazer aqui (`[observability] enabled = true` já existe no `wrangler.toml:24`); apenas conferir e, se quiser paridade, adicionar `head_sampling_rate = 1` explícito.

### 2. Cloudflare Notifications: runbook `docs/observability.md` nos 2 repos

Notifications **não são configuráveis via `wrangler.toml`** — vivem na conta Cloudflare (dashboard ou API `POST /accounts/{account_id}/alerting/v3/policies`). Então o entregável no repo é um **runbook** (`docs/observability.md` em cada repo) com o passo a passo, e a execução acontece via dashboard/API **com OK do dono** (side-effect na conta dele).

O runbook deve conter, no mínimo:

- **Onde:** dashboard Cloudflare → Notifications → Add → categoria Workers. Consultar a doc oficial (https://developers.cloudflare.com/notifications/) pros nomes exatos dos tipos de alerta vigentes — a UI muda; NÃO hardcodar nomes de tipo sem verificar.
- **O que criar (por Worker, `expert-brain` e `expert-contacts`):** alerta de error-rate/exceções do Worker e alerta de CPU/resource limit (o tipo que cobre Error 1102), com destino (webhook ou e-mail) apontando pro canal pessoal do dono. O destino concreto (URL de webhook, e-mail) fica FORA do repo — o runbook referencia genericamente "destino configurado na conta".
- **Alternativa via API** com `curl` de exemplo usando placeholders (`$CF_API_TOKEN`, `$ACCOUNT_ID`) — nunca valores reais.
- **Como testar:** forçar um erro (ex.: rota inexistente não serve; usar um deploy de teste ou `throw` temporário em preview) e confirmar o recebimento.
- **Onde ver os logs persistidos** (Workers & Pages → Worker → Logs) e como filtrar por `[maint]` (contacts) / `due-reminder` (brain).

O repo é público: o runbook não pode conter account_id, tokens, e-mails, URLs de webhook nem nomes de clientes.

### 3. Health-check externo (contrato apenas — o script vive FORA dos repos)

O monitor externo é configuração pessoal do dono (cron na infraestrutura que ele já tem) e **não entra em nenhum dos dois repos**. O runbook `docs/observability.md` especifica somente o **contrato**:

| Worker | Endpoint | Expectativa de saúde | Frequência sugerida |
|---|---|---|---|
| expert-contacts | `GET /health` | HTTP 200 + JSON `ok: true`; quando o bloco `maint` existir (spec `10-backend/22`), também `maint.consecutive_failures < 2` | a cada 5 min |
| expert-brain | `GET /status` | HTTP 200 + JSON com campo `configured` presente (`true` ou `false` são ambos saudáveis); quando o item 4 abaixo estiver no ar, também `cron.consecutive_failures < 2` | a cada 5 min |

Regra de alerta do monitor: notificar o canal pessoal do dono após **2 falhas consecutivas** (evita flap de rede) — falha = timeout, HTTP != 200, JSON inválido ou threshold de contador estourado. Ambos os endpoints são públicos e read-only (nenhum token necessário), o que mantém o script externo sem credencial.

### 4. Falha de cron vira contador em KV consultável pelo health-check

Hoje o `catch` dos dois `scheduled` só loga. Passa a também persistir um contador de falhas consecutivas em KV, que o endpoint de saúde expõe (fechando o loop com o item 3). Sem migration D1 — estado aditivo e descartável em KV.

**Brain** (`src/index.ts:46-53` + `src/auth/setup.ts`):

- Chaves no `GRAPH_CACHE` (binding já existente, `src/env.ts:10`): `cron:consecutive_failures` (string numérica) e `cron:last_error` (JSON `{ at: <iso>, message: <string> }`).
- No `scheduled`: `runDueReminder` resolvendo com sucesso → `GRAPH_CACHE.put('cron:consecutive_failures', '0')`. No `catch`: ler, incrementar e gravar o contador + gravar `cron:last_error`; manter o `console.error` atual. Quando o valor após incremento for `>= 2`, chamar `sendTelegram(env, ...)` (`src/notify.ts:36`) com um texto curto tipo `⚠️ expert-brain: cron falhou N vezes seguidas — <message>` — no-op seguro se Telegram não configurado, então não quebra instâncias de alunos.
- Toda a lógica nova do `scheduled` embrulhada em `try/catch` próprio: **falha do alerting nunca pode derrubar o cron**.
- Em `handleStatus` (`src/auth/setup.ts:66-76`): adicionar ao JSON de resposta (apenas no ramo `configured: true`) o bloco `cron: { consecutive_failures: number, last_error: string | null }` — 2 leituras de KV, custo desprezível. Aditivo: nenhum campo existente muda.

**Contacts** (`src/index.ts:671-677` + `handleHealth` em `src/index.ts:158-178`):

- Reutilizar EXATAMENTE as chaves definidas na spec `10-backend/22`: `maint:consecutive_failures` e `maint:alert` no `env.CACHE` — pra que as duas specs convirjam no mesmo estado, seja qual for executada primeiro.
- Se a spec `10-backend/22` ainda não tiver sido executada quando esta rodar: adicionar a versão mínima — no `catch` do `scheduled`, incrementar `maint:consecutive_failures` e gravar `maint:alert` com `{ kind: "maint_sync_failing", consecutive: n, message }`; no `.then` de sucesso, zerar o contador; e expor em `handleHealth` o bloco `maint: { last_run, consecutive_failures, cursor_pending: boolean }` (leituras de `maint:last_run`, `maint:consecutive_failures`, `maint:cursor`). A spec `10-backend/22` depois refina a semântica (sucesso parcial não zera etc.) sem mudar chave nem shape.
- Se a `10-backend/22` já estiver `done`: nada a fazer neste item além de conferir que o `/health` expõe o bloco `maint`.

## Fora de escopo

- APM/tracing completo (spans, OpenTelemetry, Sentry ou similar).
- Dashboards (Grafana, painéis custom) — o dashboard nativo de Workers Logs basta nesta fase.
- O script do health-check externo em si (cron, transporte da notificação) — é configuração pessoal do dono, fora dos repos; aqui só o contrato.
- Refazer a robustez do cron do contacts (checkpoint, teto de trabalho, token no header) — isso é a spec `10-backend/22`.
- Alerting por Logpush/Tail Workers — custo/complexidade desnecessários pro volume atual.

## Critérios de aceite

- [x] `wrangler.toml` do brain tem `[observability]` com `enabled = true` e `head_sampling_rate = 1`.
- [x] `wrangler.example.toml` do brain tem o mesmo bloco, com comentário explicando o porquê (alunos herdam).
- [x] `docs/observability.md` existe nos 2 repos com: passo a passo de Notifications (dashboard + API com placeholders), contrato do health-check externo (tabela endpoint/expectativa/frequência) e onde ver os logs persistidos — sem nenhum account_id, token, e-mail, webhook ou nome de cliente.
- [x] Brain: falha em `runDueReminder` incrementa `cron:consecutive_failures` e grava `cron:last_error` no `GRAPH_CACHE`; sucesso zera o contador.
- [x] Brain: 2+ falhas consecutivas disparam `sendTelegram` (verificado com mock de fetch); sem secrets de Telegram, é no-op sem erro.
- [x] Brain: `GET /status` (instância configurada) responde com bloco `cron: { consecutive_failures, last_error }` além dos campos atuais — nenhum campo existente removido/renomeado.
- [x] Contacts: falha no `scheduled` incrementa `maint:consecutive_failures` e grava `maint:alert`; sucesso zera; `GET /health` expõe o bloco `maint` (chaves idênticas às da spec `10-backend/22`).
- [x] Falha em qualquer chamada de KV/Telegram dentro do caminho de alerting não propaga exceção pro `scheduled` (try/catch próprio, verificado por teste).
- [ ] Notifications criadas na conta Cloudflare pros 2 Workers (error-rate + CPU limit) — executado via dashboard/API **com OK explícito do dono**, seguindo o runbook.
- [ ] Monitor externo do dono batendo `GET /health` e `GET /status` conforme o contrato (confirmação do dono; o script não é auditável pelos repos).

## Validação

No repo **expert-brain**:

```sh
npm run typecheck        # tsc --noEmit (raiz + src/web/client)
npm test                 # vitest run && vitest run --config vitest.auth.config.ts
```

Testes novos (vitest, mockando `GRAPH_CACHE` e `fetch`): sucesso zera contador; falha incrementa; 2ª falha consecutiva chama Telegram; erro no KV não propaga; `handleStatus` inclui o bloco `cron`.

No repo **expert-contacts**: rodar o equivalente (`npm run typecheck` / `npm test` se a infraestrutura da spec `40-ops/42` já existir; senão, ao menos `npx tsc --noEmit` e teste manual abaixo).

Teste manual pós-deploy (deploy SOMENTE com OK explícito do dono, conforme `specs/README.md`):

```sh
# health-checks públicos respondem 200 com o shape esperado
curl -s https://<worker-brain>/status | head -c 400
curl -s https://<worker-contacts>/health | head -c 400

# logs persistidos: dashboard > Workers & Pages > <worker> > Logs deve listar invocações
# cron: disparar manualmente (wrangler) e conferir o log persistido + contador zerado
npx wrangler tail expert-brain   # em paralelo ao trigger do cron de teste
```

## Arquivos afetados

- (brain) `wrangler.toml` — bloco `[observability]` novo
- (brain) `wrangler.example.toml` — bloco `[observability]` novo
- (brain) `docs/observability.md` — novo (runbook)
- (brain) `src/index.ts` — `scheduled` passa a manter contador em KV + alerta Telegram
- (brain) `src/auth/setup.ts` — `handleStatus`/`getVaultStatus` expõem bloco `cron`
- (brain) `test/` — testes novos do contador/alerta
- (contacts) `src/index.ts` — `scheduled` mantém `maint:consecutive_failures`/`maint:alert`; `handleHealth` expõe bloco `maint`
- (contacts) `docs/observability.md` — novo (runbook)

## Riscos e reversão

- **Custo/volume de Workers Logs:** `head_sampling_rate = 1` grava tudo; se o volume surpreender (não deve, tráfego é pessoal), reduzir o sampling no `wrangler.toml` e redeployar. Rollback total: remover o bloco `[observability]` e redeployar — zero efeito em dados.
- **Alerting derrubando o cron:** mitigado por try/catch próprio em volta de todo o caminho novo (critério de aceite). Rollback: reverter o commit em `src/index.ts` — o estado em KV é descartável (`GRAPH_CACHE`/`CACHE` podem ter as chaves `cron:*`/`maint:*` deletadas sem impacto; nenhum consumidor obrigatório).
- **Ruído de Notification (falso positivo em pico transitório):** ajustar threshold/janela na própria policy do dashboard; deletar a policy desfaz tudo (nada no código depende dela).
- **Divergência com a spec `10-backend/22`:** evitada por contrato — chaves e shape do bloco `maint` são idênticos nas duas specs; a que rodar depois só refina.
- **Campos novos em `/status` e `/health`:** aditivos; nenhum cliente atual quebra. Rollback é reverter o commit — nenhuma migration envolvida.
