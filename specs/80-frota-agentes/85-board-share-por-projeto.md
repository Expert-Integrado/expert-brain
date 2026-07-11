# Board compartilhado por projeto com nível de permissão

> **Status:** draft (aprovada 11/07/2026, execução após 81-84 no ar) · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `81` (assinatura — pra distinguir interno de externo), `82` (mailbox), `84` (protocolo — externo nunca é ordem). Plano-mãe: grupo 80.

## Problema

1. Hoje só existe share de task INDIVIDUAL (`share_task` → `share_token` em `notes`, rota `/s/<token>`). O dono quer compartilhar um RECORTE do board — as tasks de um projeto — com um humano ou uma IA de fora, com permissão controlada.
2. Sem identidade externa, qualquer escrita de fora seria anônima — inaceitável no modelo assinatura (spec 81).

## Design

### 1. Migration 0022 (`src/db/migrate.ts`)

`0022_project_shares`:

```sql
CREATE TABLE IF NOT EXISTS project_shares (
  token TEXT PRIMARY KEY,          -- psh_<random 128-bit url-safe>
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,             -- identidade externa exibida ("Cliente X", "Agente da ACME")
  mode TEXT NOT NULL,              -- 'read' | 'comment'
  created_at INTEGER NOT NULL,
  expires_at INTEGER,              -- NULL = sem expiração
  revoked_at INTEGER
);
```

### 2. Superfície pública `/p/<token>` (`src/web/`)

- Board somente do projeto: colunas + cards + thread de comentários. NUNCA: notas, grafo, contatos, tasks privadas (task `private=1` fica fora mesmo dentro do projeto — fail-closed, mesmo racional do share de task), outros projetos.
- `mode='read'`: zero formulário.
- `mode='comment'`: formulário de comentário; grava com `author='external'`, `author_user_id=NULL` e `author_name = label do token` — render com selo EXTERNO destacado, inconfundível com agente assinado (spec 81 §3).
- Comentário externo gera item de mailbox pros assignees (kind `comment_on_assigned`) — os agentes ficam sabendo, e o protocolo (spec 84) já os obriga a tratar como dado externo, nunca ordem.
- Rate limit simples por token (KV, mesmo espírito dos contadores da spec 76) — board público com escrita é superfície de abuso.

### 3. Gestão no console (`/app/config` ou página do projeto)

- Criar/revogar share por projeto: label, modo, expiração. Listar ativos com URL. Revogação imediata (`revoked_at`).
- Auditoria: criação/revogação logada no console (padrão de eventos existente).

### 4. Fora de escopo (registrado pra não crescer)

- Credencial MCP pra IA externa (seria um PAT `read` escopado — já existe mecanismo; decisão futura do dono).
- Board corporativo multi-dono com credenciais geridas pelo AI OS — evolução declarada pelo dono, não desenhada aqui.

## Critérios de aceite

- [ ] `/p/<token>` read mostra só as tasks não-privadas do projeto; token revogado/expirado → 404 neutro.
- [ ] `mode='comment'`: externo comenta, aparece com selo EXTERNO + label; assignees recebem item no mailbox.
- [ ] Task privada dentro do projeto compartilhado NUNCA aparece.
- [ ] Nada além do recorte vaza (notas, grafo, outros projetos) — teste e2e navegando o token.
- [ ] Rate limit ativo no POST de comentário.
- [ ] Console cria/lista/revoga shares; suite verde.
