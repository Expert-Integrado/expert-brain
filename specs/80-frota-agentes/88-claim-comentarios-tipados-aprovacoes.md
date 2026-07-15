# 88 — Claim/lease de task, comentários tipados e fila "aguardando o dono"

> Status: implementado (migration 0027). Origem: benchmark de boas práticas de
> orquestração multi-agente (11/07/2026) — os 3 itens de maior alavanca aprovados
> pelo dono sob carta branca. Os itens estruturais maiores (webhook wake, subtasks,
> verifier, WIP caps, telemetria de custo) viraram tasks no próprio board.

## Problema

Com o modo fila (spec 83 + decisão de 11/07), TODO beat de 30min de TODOS os
dispositivos trabalha a própria fila. Três lacunas apareceram:

1. **Corrida entre instâncias** — duas máquinas podem pegar a MESMA task no mesmo
   ciclo (PC e VPS batem no :00/:30). Não havia noção de posse temporária.
2. **Comentário é texto plano** — a frota já usa a convenção `[pedido]`, `[entrega]`,
   `[bloqueio]`, `[info]` no corpo, mas o servidor não entende. Impossível filtrar
   "o que está bloqueado esperando o Eric" sem ler thread por thread.
3. **Bloqueio não notifica** — um `[bloqueio] @Eric` fica parado no thread até o
   dono abrir o board. O maior desperdício da frota é agente parado esperando
   decisão que o dono nem sabe que existe.

## Desenho

### 1. Claim/lease (posse temporária de task)

Três colunas novas em `notes` (tasks são notas, kind='task'):

- `claimed_by TEXT` — user_id do perfil (users, spec 80) que detém a posse.
- `claimed_at INTEGER` — quando pegou.
- `claim_expires_at INTEGER` — fim do lease. **Expirado = livre**: nenhum cron de
  limpeza; a expiração é avaliada na leitura/escrita (lazy). Crash de agente nunca
  deixa task presa além do lease.

Tool nova `claim_task { task_id, minutes?, release? }`:

- Claim é **atômico** (UPDATE condicional, `meta.changes` decide) — duas instâncias
  no mesmo milissegundo: uma ganha, a outra recebe erro orientado com o detentor e
  o vencimento, e a instrução de pegar OUTRA task.
- Claim por quem já detém = **renova** o lease (mesmo UPDATE).
- `release: true` solta (só o detentor; soltar task não-claimada é no-op ok).
- Lease default 60min (máx 480). Task done/canceled não é claimável.
- Identidade = credencial (resolveMe, fail-closed — mesmo modelo da spec 81).
- `complete_task` limpa o claim ao concluir (done não fica "possuído").
- `update_task` NÃO foi tocado nesta spec (WIP de outra sessão em 11/07); mudança
  de status para done/canceled por lá deixa o claim para expirar sozinho — inócuo.

Exposição de leitura: `get_task` devolve `claim { user {id,name,type}, claimed_at,
expires_at, expires_brt, active }` (null = livre); `list_tasks` devolve por item
`claim { by, expires_at, active }` e ganha o filtro `available: true` — só tasks
livres (não claimadas, lease vencido, ou claimadas por MIM). O beat da frota vira:
`list_tasks {assignee:'me', available:true}` → `claim_task` → trabalhar → comentar
→ `release`/`complete`.

### 2. Comentários tipados

Coluna nova `task_comments.kind TEXT` (`pedido | entrega | bloqueio | info`,
NULL = comentário comum). O `comment_task` aceita `kind` explícito E TAMBÉM deriva
do prefixo `[kind]` no corpo (case-insensitive) — a convenção que a frota já usa
passa a ser entendida sem mudar nenhum prompt. Parâmetro explícito vence o prefixo.
O corpo é gravado como veio (prefixo incluso — legibilidade humana preservada).
`get_task` devolve `kind` em cada comentário do thread.

### 3. Fila "aguardando o dono" + push

Definição (SQL, sem estado novo): task open/in_progress cujo último comentário
`kind='bloqueio'` é MAIS RECENTE que o último comentário do OWNER na mesma task.
O dono responder no thread (qualquer comentário) tira a task da fila — zero
cerimônia de "desbloquear".

- `list_tasks` ganha `awaiting_owner: true` (a sessão do dono pergunta "o que
  espera decisão minha").
- `pendingSummary` (web push, spec 68) ganha a contagem `blocked` — o texto da
  notificação inclui "N aguardando decisão sua" e a contagem participa do gate do
  digest (bloqueio pendente sozinho já dispara o push diário).
- **Push imediato**: `comment_task` com `kind='bloqueio'` dispara `sendPushToAll`
  best-effort (mesmo modelo do mailbox: o comentário já está commitado; falha de
  push só loga). O celular do Eric apita minutos depois do agente travar, não no
  dia seguinte.

## Migration 0027 (aditiva)

```sql
ALTER TABLE notes ADD COLUMN claimed_by TEXT;
ALTER TABLE notes ADD COLUMN claimed_at INTEGER;
ALTER TABLE notes ADD COLUMN claim_expires_at INTEGER;
ALTER TABLE task_comments ADD COLUMN kind TEXT;
CREATE INDEX IF NOT EXISTS idx_task_comments_kind ON task_comments(task_id, kind, created_at);
```

Deploy: migrations rodam no /setup (idempotente) — deploy do Worker + POST de
setup na sequência. Código lê TASK_COLS com as colunas novas, então a ordem é
deploy → migrate imediato (mesmo runbook das 0019-0026).

## Fora de escopo (tasks no board)

- Webhook wake (push pro dispositivo em vez de polling 30min) — corta latência
  70-90%; exige endpoint por dispositivo.
- Subtasks/dependências (blocked_by) — hoje o board é chato de decompor.
- Definition-of-done + verifier (agente B confere entrega do agente A).
- ~~WIP cap por agente + aging automático de task parada~~ — implementado, ver
  spec 94-wip-cap-aging.md.
- Telemetria de custo por task (tokens/US$ por entrega).
