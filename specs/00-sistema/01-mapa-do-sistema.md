# Mapa do sistema: 2 Workers + MCP + Console + dados

> **Status:** draft · **Prioridade:** P0 · **Esforço:** S · **Repo:** ambos (expert-brain + expert-contacts)
> **Depende de:** nenhuma

## Contexto

Esta spec é o **documento de arquitetura atual** do ecossistema. Todo agente executor deve lê-la ANTES de trabalhar em qualquer outra spec dos diretórios `specs/`. Ela não propõe mudança nenhuma — consolida o estado real do código em julho/2026, com caminhos de arquivo verificados, para que specs subsequentes possam referenciar componentes sem redescrever o sistema.

O ecossistema tem **2 Cloudflare Workers** independentes que se falam por service binding:

1. **expert-brain** (este repo, open-source) — grafo de conhecimento pessoal (notas + edges + tasks), servido como MCP remoto + app web.
2. **expert-contacts** (repo privado, `C:\repos\expert-contacts`) — grafo de contatos (entidades polimórficas) + Expert Console multi-vault.

### 1. expert-brain (open-source)

**Worker único** com entrypoint em `src/index.ts` (53 linhas). Três responsabilidades no mesmo Worker:

**a) Auth dupla no `/mcp`** — `src/index.ts:25-40`:
- **PAT** (`Bearer eb_pat_*`): interceptado ANTES do OAuthProvider; `validateApiKey` (`src/auth/api-keys.ts`) compara o SHA-256 da chave (`crypto.subtle.digest('SHA-256', ...)`, linha 12) contra a tabela `api_keys` no D1. Chave válida injeta `ctx.props = { email: ownerEmail }` e repassa direto pro handler MCP.
- **OAuth**: tudo que não é PAT cai no `@cloudflare/workers-oauth-provider` (`src/index.ts:12-20`), com endpoints `/authorize`, `/token`, `/register`, `accessTokenTTL: 86400`, storage no KV `OAUTH_KV`. Senha do dono: PBKDF2-SHA-256 com **100.000 iterações** (hard cap do Workers runtime — `src/auth/password.ts:3-8`), formato `pbkdf2$sha256$<iter>$<salt>$<hash>`.

**b) MCP como Durable Object** — classe `ExpertBrainMCP` (`src/mcp/agent.ts`), binding `MCP_OBJECT` no `wrangler.toml`. As tools são registradas em `src/mcp/registry.ts` (`registerAllTools`): **~25 tools** = 10 de conhecimento (save_note, update_note, delete_note, restore_note, recall, expand, get_note, link, stats, reembed) + 6 de tasks (save_task, get_task, list_tasks_due_today, list_tasks, complete_task, update_task) + 2 de share (share_task, unshare_task) + 3 de mídia R2 (attach_media, get_note_media, delete_note_media — **condicionais a `env.MEDIA`**) + 4 de contatos read-only (list_contacts, search_contacts, get_contact, get_contact_by_phone — `src/mcp/tools/contacts.ts`, **condicionais a `env.CONTACTS`**, chamam o Worker de contacts via service binding). As instructions do handshake espelham os gates (`buildServerInstructions(prompt, {hasMedia, hasContacts})`).

**b2) Camada CLIENTE de captura (fora do Worker)** — o comportamento proativo ("salvar sozinho") NÃO vem do servidor: vem de 6 hooks do Claude Code instalados na máquina do usuário pelo onboarding (`scripts/install-claude-hooks.mjs`, chamado pelos DOIS caminhos do `scripts/setup.mjs`; templates em `scripts/claude-hooks/*.cjs`). Pipeline: SessionStart (prime) → capture-nudge (UserPromptSubmit, sinais de prazo/decisão/insight/métrica/contato com cooldown) → audit (PostToolUse) → stop-sweep (Stop, varredura de sessão longa sem save) → Pre/PostCompact. Zero rede, zero credencial; logs locais em `~/.claude/logs/`.

