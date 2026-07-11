# Assinatura de agente: autoria de comentário derivada da credencial

> **Status:** draft (aprovada 11/07/2026) · **Prioridade:** P1 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** migration 0017 (`users`), spec 37 (`resolveMe`/user-ref). Plano-mãe: grupo 80.

## Problema

1. `comment_task` grava `author='agent'` + `author_name` **livre e autodeclarado** (`src/mcp/tools/comment-task.ts`): qualquer credencial pode assinar como qualquer agente. Num board que vira barramento de comunicação, isso permite falsificação de autoria.
2. O mecanismo certo já existe e não é usado aqui: `resolveMe(env, auth)` (`src/mcp/tools/user-ref.ts`) resolve PAT → `api_key_id` → usuário, e `registerAllTools` já injeta `AuthContext` nas tools de escrita (`src/mcp/registry.ts`). `registerCommentTask` é das poucas que não recebe `auth`.
3. Caso real que provou o risco: o PAT usado pelo PC desktop estava vinculado a `user_claudevps` — tudo que o PC "assinava" saía como outro agente.
4. A tabela `task_comments` (`src/db/queries.ts`, `addTaskComment`) não tem coluna de usuário — comentários web do dono e comentários de agente são distinguidos só por `author` ('owner'/'agent') + texto livre.

## Design

### 1. Migration 0020 (`src/db/migrate.ts`)

- `0020_comment_author_user`: `ALTER TABLE task_comments ADD COLUMN author_user_id TEXT` (aditiva, NULL nos legados). Espelho `.sql` de referência segue a sequência própria dos arquivos (próximo: `0006_...`), como documentado em `0004_api_key_scopes.sql`.

### 2. comment_task assina pela credencial (`src/mcp/tools/comment-task.ts`)

- `registerCommentTask(server, env, auth)` (novo parâmetro, mesmo padrão de `save_task`).
- No handler: `const me = await resolveMe(env, auth)`.
  - `me` resolvido → grava `author_user_id = me.id`; o retorno inclui `author_user` `{id, name, type}`.
  - `me` NULL (PAT sem usuário vinculado) → **fail-closed**: `toolError` instrutivo ("credencial sem perfil vinculado; o dono vincula em /app/config → Usuários"). Comentário de agente sem assinatura não entra mais. Sessão OAuth do dono resolve pro perfil owner (comportamento do `resolveMe` já cobre).
- `author_name` deixa de ser identidade: aceito só como rótulo COMPLEMENTAR de exibição (ex: nome da sessão/skill), nunca substitui o usuário. Descrição da tool reescrita deixando isso explícito.

### 3. Render com assinatura (`src/web/comments-render.ts` + `get_task`)

- Comentário com `author_user_id`: exibir nome + avatar do usuário (join com `users`), padrão visual dos assignees no card.
- Comentário legado sem `author_user_id`: exibir como hoje, com selo discreto "não assinado (legado)". Nenhum backfill — legado fica legado.
- `get_task` (thread) passa a devolver `author_user` por comentário quando existir.

### 4. writeActor unificado

- `addTaskComment` também alimenta o `task_activity` existente? NÃO — comentário não é edição de campo; fica fora do activity log (comportamento atual preservado). A auditoria de comentário é a própria linha em `task_comments`, agora com autor verificável.

## Operacional (fora do código, checklist do dono — pré-requisito pro grupo 80)

- [ ] 1 PAT por dispositivo, vinculado 1:1 em /app/config: PC desktop, notebook, VPS claude-code, VPS claude-code-backup, OpenClaw. Corrigir o vínculo errado do PC (hoje aponta pra `user_claudevps`).
- [ ] Rotacionar o `eb_pat_` exposto em transcript (task `h012csvpt0h6`) — com credencial virando assinatura, chave exposta = autoria falsificável.
- [ ] Escopos mínimos por credencial (`scopes` de `api_keys`, spec 10-backend/17): instâncias de demo/palco (OpenClaw) sem escopo `private`.
- [ ] Cartão de agente: uma nota por dispositivo (quem é, o que faz, como acordá-lo).

## Critérios de aceite

- [ ] Comentário via PAT vinculado grava `author_user_id` correto e o board mostra nome+avatar do agente.
- [ ] Comentário via PAT sem vínculo é rejeitado com erro instrutivo (nenhuma linha gravada).
- [ ] `author_name` sozinho não define mais a identidade exibida quando há usuário resolvido.
- [ ] Comentários legados continuam renderizando, com selo "não assinado".
- [ ] `get_task` devolve `author_user` nos comentários assinados.
- [ ] Provision novo aplica 0020 (coluna visível no schema); instância existente migra sem tocar em dados.
- [ ] Suite verde (unit em vitest cobrindo os 3 caminhos: vinculado, não-vinculado, owner OAuth).
