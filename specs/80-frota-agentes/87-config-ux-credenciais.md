# UX do /app/config: fluxo único de credencial, banner one-time, whoami e agrupamento

> **Status:** draft (achados colhidos ao vivo na Fase 0, 11/07/2026) · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `86` (dono mora na chave — o form novo é a cara dessa regra). Plano-mãe: grupo 80.

## Problema

O bug do PC assinando como Claude VPS nasceu DESTA tela (relato: comentário `cmt_lnwlcxdpix5d` da task `ns5e5l1023ui`):

1. Criar chave (#api-keys) e vincular dono (Organização → Usuários) são seções separadas — chave nasce órfã e o vínculo é um segundo passo esquecível/errável.
2. O token aparece UMA vez, sem cerimônia — fácil perder (e re-emitir) ou copiar pra lugar errado.
3. Não existe como saber qual chave uma sessão usa nem quando cada chave foi usada pela última vez — o vínculo errado do PC ficou invisível por semanas até esbarrar num `assignees: ["me"]`.
4. A listagem mistura frota, chaves de outros sistemas (hermes-VPS, G4 OS) e efêmeras (backfill auto-revoga) num dropdown só.

## Design

### 1. Migration 0024 (`src/db/migrate.ts`)

`0024_api_key_meta`: `ALTER TABLE api_keys ADD COLUMN system TEXT` (grupo/rótulo: frota, hermes, g4os...) + `ALTER TABLE api_keys ADD COLUMN last_used_at INTEGER`.

### 2. Form único de criação (`src/web/api-keys.ts`)

Num passo só: nome · dono (dropdown de users ativos, OBRIGATÓRIO pra chave nova) · escopo (full/read) · toggle `private` com aviso ("capacidade sensível — prefira uma chave separada só pra isso", link pra política da spec 86 §4) · sistema (texto curto com sugestões das existentes). Chave sem dono não nasce mais pela UI (legadas seguem funcionando).

### 3. Banner one-time do token

Bloco destacado inconfundível; botão copiar com feedback "copiado"; o ÚNICO jeito de fechar é o botão "já salvei no 1Password"; fechar sem ter copiado pede confirmação explícita. Token nunca é re-exibível (comportamento atual preservado — a UI só deixa isso óbvio).

### 4. Rastro de uso e "este é você"

- `last_used_at` atualizado no caminho de auth com throttle em KV (máx 1 escrita/h por chave — sem amplificação de escrita em D1).
- Listagem: dono + escopos + sistema + "último uso há Xh"; chave sem uso há 30+ dias ganha selo "dormindo" (candidata a revogação).
- **`GET /api/whoami`** (Bearer PAT, 1 query): `{ key_name, user: {id, name, type}, scopes }`. Qualquer máquina confere a própria identidade num curl — teria denunciado o bug do PC na hora. Vira o passo (d) do checklist de propagação da Fase 0 e teste padrão pós-troca de chave.

### 5. Listagem agrupada

Agrupar por `system` (frota primeiro), efêmeras colapsadas por default. Sem mudança de comportamento — só ordenação/rotulagem.

## Critérios de aceite

- [ ] Criar chave sem dono é impossível pela UI; o dono aparece na listagem.
- [ ] Banner one-time: só fecha no "já salvei"; fechar sem copiar exige confirmação; token não re-exibível.
- [ ] `GET /api/whoami` devolve identidade correta pras chaves já vinculadas (pat-vps-backup → VPS Backup, pat-pc-notebook → PC Notebook); chave sem dono → 200 com `user: null` (diagnóstico, não erro).
- [ ] `last_used_at` atualiza com throttle (2 requests na mesma hora = 1 escrita) e renderiza na lista; selo "dormindo" em 30+ dias.
- [ ] Listagem agrupada por sistema; efêmeras colapsadas.
- [ ] e2e Playwright do fluxo de criação completo; suite verde.