**c) Dados**:
- **D1** (binding `DB`): tabela `notes` ÚNICA servindo conhecimento E tasks. Os 7 kinds de conhecimento vivem em `KNOWLEDGE_KINDS`, e task é `kind='task'` na mesma tabela com colunas próprias (`status`, `due_at`, `priority`, `completed_at`) — `src/db/queries.ts:9-31`. O filtro canônico `NON_TASK_FILTER = (kind IS NULL OR kind <> 'task')` (`src/db/queries.ts:31`) mantém tasks fora das leituras de conhecimento.
- **FTS5 external-content**: `notes_fts` com `content='notes'`, sincronizada por triggers `notes_ai`/`notes_ad`/`notes_au` (`src/db/migrate.ts:17-36`).
- **Edges** com `why NOT NULL` (mínimo de 20 chars validado na app) e `relation_type` restrito por CHECK a 9 tipos (`src/db/migrate.ts:42-54`).
- **similar_edges pré-computadas** no write path: migration em código `0005_similar_edges` (`src/db/migrate.ts:108-124`); o refresh roda após o upsert do vetor (`src/db/queries.ts:70-88`). Motivo histórico: o grafo deixava de carregar quando as similaridades eram computadas on-read (fix do incidente do erro 1102 de CPU).
- **Migrations em código** (não só `.sql`): array `MIGRATIONS` em `src/db/migrate.ts:166-172` (0001_init → 0005_similar_edges; campos de task chegaram como `0006` — ver nota em `src/db/migrations/0003_task_fields.sql:4`). Aplicadas via **`POST /setup/provision` NÃO-autenticado** (`src/auth/handler.ts:19` → `handleProvision` em `src/auth/setup.ts`). Esse endpoint é o caminho de update dos alunos que rodam a própria instância — é idempotente (`CREATE ... IF NOT EXISTS` + registro em `_migrations`).
- **Vectorize** (binding `VECTORIZE`, índice bge-m3 **1024d**): embeda **só o `tldr`** da nota (`src/mcp/tools/save-note.ts:114` — `embed(env, input.tldr)`), com retry em `src/vector/index.ts:13-37`. Tasks NÃO são embedadas (nunca aparecem em recall/grafo — `src/mcp/tools/save-task.ts:25-31`).
- **R2** (binding `MEDIA`): mídia das notas com dedup por SHA-256 (`src/media/store.ts`).
- **Cron 11h UTC** (`[triggers]` no `wrangler.toml`): digest Telegram de tasks vencendo/atrasadas (`scheduled()` em `src/index.ts:47-53` → `runDueReminder` em `src/notify.ts`). **Dormente** até setar os secrets `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` — no-op seguro sem eles.

**d) App web em `/app`** (server-rendered, `src/web/`):
- CSP estrita em `src/web/render.ts:113-122`: `script-src 'self'` (zero inline script), `worker-src 'self'`, `frame-ancestors 'none'` + `X-Frame-Options: DENY`; única exceção é Google Fonts em style/font-src.
- Bundles client-side IIFE hasheados (`src/web/client/` — graph, local-graph, notes, tasks, note-media, shell, sim-worker), versão em `src/web/asset-version.ts`.
- Grafo Sigma + D3 com simulação em **Web Worker** (`src/web/client/sim-worker.ts`).
- Payload do grafo cacheado no **KV `GRAPH_CACHE`**, invalidado por `sourceHash` (`src/web/graph-data.ts:171-186`); o hash cobre conteúdo de `similar_edges`, então reembed/backfill invalida sozinho (`src/web/graph.test.ts:100-108`). Tasks ficam fora do payload (`src/web/graph-data.ts:80-81`).
- `/app/contacts`: o Brain puxa o grafo de contatos por trás via service binding `CONTACTS` (`src/web/contacts-data.ts`) — fetch global entre Workers da mesma conta dá erro 1042, service binding é o caminho oficial.

### 2. expert-contacts (privado)

**Worker único** com entrypoint `src/index.ts`. API REST de **entidades polimórficas**: nós uniformes com `kind = person | company | group | place | event | other`, arestas `connections` com `why >= 20 chars` (mesma filosofia do Brain), `events` (log de interação) e `media` (R2). Rotas principais documentadas no header de `src/index.ts:14-30` (`/save_person`, `/save_company`, `/entities/:id`, `/recall_entity`, `/connect`, `/event`, `/graph/data`, etc.).

- **Auth**: `Bearer OWNER_TOKEN` para escrita; **`CONTACTS_PROXY_TOKEN` dá acesso SOMENTE-LEITURA (GET)** — é o token que o MCP do Brain usa via service binding (`requireAuth` em `src/index.ts:71-80`).
- **Expert Console multi-vault em `/app`** (`src/web/handler.ts`, roda antes do roteamento da API): adapters por vault em `src/vaults/` — `contacts.ts` (in-process, mesmo Worker) e `brain.ts` (remoto, via **service binding `BRAIN`** declarado no `wrangler.toml`; a request segue sendo HTTP com Bearer, então a auth do Brain continua valendo).
- **Cron diário 9h UTC** (`wrangler.toml [triggers]`): `handleMaintenanceSync` (`src/index.ts:627`) — sync incremental do CRM (Pipedrive), preenche campos vazios de contatos existentes com pessoas modificadas desde o último run. Também disparável manual via `POST /maintenance/run` (`src/index.ts:714`).
- **Volume**: ~7,6k entidades, das quais ~5,7k são imports crus (nome = número de telefone, sem letra) **escondidos por default** — filtro `AND name GLOB '*[A-Za-z]*'` a menos que `include_raw=true` (`src/index.ts:340-380`).
- **MCP standalone stdio** em `mcp/index.js`: proxy fino que traduz tools (save_person, save_company, recall, get_entity, connect, log_event, stats) em chamadas HTTP ao Worker, auth via env `EXPERT_CONTACTS_TOKEN`.

