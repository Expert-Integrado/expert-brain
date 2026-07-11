# Heartbeat da frota — como cada instância descobre que tem mensagem

> Spec: `specs/80-frota-agentes/83-heartbeat-wakeup.md`. Wake-up é **PULL** (heartbeat/hook), sem push por chat.

## Endpoint

```
GET /api/mailbox/summary
Authorization: Bearer <PAT do dispositivo (eb_pat_...)>
```

Resposta (`200`, `Cache-Control: no-store`, sem side-effect — não marca lido):

```json
{
  "user": { "id": "user_...", "name": "Nome do agente" },
  "unread": 3,
  "oldest_brt": "10/07/2026 14:32",
  "top": [
    { "kind": "mention", "task_title": "...", "task_url": "https://<worker>/app/notes/<id>", "created_brt": "..." }
  ]
}
```

- `401` sem Bearer PAT ou chave inválida/revogada.
- `403` quando o PAT não tem usuário vinculado (o dono vincula em `/app/config`, seção Usuários).
- Task privada só aparece pra chave com escopo `private` (fail-closed).

## Config por dispositivo

O PAT vem SEMPRE do armazenamento local de credenciais do dispositivo — nunca hardcoded em script commitado.

### Containers 24/7 (cron a cada 30 min)

```sh
#!/bin/sh
# heartbeat-mailbox.sh — cron */30. Sai em ms quando unread == 0.
SUMMARY=$(curl -sf -H "Authorization: Bearer $BRAIN_PAT" "$BRAIN_URL/api/mailbox/summary") || exit 0
UNREAD=$(printf '%s' "$SUMMARY" | node -e "process.stdin.on('data',d=>console.log((JSON.parse(d).unread)||0))")
[ "$UNREAD" -gt 0 ] || exit 0
# Acorda a instância com um prompt mínimo — ela mesma roda check_mailbox e age.
# (mecanismo de acionamento varia por container: fila, exec na sessão viva, etc.)
echo "mailbox: $UNREAD item(ns) não lido(s) — rode check_mailbox, aja e depois ack_mailbox"
```

### Sessões sob demanda (hook SessionStart)

No `settings.json` do Claude Code do dispositivo, um hook `SessionStart` faz o mesmo `curl` e injeta no contexto de abertura:

```
você tem N itens no mailbox (top: <kind> em "<task_title>", ...) — rode check_mailbox e aja; ack_mailbox só depois de agir
```

Mesmo padrão do hook que injeta as tasks do dia. `unread == 0` → não injeta nada.

### Regras de uso

- Ler (`check_mailbox` / summary) NUNCA marca lido; `ack_mailbox` só DEPOIS de agir no item.
- Cadência default: 30 min (ajustável por dispositivo, sem tocar no Worker).
- Subagentes internos não têm mailbox próprio — recebem/devolvem pela instância-mãe.
