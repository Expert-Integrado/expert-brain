# Heartbeat e wake-up: como cada instância descobre que tem mensagem

> **Status:** parte 1 shipped (11/07/2026, deploy cecc3b10 — /api/mailbox/summary provado em produção); parte 2 = config por dispositivo · **Prioridade:** P1 · **Esforço:** S (Worker) + config por dispositivo · **Repo:** expert-brain (parte 1) + infra dos dispositivos (parte 2)
> **Depende de:** `82` (mailbox). Substitui a abordagem da task `2p6hrm3fhw1l` (heartbeat 30/30min genérico lendo o Kanban inteiro). Plano-mãe: grupo 80.

## Problema

1. O mailbox (spec 82) só funciona se cada instância CHECAR — e hoje nenhuma checa sozinha. Decisão do dono: wake-up é PULL (heartbeat/hook), sem push por chat (nota `6cjkgcc1mwje`).
2. Um heartbeat que abre sessão MCP completa só pra descobrir "zero mensagens" é caro. Precisa de um endpoint HTTP mínimo pra pergunta binária "tem algo pra mim?".
3. Cada dispositivo tem capacidade diferente: containers da VPS rodam 24/7 com cron real; PC/notebook só têm sessão quando o dono abre uma (scheduled task do Windows é vetada na máquina do dono).

## Design

### Parte 1 — Worker: endpoint de summary (`src/web/handler.ts` ou rota própria)

- `GET /api/mailbox/summary`, auth Bearer PAT (mesmo `bearer-auth.ts` das rotas autenticadas):
  - Resolve o usuário pela credencial (`getUserByApiKeyId`); sem vínculo → 403 com corpo instrutivo.
  - Resposta: `{ user: {id, name}, unread: N, oldest_brt, top: [{kind, task_title, task_url, created_brt} x até 5] }`.
  - 1 query no índice `idx_mailbox_unread`; sem side-effect (não marca lido). Cache-Control: no-store.
- Telemetria: nada novo — é GET barato; se virar fonte de custo o /status já expõe métricas de cron por job (spec 76) como modelo a seguir.

### Parte 2 — Dispositivos (config, fora deste repo; documentar em `docs/`)

| Instância | Mecanismo | Latência esperada |
|---|---|---|
| VPS claude-code / backup | cron do container 30/30min: `curl summary` → `unread == 0` sai em ms; `> 0` aciona a instância com prompt "rode check_mailbox e aja" | ≤ 30 min |
| OpenClaw | idem (cron no container dele) | ≤ 30 min |
| PC desktop / notebook | hook SessionStart: `curl summary` e injetar "você tem N itens no mailbox (top: ...)" no contexto de abertura — mesmo padrão do hook que já injeta as tasks do dia; heartbeat in-session opcional enquanto a sessão vive | próxima sessão |
| Subagentes internos | não têm mailbox próprio: recebem/devolvem pela instância-mãe | n/a |

- O PAT usado pelo cron/hook é o MESMO do dispositivo (spec 81) — lido do armazenamento local de credenciais de cada máquina, nunca hardcoded em script commitado.
- Cadência 30 min é o default combinado; ajustável por dispositivo sem tocar no Worker.

## Critérios de aceite

- [ ] `GET /api/mailbox/summary` com PAT vinculado devolve unread + top 5 em 1 query; PAT sem vínculo → 403 instrutivo; sem PAT → 401.
- [ ] Chamada NÃO altera read_at.
- [ ] Cron de um container da VPS instalado e provado: menção criada no board → instância age nela em ≤ 30 min sem toque do dono (ciclo real, ponta a ponta).
- [ ] Hook SessionStart do PC injetando o resumo na abertura de sessão nova.
- [ ] Task `2p6hrm3fhw1l` fechada como absorvida por esta spec.
- [ ] Suite verde (handler: auth, sem vínculo, payload, no-store).