### 3. Diagrama de fluxos

```
Instâncias do dono (Claude Code PC/notebook/VPS, Claude web, ChatGPT)
        │  HTTPS  (PAT eb_pat_* OU OAuth)
        ▼
┌─────────────────────────── expert-brain (Worker) ───────────────────────────┐
│  /mcp ──► Durable Object ExpertBrainMCP (~22 tools)                          │
│              │── notas/tasks ──► D1 (notes, edges, similar_edges, FTS5)      │
│              │── semântica ────► Vectorize (bge-m3 1024d, embeda só o tldr)  │
│              │── mídia ────────► R2 (dedup SHA-256)                          │
│              └── contatos (RO) ─► service binding CONTACTS ──┐               │
│  /app ──► app web server-rendered (CSP estrita, KV GRAPH_CACHE)              │
│  /setup/provision ──► migrations em código (caminho de update dos alunos)    │
│  cron 11h UTC ──► digest Telegram de tasks (dormente sem secrets)            │
└──────────────────────────────────────────────────────────────┼──────────────┘
                                                               ▼
┌─────────────────────────── expert-contacts (Worker) ─────────────────────────┐
│  API REST entities/connections/events/media (OWNER_TOKEN escrita,            │
│    CONTACTS_PROXY_TOKEN leitura GET)                                          │
│  /app ──► Expert Console multi-vault                                          │
│     adapter contacts: in-process │ adapter brain: service binding BRAIN ──►   │
│                                                    (volta pro expert-brain)   │
│  cron 9h UTC ──► sync incremental Pipedrive                                    │
│  mcp/index.js (stdio) ──► proxy fino HTTP pro Worker                          │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 4. Invariantes de design (specs futuras DEVEM preservar)

1. **Task fora do conhecimento**: `kind='task'` nunca entra em recall, grafo, FTS de leitura nem stats de conhecimento (`NON_TASK_FILTER`, `src/db/queries.ts:31`; sem embedding, `src/mcp/tools/save-task.ts:31`).
2. **Soft-delete Vectorize-first**: `delete_note` remove o vetor ANTES de marcar `deleted_at` no D1; se o Vectorize falhar, nada é deletado e o erro instrui retry (`src/mcp/tools/delete-note.ts:60-76`). Edges/tags ficam escondidas, não removidas — `restore_note` traz tudo de volta.
3. **SQL 100% parametrizado**: todo acesso D1 via `prepare(...).bind(...)` — nunca interpolar input em string SQL.
4. **CSP sem inline script**: `script-src 'self'` (`src/web/render.ts:113-122`). Nenhuma feature nova pode exigir `unsafe-inline` em script.
5. **Embed-antes-do-insert**: o vetor é computado ANTES do insert no D1 (`src/mcp/tools/save-note.ts:114`); se o embedding falha, a nota não nasce — evita nota sem vetor (invisível no recall).
6. **Migrations sempre aditivas e idempotentes**: novas migrations entram no array de `src/db/migrate.ts` com `IF NOT EXISTS`/`ADD COLUMN`, nunca `DROP`/rebuild destrutivo — `/setup/provision` precisa continuar seguro pra instâncias de alunos em qualquer versão anterior.
7. **Worker-to-Worker só via service binding** (bindings `CONTACTS` e `BRAIN`), nunca fetch global (erro 1042 da Cloudflare).
8. **Repo open-source**: nenhum dado pessoal, credencial, ID de conta ou nome de cliente em código, docs ou specs. Config real fica em `wrangler.toml` (gitignored); o template versionado é `wrangler.example.toml`.

## Problema / Motivação

- O conhecimento arquitetural está fragmentado em comentários de código (`src/index.ts:1-53`, header de `expert-contacts/src/index.ts:1-30`, comentários do `wrangler.toml`) e em 5 revisões de arquitetura feitas em sessões separadas — nenhum documento único consolida.
- Agentes executores de specs sem esse mapa redescobrem o sistema a cada tarefa (custo de contexto) e violam invariantes não óbvios — ex.: o motivo do Vectorize-first no delete (`src/mcp/tools/delete-note.ts:60-64`) e o motivo das `similar_edges` pré-computadas (`src/db/migrate.ts:108-115`) só existem em comentários locais.
- O caminho de update dos alunos (`POST /setup/provision` não-autenticado, `src/auth/handler.ts:19`) impõe restrições em TODA migration futura — quem não sabe disso quebra instâncias de terceiros.

## Objetivo

Existir um documento único e verificado (`specs/00-sistema/01-mapa-do-sistema.md`) que qualquer agente leia em < 5 minutos e saia sabendo os 2 Workers, os fluxos de dados, os bindings e os 8 invariantes — sem precisar abrir código.

## Design proposto

Esta spec É o entregável: o próprio documento acima (seções Contexto, Diagrama, Invariantes). Passos:

1. Criar `specs/00-sistema/01-mapa-do-sistema.md` com o conteúdo desta spec (feito neste arquivo).
2. Toda spec futura em `specs/` declara no cabeçalho `Depende de: 00-sistema/01-mapa-do-sistema.md` (ou herda implicitamente via instrução do orquestrador de que este mapa é leitura obrigatória).
3. Quando uma spec executada alterar arquitetura (novo binding, nova tabela, novo invariante), o PR correspondente DEVE atualizar este mapa no mesmo commit.

Sem SQL, sem migration — documento puro. Nada aqui toca dados existentes.

## Fora de escopo

- Propor QUALQUER mudança de arquitetura, refactor ou feature — isso é papel das specs numeradas seguintes.
- Documentar detalhes de deploy/conta (IDs de account, database, KV) — ficam no `wrangler.toml` local de cada repo, fora do controle de versão público.
- Documentar o histórico das 5 revisões — só o estado consolidado atual.
- Runbooks operacionais (curadoria, custo de token) — já existem em `docs/curation-runbook.md` e `docs/token-cost.md`.

## Critérios de aceite

- [ ] Arquivo `specs/00-sistema/01-mapa-do-sistema.md` existe no repo expert-brain.
- [ ] Descreve os 2 Workers (expert-brain e expert-contacts) com responsabilidades e caminhos de arquivo reais.
- [ ] Documenta a auth dupla do `/mcp` (PAT SHA-256 em `api_keys` + OAuth com PBKDF2 100k) com referência a `src/index.ts:25-40`, `src/auth/api-keys.ts` e `src/auth/password.ts`.
- [ ] Documenta a tabela `notes` única (conhecimento + `kind='task'`), FTS5 external-content, edges com `why>=20` e `similar_edges` no write path.
- [ ] Documenta `POST /setup/provision` como caminho de update dos alunos e a restrição de migrations aditivas.
- [ ] Contém o diagrama de fluxos (instâncias → MCP → D1/Vectorize/R2; brain → CONTACTS; Console → BRAIN).
- [ ] Lista os invariantes: task fora do recall/grafo/FTS, soft-delete Vectorize-first, SQL parametrizado, CSP sem inline, embed-antes-do-insert, service binding W2W, migrations aditivas.
- [ ] Zero credencial, ID de conta/database/KV, dado pessoal ou nome de cliente no texto.
- [ ] Todas as referências arquivo:linha conferem com o código atual (spot-check de pelo menos 5 referências).

## Validação

Documento — não há typecheck/vitest a rodar para ele em si. Validação:

```bash
# 1. Spot-check das referências arquivo:linha citadas
grep -n "eb_pat_" C:/repos/expert-brain/src/index.ts            # ~linha 27
grep -n "ITERATIONS = 100_000" C:/repos/expert-brain/src/auth/password.ts
grep -n "NON_TASK_FILTER" C:/repos/expert-brain/src/db/queries.ts # linha 31
grep -n "0005_similar_edges" C:/repos/expert-brain/src/db/migrate.ts
grep -n "CONTACTS_PROXY_TOKEN" C:/repos/expert-contacts/src/index.ts

# 2. Varredura de vazamento (deve retornar vazio no arquivo da spec)
grep -inE "eb_pat_[a-z0-9]|account_id|database_id|Bearer [A-Za-z0-9]{20}" \
  C:/repos/expert-brain/specs/00-sistema/01-mapa-do-sistema.md
```

Nenhum deploy envolvido. Commit/push do repo expert-brain só com OK do dono (regra do repo `expertintegrado/*`).

## Arquivos afetados

- `specs/00-sistema/01-mapa-do-sistema.md` (novo — este arquivo)

## Riscos e reversão

- **Risco**: mapa ficar stale conforme o código evolui → mitigação é a regra do Design proposto (PR que muda arquitetura atualiza o mapa no mesmo commit); referências arquivo:linha podem derivar, por isso cada uma vem acompanhada do nome do símbolo (grep sobrevive a renumeração de linha).
- **Risco**: vazamento acidental de dado sensível em edição futura → o grep de varredura da seção Validação roda em todo review deste arquivo.
- **Reversão**: `git revert` do commit que adicionou/alterou o arquivo — documento puro, sem efeito em runtime, dados ou deploy.
