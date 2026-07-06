# Comentários em tasks: thread no console, tool MCP e comentário de convidado no link público

> **Status:** in-progress · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma (acoplamento suave com `50-console-v2/52`: o card/detalhe exibem contagem/thread quando esta spec existir; qualquer ordem funciona)
> **Agente sugerido:** Opus (superfície pública sem auth exige cuidado)

## Contexto

- **Não existe nenhuma estrutura de comentários no repo** — nem em tasks, nem em notas. O único registro pós-fato é o `outcome` do `complete_task`, anexado ao body como `**Resultado:** ...` num write único (`src/mcp/tools/complete-task.ts:9,17`).
- Task = nota `kind='task'` na tabela `notes`; migrations runtime no array de `src/db/migrate.ts` (última `0008_share_task` → esta spec cria a `0010`; a `0009` é da spec 51 — se a 51 ainda não tiver rodado, usar o próximo número livre e anotar aqui).
- O compartilhamento público já existe: página `/s/<token>` (`src/web/share.ts`, SSR puro fora do bundle, token hasheado, expiração obrigatória; rota interceptada sem auth em `src/auth/handler.ts:19-27` e espelhada pra testes em `src/web/worker.ts:13-20`).
- **Decisão do dono da instância**: convidado (quem recebe o link) PODE comentar — com nome, sem login.
- KV disponível no worker: `GRAPH_CACHE` e `OAUTH_KV` (`wrangler.toml:65-70`). Não criar namespace novo (custo de provisioning nas instâncias de alunos) — rate-limit usa `GRAPH_CACHE` com prefixo de chave.
- Padrão de escape de HTML já existe no SSR (usado em toda página; reusar o helper do módulo web).

## Problema / Motivação

- Task não tem histórico de discussão: o contexto de "por que isso travou/mudou" morre no WhatsApp ou se perde (`complete-task.ts:9` só cobre o desfecho).
- O link público é read-only: o dono compartilha uma task com alguém da equipe e a pessoa não tem como responder ALI — a resposta volta por outro canal e se desconecta da task.
- Agentes (via MCP) também não têm como anotar progresso sem sobrescrever o body.

## Objetivo

Thread de comentários por task com três autores possíveis (dono no console, agente via MCP, convidado na página pública com rate-limit), contagem visível no board, e superfície pública que não vira vetor de spam/XSS.

## Design proposto

### 1. Migration runtime `0010_task_comments` (aditiva)

```sql
CREATE TABLE IF NOT EXISTS task_comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  author      TEXT NOT NULL CHECK (author IN ('owner','guest','agent')),
  author_name TEXT,                                   -- obrigatório quando author='guest' (≤60 chars)
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments (task_id, created_at);
```

Queries em `src/db/queries.ts`: `addTaskComment`, `listTaskComments(taskId, limit, offset)`, `countTaskComments` (e variante em lote pro payload do board), `deleteTaskComment(id)` — delete só via console do dono.

### 2. Console (sessão do dono)

- `POST /app/tasks/comment { task_id, body }` → author `owner`. `POST /app/tasks/comment/delete { id }` → dono apaga QUALQUER comentário (inclusive de convidado — moderação).
- Página de detalhe da task: seção **Atividade** com a thread (autor + nome quando guest + data BRT + corpo com escape), form de novo comentário no rodapé, botão de apagar por item. Se a spec 52 já tiver reorganizado o detalhe, a thread entra no contêiner de Atividade dela; senão, seção ao fim da página atual (`src/web/notes.ts:499`).
- Payload do board (`handleTasksData`, `src/web/tasks.ts:79-103`): `comment_count` por task (1 query em lote, não N+1).

### 3. MCP

- Tool nova `comment_task { task_id, body, author_name? }` → author `agent` (author_name default "agente"; aparece na thread como "agente · <nome>"). Arquivo novo `src/mcp/tools/comment-task.ts`, registrado em `src/mcp/registry.ts`, seguindo o padrão dos arquivos vizinhos (validação de task existente + kind='task' + not deleted).
- `get_task` (`src/mcp/tools/get-task.ts`): inclui `comments` (últimos 50, ordem cronológica) e `comment_count`.
- `list_tasks`: inclui `comment_count` por item (aditivo).

### 4. Página pública `/s/<token>` — convidado comenta

Na página de share (`src/web/share.ts`):

