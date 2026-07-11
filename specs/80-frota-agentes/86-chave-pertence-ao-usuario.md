# Chave pertence ao usuário (1:N) e credencial privada separada

> **Status:** shipped (11/07/2026, deploy cecc3b10 — vínculo chave→usuário operante em produção via whoami/assinatura/mailbox) · **Prioridade:** P1 · **Esforço:** S-M · **Repo:** expert-brain
> **Depende de:** `81` (compartilha o `resolveMe`; coordenar com a migration 0020). Desbloqueia as pendências da Fase 0 (task `ns5e5l1023ui`, comentário `cmt_lnwlcxdpix5d`). Origem da tensão: nota `0ddnsnhzcwys`. Plano-mãe: grupo 80.

## Problema

1. **`users.api_key_id` é 1:1 e travou a Fase 0 ao vivo.** Três vínculos ficaram pendentes (PC Desktop, Claude VPS, OpenClaw) porque vincular a chave NOVA ao usuário orfanaria a chave ANTIGA que a máquina ainda usa em produção → `resolveMe` vira NULL → `comment_task` fail-closed (spec 81). Não existe transição graciosa de chave: rotação exige troca simultânea na máquina e no console.
2. **Identidade e capacidade sensível moram na mesma chave** (nota `0ddnsnhzcwys`): o escopo `private` é uma capacidade de natureza distinta da leitura/escrita normal. Com uma chave só: sessão de palco carregando a chave do dispositivo ENXERGA o privado; auditar/revogar o acesso privado = mexer na identidade do agente.
3. **Sem forense por chave nos comentários**: a spec 81 grava QUEM (usuário); com múltiplas chaves por usuário passa a importar POR QUAL chave (identidade vs privada, nova vs antiga).

## Design

### 1. Migration 0023 (`src/db/migrate.ts`)

`0023_api_key_user`:

- `ALTER TABLE api_keys ADD COLUMN user_id TEXT` — dono da chave.
- Backfill: `UPDATE api_keys SET user_id = (SELECT u.id FROM users u WHERE u.api_key_id = api_keys.id) WHERE user_id IS NULL` — preserva os vínculos existentes (VPS Backup, PC Notebook, owner).
- `ALTER TABLE task_comments ADD COLUMN author_key_id TEXT` — forense por chave. Se a 0020 (spec 81) ainda não tiver shipped, as duas podem ser implementadas juntas; se já shipped, o `comment_task` passa a gravar `auth.keyId` a partir daqui.
- `users.api_key_id` vira LEGADO: mantido e lido como fallback durante a transição; remoção fica pra migration futura de limpeza (fora deste escopo, registrar no README do grupo).

### 2. Fonte da verdade invertida (`src/db/queries.ts`)

- `getUserByApiKeyId(env, keyId)`: internals passam a resolver por `api_keys.user_id` (JOIN), com fallback legado em `users.api_key_id` quando a coluna nova é NULL. **Interface pública inalterada** — specs 81/82/83 não mudam uma linha.
- Semântica de assinatura preservada: QUALQUER chave do usuário assina como o usuário; a chave específica fica no rastro (`author_key_id`, `created_by`/`updated_by` já existentes da spec 10-backend/17).

### 3. Config: dono mora na chave (`src/web/api-keys.ts` + `config.ts`)

- Form de chave ganha o campo dono (dropdown de users ativos, obrigatório pra chave nova); vínculo deixa de ser editado no usuário. Perfil do usuário lista as N chaves dele. Chaves legadas sem dono continuam funcionando (sem assinatura — comportamento atual). Detalhes de UX na spec 87; aqui só a regra de dados.

### 4. Política de credencial dupla (mecanismo aqui; adoção por dispositivo é decisão do dono)

- **Chave-identidade**: `full`, SEM `private` — a credencial do dia a dia do agente, a que assina.
- **Chave-privada**: `full` + `private`, MESMO `user_id` — carregada só em sessão que precisa do privado. Sessão de palco NUNCA a carrega; instância de palco permanente (OpenClaw) nunca a recebe.
- Estado atual (PATs `full`+`private` emitidos na Fase 0) permanece válido: o split por dispositivo pode ser feito depois, sem quebra — emitir chave-identidade nova, trocar na máquina, manter a antiga como chave-privada ou revogar.

### 5. Desbloqueio imediato da Fase 0

- Com 1:N, os 3 vínculos pendentes são feitos ANTES da troca na máquina: chave antiga e nova apontam pro MESMO usuário; swap na máquina quando conveniente; revogação depois. Nota: `claude-code-vps` (hoje usada PELO PC) vinculada ao usuário Claude VPS mantém o PC assinando como Claude VPS ATÉ o swap pra `pat-pc-desktop` — janela conhecida e aceita, corrigida no passo (a) do checklist de propagação.

## Critérios de aceite

- [ ] Duas chaves do mesmo usuário: ambas resolvem `me` pro usuário certo.
- [ ] Chave sem `private` não vê nota/task privada mesmo sendo do MESMO usuário da chave privada.
- [ ] Revogar a chave-privada não afeta a assinatura pela chave-identidade.
- [ ] Backfill preserva os vínculos da Fase 0; fallback legado (`users.api_key_id`) coberto por teste.
- [ ] Comentário novo grava `author_key_id` além de `author_user_id`.
- [ ] Ciclo real: os 3 vínculos pendentes (`pat-pc-desktop`, `pat-vps-claude-code`, `pat-openclaw`) concluídos no console SEM janela quebrada, máquinas seguem operando com as chaves antigas até o swap.
- [ ] Suite verde.
