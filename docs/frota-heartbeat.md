# Heartbeat da frota — como cada instância descobre que tem mensagem

> Spec: `specs/80-frota-agentes/83-heartbeat-wakeup.md`. Wake-up é **PULL** (heartbeat/hook), sem push por chat.
> Fast-path de latência (long-poll `/api/mailbox/wait`): `specs/80-frota-agentes/90-wake-fastpath-longpoll.md` — seção "Wake fast-path" abaixo.

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

## Wake fast-path (spec 90) — latência de segundos

```
GET /api/mailbox/wait?timeout=25
Authorization: Bearer <PAT do dispositivo (eb_pat_...)>
```

O Worker segura a resposta até `timeout` segundos (clamp 0–25; `timeout=0` = check
único) e responde NA HORA que nasce item não-lido:

```json
{ "user": { "id": "user_...", "name": "..." }, "wake": true, "unread": 2, "waited_ms": 3120 }
```

Mesma identidade/erros/visibilidade do summary (401/403, task privada fail-closed),
sem side-effect. O dispositivo roda um loop residente: `wait` → `wake:true` → dispara
o MESMO acionamento do heartbeat → repete. O polling `*/30` fica como reconciliador
(cobre queda do loop, restart, drift) — não remover.

Regras do consumidor (aprendidas no daemon do PC, que é a referência):

- Cliente com timeout MAIOR que o do servidor (35s pra 25s), senão derruba a conexão
  que o Worker ainda vai responder.
- Erro/404/401 → backoff exponencial até 15min, logando só a transição.
- Guarda anti-loop: item preso sem ack não pode re-spawnar o ciclo pra sempre —
  escalar o gap entre spawns (2min → 10min → 30min) e resetar quando `unread == 0`.

### Instalação VPS (host, systemd — PÓS-deploy do Worker)

O cron `*/30` existente fica. Somar um daemon residente por container, no HOST
(mesmo lugar dos `brain-mailbox-heartbeat*.sh`, reusando-os como acionador):

```sh
#!/bin/sh
# /usr/local/bin/brain-wake-daemon.sh <injector> — long-poll do wake (spec 90).
# <injector> = /usr/local/bin/brain-mailbox-heartbeat.sh (main) ou -backup.sh.
# O injector ja le o PAT do proprio container e so injeta se unread > 0 —
# entao aqui basta acordar ele quando o wait sinalizar.
INJECTOR="$1"; BRAIN_URL="https://expert-brain.contato-d9a.workers.dev"
PAT_CMD="$2"   # comando que imprime o PAT (mesmo mecanismo do injector; nunca literal)
ERR=0
while :; do
  PAT=$($PAT_CMD) || { sleep 900; continue; }
  BODY=$(curl -sf --max-time 35 -H "Authorization: Bearer $PAT" "$BRAIN_URL/api/mailbox/wait?timeout=25")
  if [ $? -ne 0 ]; then
    ERR=$((ERR+1)); S=$((60 << (ERR-1))); [ $S -gt 900 ] && S=900
    [ $ERR -eq 1 ] && logger -t brain-wake "erro no wait — backoff ate ${S}s"
    sleep $S; continue
  fi
  [ $ERR -gt 0 ] && logger -t brain-wake "wait voltou"; ERR=0
  echo "$BODY" | grep -q '"wake":true' && { logger -t brain-wake "wake — injetando"; "$INJECTOR"; sleep 120; }
done
```

Unit (`/etc/systemd/system/brain-wake@.service`, instância `main`/`backup`):

```ini
[Unit]
Description=Brain wake fast-path (%i)
After=network-online.target docker.service

[Service]
ExecStart=/usr/local/bin/brain-wake-daemon.sh /usr/local/bin/brain-mailbox-heartbeat%i.sh <pat-cmd-%i>
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

(`%i` = `""` pro main / `-backup` pro backup; `<pat-cmd>` = o mesmo comando de leitura
de PAT que o injector usa, ver os scripts no host.) `systemctl enable --now
brain-wake@main brain-wake@backup`. OpenClaw fica fora (sem loop residente nosso).