- Renderizar a thread (mesmo escape do console; nome do guest + data; comentários de `owner` aparecem como "dono"). SSR puro, sem bundle — manter o padrão do módulo.
- Form: campo **nome** (obrigatório, ≤60) + **comentário** (≤2000 no público) + campo honeypot invisível (`name="website"`, CSS `display:none`; preenchido = descarta com 200 silencioso).
- `POST /s/<token>/comment` (SEM auth; rota junto da interceptação existente em `src/auth/handler.ts:19-27` e no worker de testes):
  1. `resolveShare(token)` — share inexistente/expirado/revogado → 404 (mesma resposta da página; não vaza existência).
  2. **Rate-limit em `GRAPH_CACHE`** (prefixo `rl:cmt:`): por token `rl:cmt:t:<hash>` máx 10/h, por IP `rl:cmt:ip:<sha256(ip)>` máx 5/h — contador com TTL 3600 via `expirationTtl`; estourou → HTTP 429 com mensagem na página. IP de `CF-Connecting-IP`; hashear antes de usar como chave (não persistir IP puro).
  3. Validar tamanhos, gravar com `author='guest'`, redirect 303 de volta pra `/s/<token>#comentarios`.
- **Sem cookies, sem JS obrigatório** (form HTML puro com POST) — funciona em qualquer navegador de convidado.
- Revogação/expiração do share corta leitura E escrita no mesmo instante (tudo passa por `resolveShare`).

### 5. Segurança (checklist do executor)

- Escape de HTML em TODOS os pontos de render (console, público, MCP retorna texto puro).
- Sem markdown render no comentário (texto puro com quebras de linha) — elimina classe inteira de XSS.
- `author_name` também escapado e com trim; rejeitar vazio pra guest.
- Nenhum dado do convidado além de nome+texto+timestamp é armazenado (IP só hasheado e só no KV volátil do rate-limit).

## Fora de escopo

- Notificação de comentário novo (Telegram digest = `40-ops/46`; anotar lá como fonte futura).
- Comentários em NOTAS de conhecimento (se um dia, spec própria; a tabela é `task_comments` de propósito).
- Edição de comentário (só criar/apagar), reações, anexos em comentário.
- Login/identidade de convidado.

## Critérios de aceite

- [ ] Dono comenta e apaga qualquer comentário pelo console; thread com autor/nome/data BRT corretos.
- [ ] `comment_task` via MCP cria comentário `agent`; `get_task` traz thread e contagem; `list_tasks` traz contagem.
- [ ] Convidado comenta pela página pública com nome; comentário aparece pro dono no console imediatamente.
- [ ] Rate-limit: 11º comentário no mesmo token dentro de 1h → 429; honeypot preenchido → descartado sem erro visível.
- [ ] Share revogado/expirado: GET e POST retornam 404.
- [ ] Comentário com `<script>` ou HTML renderiza como texto inerte em TODAS as superfícies.
- [ ] `comment_count` no board bate com a thread (query em lote, sem N+1 — verificar nº de queries no teste).

## Validação

- `npm run typecheck` e `npm test` verdes.
- Testes novos: CRUD de comentário (owner/agent), fluxo público completo (share ativo → comenta; revogado → 404; rate-limit com KV simulado; honeypot), escape de HTML, contagem em lote, cascade no soft-delete da task (comentários de task deletada não vazam em nenhuma superfície).
- Manual: compartilhar task real, abrir aba anônima, comentar como convidado, ver no console, apagar.
- **Gate de deploy:** só com OK explícito do dono da instância.

## Arquivos afetados

- `src/db/migrate.ts` (migration 0010), `src/db/queries.ts` (queries de comentário)
- `src/web/share.ts` (thread + form + POST público + rate-limit)
- `src/auth/handler.ts` e `src/web/worker.ts` (rota POST `/s/<token>/comment`)
- `src/web/tasks.ts` (comment_count no payload), `src/web/notes.ts` (seção Atividade)
- `src/mcp/tools/comment-task.ts` (nova), `get-task.ts`, `list-tasks.ts`, `src/mcp/registry.ts`
- `test/` (suites acima)

## Riscos e reversão

- **Risco**: spam apesar do rate-limit (botnet multi-IP). Mitigação: teto absoluto por task (`countTaskComments` guest ≥ 200 → fecha form com aviso); dono revoga o share a qualquer momento.
- **Risco**: enumeração de tokens via POST. Mitigação: mesma resposta 404 do GET; tokens têm 256 bits.
- **Reversão**: revert do código; tabela fica inerte. Comentários gravados permanecem no banco (dados do dono; não apagar em rollback).
