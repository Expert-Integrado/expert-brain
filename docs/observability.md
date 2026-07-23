# Observabilidade — logs, alertas e health-check (spec 40-ops/43)

Três camadas, da mais barata pra mais ativa:

## 1. Logs persistidos (Workers Logs)

Habilitado no `wrangler.toml` (`[observability] enabled = true`, `head_sampling_rate = 1`).

- **Onde ver:** dashboard Cloudflare → Workers & Pages → `expert-brain` → **Logs**.
- **Filtros úteis:** `due-reminder` (resultado do cron diário do digest), `backup` (snapshot semanal D1→R2), `cron alerting failed` (falha do próprio caminho de alerta — nunca derruba o cron).
- Sem esse bloco, `console.log/error` só existe no `wrangler tail` ao vivo; depois, nada.

## 2. Alertas ativos (Cloudflare Notifications)

Notifications **não são configuráveis via `wrangler.toml`** — vivem na conta Cloudflare. Criar via dashboard (ou API), **com OK do dono da conta**:

1. Dashboard → **Notifications** → **Add** → categoria **Workers**. Os nomes exatos dos tipos mudam com o tempo — confira na doc oficial: https://developers.cloudflare.com/notifications/
2. Criar, para o worker `expert-brain` (um só desde a fusão — inclui o módulo de contatos):
   - alerta de **error-rate / exceções** do Worker;
   - alerta de **CPU / resource limit** (é o tipo que cobre o Error 1102).
3. Destino: o canal configurado na conta (e-mail ou webhook). O destino concreto fica fora deste repo.

Alternativa via API (placeholders — nunca valores reais):

```sh
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/alerting/v3/policies" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"expert-brain errors","enabled":true,"alert_type":"<ver doc oficial>","mechanisms":{"email":[{"id":"<destino>"}]},"filters":{}}'
```

**Como testar:** subir um deploy de preview com um `throw` temporário num handler, gerar tráfego e confirmar o recebimento do alerta. Não testar em produção.

## 3. Health-check externo (contrato)

O monitor roda FORA deste repo (infra pessoal do dono). Contrato:

| Worker | Endpoint | Saudável quando | Frequência |
|---|---|---|---|
| expert-brain | `GET /status` | HTTP 200 + JSON com campo `configured` presente (`true`/`false` são ambos saudáveis) e `cron.consecutive_failures < 2` | a cada 5 min |
| expert-brain (contatos) | `GET /contacts/health` | HTTP 200 + JSON `ok: true` e `maint.consecutive_failures < 2` | a cada 5 min |

Regra de alerta do monitor: notificar após **2 falhas consecutivas** (evita flap de rede). Falha = timeout, HTTP != 200, JSON inválido ou threshold estourado. Os dois endpoints são públicos e read-only — o script externo não precisa de credencial. (Os dois vivem no MESMO Worker desde a fusão do vault de contatos — `/contacts/health` é o antigo `/health` do worker expert-contacts, agora sob o prefixo `/contacts`.)

## Contador de falhas do cron (como funciona)

`src/scheduled.ts` (`trackCronOutcome`): sucesso do digest diário zera `cron:consecutive_failures` no KV `GRAPH_CACHE`; falha incrementa e grava `cron:last_error` (`{ at, message }`). Na 2ª falha consecutiva, envia alerta via Telegram (`sendTelegram` — no-op seguro sem os secrets `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, então instâncias sem Telegram não quebram). `GET /status` expõe `cron: { consecutive_failures, last_error }` quando a instância está configurada. Falha do próprio alerting é engolida com log — nunca derruba o cron.
