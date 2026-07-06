# Selo de privacidade: flag private nas notas + acesso gated por escopo de PAT

> **Status:** done · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-brain
> **Depende de:** `10-backend/17-credenciais-escopos-pat-e-bearer.md`
>
> **Execução:** migration `0013_private_notes` (o `0009` citado no design era indicativo — o trilho já ia até `0012_api_key_scopes`); espelho SQL em `src/db/migrations/0005_private_notes.sql`. `scopes` virou CSV com helper `hasScope`. Read paths de TASK (get_task/list_tasks) e getTaskById do web NÃO foram gateados aqui (fora de escopo — spec `50-console-v2/59`). Toggle web aceita form-encoded (UI CSP-safe) e JSON. `tsc` + suíte verdes (66 arquivos, 578 testes + auth). **Gate de release (wrangler dev + validação manual do dono + deploy) PENDENTE — só com OK explícito do dono.**

## Contexto

Toda nota do vault é visível pra QUALQUER credencial válida. Não existe nenhum conceito de nota privada:

- O schema de `notes` (`src/db/migrate.ts:7-16`, migração `0001_init`) tem `id/title/body/tldr/domains/kind` + colunas posteriores de soft-delete (`0004`), tasks (`0006`) — nenhuma coluna de visibilidade.
- Os read paths MCP servem tudo que passa no filtro `deleted_at IS NULL`:
  - `recall` (`src/mcp/tools/recall.ts`) — hidrata os matches do Vectorize + FTS numa query D1 (`recall.ts:91-93`) e tem um segundo pool por `domains_filter` (`recall.ts:75-81`). Ambos filtram só soft-delete.
  - `ftsSearch` (`src/db/queries.ts:209-224`) — usado pelo `recall` e pela busca web (`src/web/search.ts:18`).
  - `get_note` (`src/mcp/tools/get-note.ts:23`) — via `getNoteById` (`src/db/queries.ts:141-146`).
  - `expand` (`src/mcp/tools/expand.ts:36-59`) — nota base via `getNoteById`, vizinhos via `getEdgesFrom`/`getEdgesTo` (`src/db/queries.ts:177-191`, que já filtram vizinho soft-deletado no JOIN) + hidratação em `expand.ts:57-59`.
  - `stats` (`src/mcp/tools/stats.ts:48-79`) — conta todas as notas de conhecimento.
- O lado web (sessão de cookie do dono, `requireSession`): lista de notas (`src/web/notes.ts:55-57`), detalhe (`src/web/notes.ts:138`), grafo (`src/web/graph-data.ts:81`), meta do grafo (`src/web/graph-data.ts:311-314`) e busca (`src/web/search.ts`).
- A spec `10-backend/17` introduz `api_keys.scopes` (migração `0008_api_key_scopes`), o `AuthContext` com `scopes`/`keyId` propagado até `registerAllTools` (`src/mcp/registry.ts:22`) e o gate de tools por escopo. **Esta spec constrói em cima disso** — sem a 17 implementada, não há como saber quem chama uma tool.

## Problema / Motivação

- **Qualquer PAT lê o vault inteiro.** Um token criado pra um agente de nicho (ex.: agente que só faz `recall` de conteúdo de marketing) recebe também notas sensíveis — decisões estratégicas, avaliações de pessoas, dados financeiros. `recall.ts:91-93`, `get-note.ts:23` e `expand.ts:57-59` não têm nenhum eixo de visibilidade além de `deleted_at IS NULL`.
- **Mesmo o escopo `read` da spec 17 não resolve:** ele limita QUAIS tools existem, não QUAIS notas elas devolvem. Um PAT `read` continua vendo 100% do conteúdo via `recall`.
- **O dono não tem como salvar algo "só pra mim".** O único controle hoje é não salvar — o que quebra a filosofia do vault (backlog `backlog-1` do inventário de falhas, `specs/00-sistema/02-inventario-de-falhas.md`).
- **Superfícies de vazamento são muitas e independentes:** vetor (Vectorize → hidratação D1 em `recall.ts:91`), FTS (`queries.ts:214-222`), grafo por edges (`queries.ts:177-191`), pool por domínio (`recall.ts:75-81`), stats agregado (`stats.ts:51-78`). Um filtro esquecido em UMA delas anula o selo — o mesmo padrão que o soft-delete já enfrentou (ver comentário em `src/db/migrate.ts:101-103`).

## Objetivo

Nota marcada como `private` NUNCA aparece (nem em contagem) pra credencial sem o escopo `private` em nenhum read path MCP (recall, FTS, get_note, expand, stats), enquanto a sessão web do dono continua vendo tudo com badge visual — verificado por teste de vazamento por superfície.

## Design proposto

### 1. Migração aditiva — coluna `private` + índice parcial

Em `src/db/migrate.ts`, adicionar ao array `MIGRATIONS` (`src/db/migrate.ts:166-174`) **após** a `0008_api_key_scopes` da spec 17:

```ts
// 0009 — selo de privacidade. ADD COLUMN é seguro (não recria a tabela; rebuild
// cascatearia edges/tags, ver comentário da 0002). DEFAULT 0 = todas as notas
// existentes continuam públicas: zero mudança de comportamento até o dono marcar.
// Índice PARCIAL (WHERE private = 1): custo zero pras notas públicas (maioria).
// NOTA: o trigger notes_au reinsere a linha no FTS em qualquer UPDATE — a nota
// private CONTINUA no notes_fts. O gate é 100% nos read paths (igual soft-delete).
const MIGRATION_0009_STMTS: string[] = [
  `ALTER TABLE notes ADD COLUMN private INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_notes_private ON notes(private) WHERE private = 1`,
];
// ...
{ id: '0009_private_notes', stmts: MIGRATION_0009_STMTS },
```

Espelhar em `src/db/migrations/0005_private_notes.sql` (a 17 já ocupa `0004_api_key_scopes.sql`).

### 2. Escopo `private` — `scopes` vira lista CSV

A spec 17 define `api_keys.scopes` como string simples (`'full'` | `'read'`) e prevê "se um dia virar lista, migra pra CSV sem quebrar" — este é o dia:

- Formato: CSV, ex. `'full'`, `'read'`, `'full,private'`, `'read,private'`. Nenhuma migração de dados: valores existentes (`'full'`/`'read'`) já são CSVs de 1 item.
- Helper em `src/auth/api-keys.ts`:

```ts
export function hasScope(scopes: string | undefined, scope: string): boolean {
  return (scopes ?? 'full').split(',').map((s) => s.trim()).includes(scope);
}
```

- Regra de visibilidade (fail-closed): `canSeePrivate = hasScope(auth.scopes, 'private') || auth veio de sessão OAuth do dono` (na 17, sessão OAuth não tem `keyId` — usar `auth.keyId === undefined` como marcador de "dono logado"). **PAT `full` SEM `private` não vê nota privada** — `full` dá CRUD, não confidência.
- UI de criação de chave (`src/web/config.ts`, form da 17): checkbox "Acesso a notas privadas" que appenda `,private` ao scope escolhido. Coluna Escopo da tabela mostra o CSV.

### 3. Filtro `private` em TODOS os read paths MCP

Convenção espelhada no soft-delete: constante única em `src/db/queries.ts`:

```ts
// Fragmento de visibilidade. `private` é INTEGER 0/1 NOT NULL DEFAULT 0.
export const PUBLIC_ONLY_FILTER = `private = 0`;
```

E parâmetro aditivo `includePrivate: boolean` (default `false` = fail-closed) nas funções de leitura:

- `getNoteById(env, id, includeDeleted = false, includePrivate = false)` — quando `false`, appenda `AND private = 0`. Chamadas existentes continuam compilando; **call sites web** (`src/web/notes.ts:138`, `notes.ts:273` via `getTaskById`) passam `true` (sessão = dono).
- `ftsSearch(env, query, limit, prefix, includePrivate = false)` — appenda `AND n.private = 0` no WHERE (`queries.ts:218-219`). A busca web (`src/web/search.ts:18`) passa `true`.
- `getEdgesFrom` / `getEdgesTo` (`queries.ts:177-191`) — mesmo padrão do soft-delete no JOIN: quando `includePrivate = false`, o WHERE ganha `AND n.private = 0`. Nota privada não aparece como vizinho.
- Registry: `registerAllTools(server, env, auth)` (assinatura da 17) repassa `auth` também às tools de LEITURA; cada uma computa `canSeePrivate` (item 2) e o injeta nas queries:
  - `recall.ts` — 3 pontos: query do pool por domínio (`recall.ts:76-81`, `AND n.private = 0`), hidratação principal (`recall.ts:91-93`, `AND private = 0`) e o `ftsSearch` (`recall.ts:60`). O Vectorize pode retornar ids privados no top-30 — eles caem na hidratação D1 (aceitável: o caller sem escopo recebe menos resultados, nunca resultados errados). Não adicionar metadata `private` no Vectorize nesta spec (o filtro D1 é a única fonte de verdade; metadata dessincronizaria no toggle).
  - `get-note.ts:23` e `expand.ts:36` — `getNoteById(env, id, false, canSeePrivate)`. Nota privada pra caller sem escopo = mesmo erro de "not found" (indistinguível de inexistente — não vazar que existe).
  - `expand.ts:57-59` — hidratação dos vizinhos ganha `AND private = 0` quando `!canSeePrivate` (defesa em profundidade além do JOIN do item acima).
  - `stats.ts:51-78` — todas as subqueries ganham `AND private = 0` quando `!canSeePrivate`. Caller COM escopo recebe adicionalmente `private_notes: N` no payload.

### 4. Escrita: `private: true` no save/update + tool one-way `mark_private`

- `save_note` (`src/mcp/tools/save-note.ts:16-29`): novo campo `private: z.boolean().optional()` (default `false`); `insertNote` (`queries.ts:47-52`) ganha coluna `private` no INSERT (parâmetro aditivo, default 0). Qualquer caller com a tool registrada pode CRIAR privada — marcar é barato e fail-safe.
- `update_note` (`src/mcp/tools/update-note.ts:9-22`): aceita `private: true` **somente**. `private: false` retorna `toolError` explicando que desmarcar só é possível na UI logada (`/app/notes/{id}`) — evita um agente comprometido/enganado "des-privatizar" em massa. `NotePatch` (`queries.ts:93-100`) ganha `private?: 1`.
- Nova tool `mark_private` (`src/mcp/tools/mark-private.ts`, registrada em `src/mcp/registry.ts` como tool de escrita — bloqueada pra escopo `read` pelo gate da 17): input `{ id }`, seta `private = 1` numa nota visível ao caller. Idempotente. Sem contraparte `unmark`.
- **Sem re-embed**: mudar `private` não muda tldr/domains/kind — nenhuma chamada Workers AI/Vectorize.

### 5. Web (sessão do dono): badge, toggle e curadoria retroativa

- **Badge**: lista de notas (`src/web/notes.ts:55-73`) e detalhe (`notes.ts:208-215`) ganham `private` no SELECT e um badge `🔒 privada` (mesmo padrão do `kind-badge`).
- **Toggle**: no detalhe da nota, botão "Tornar privada / Tornar pública" → nova rota `POST /app/notes/{id}/private` (body `{ private: boolean }`), protegida por `requireSession` APENAS (sem bearer, sem PAT — é o único lugar que desmarca). Registrar em `src/web/handler.ts` junto das rotas de notas.
- **Retroativo**: marcação em lote SOMENTE por curadoria manual do dono via esse toggle (ou seleção múltipla na lista, se trivial — senão fica pra iteração futura). **NENHUMA heurística automática** de detecção de conteúdo sensível.
- **Grafo**: `handleGraphData`/`handleGraphMeta` (`src/web/graph-data.ts:190,305`) continuam servindo TODAS as notas — são superfícies do dono (sessão ou `GRAPH_EXPORT_TOKEN`, que é o bearer do console pessoal; decisão registrada aqui). `GraphNode` e `NoteMetaRow` ganham `private: boolean` pro client renderizar o badge/anel visual. Bump do `CACHE_KEY` pra `graph:v8` (`graph-data.ts:43`) pra invalidar o payload sem o campo.

### 6. Cross-check com specs vizinhas (registrar, não implementar)

- Spec `30-features/33` (compartilhamento público): share token NUNCA pode expor nota `private` — adicionar critério de aceite lá apontando pra cá.
- **Tasks**: a coluna `private` passa a existir nas tasks (mesma tabela `notes`), mas os read paths de TASK (`list_tasks`/`list_tasks_due_today`/`get_task`/share `/s/<token>`) NÃO são gateados aqui — spec `50-console-v2/59` (depende desta) fecha essas superfícies e bloqueia share de task privada.
- `similar_edges` (`src/db/migrate.ts:117-125`) pode conter pares envolvendo nota privada — só é lida pelo grafo (superfície do dono, item 5), então não vaza via MCP. Se um dia `expand` passar a usar similar edges, o filtro do item 3 se aplica.

## Fora de escopo

- Criptografia at-rest (D1 já cifra em repouso; o selo é controle de ACESSO, não cripto).
- Extensão ao expert-contacts — spec `50-console-v2/61` (entidade/evento privados no contacts, escopo propagado pelo Brain).
- Read paths de TASK — spec `50-console-v2/59` (ver cross-check acima).
- Compartilhamento público / share token (spec `30-features/33` — só o cross-check acima).
- Heurística automática de detecção de conteúdo sensível (retroativo é 100% curadoria manual).
- Metadata `private` no Vectorize / filtro no lado do vetor (D1 é a fonte de verdade única).
- Escopo `private` no fluxo OAuth de terceiros (sessão OAuth do dono = vê tudo, como hoje).
- UI/relatório de auditoria de quem marcou/desmarcou.

## Critérios de aceite

- [x] Migração `0013_private_notes` aplicada; todas as notas existentes seguem com `private = 0` e comportamento idêntico ao atual (zero linha alterada além do DEFAULT).
- [x] PAT **sem** escopo `private` (incluindo `full`): `recall` (com e sem `domains_filter`), `get_note`, `expand` (base e vizinhos), `stats` e o caminho FTS não retornam nem contam nenhuma nota `private = 1`; `get_note`/`expand` numa nota privada devolvem o mesmo erro de nota inexistente.
- [x] PAT **com** escopo `private` (`full,private` ou `read,private`) e sessão OAuth do dono: veem notas privadas em todos esses paths; `stats` inclui `private_notes`.
- [x] `save_note` com `private: true` grava `private = 1`; `update_note` com `private: true` marca; `update_note` com `private: false` retorna erro orientando pra UI.
- [x] `mark_private` marca nota visível ao caller, é idempotente e não existe tool de desmarcar.
- [x] Web logado: lista e detalhe mostram badge de privada; toggle em `POST /app/notes/{id}/private` funciona nos dois sentidos e é a ÚNICA superfície que desmarca; rota recusa request sem sessão (PAT/bearer → 401/redirect).
- [x] Grafo (`/app/graph/data` e `/app/graph/meta`) segue completo pra sessão e `GRAPH_EXPORT_TOKEN`, com campo `private` nos nós/meta; `CACHE_KEY` bumpado (`graph:v11`).
- [x] Marcar/desmarcar `private` não dispara embed nem `refreshSimilarEdges`.
- [x] Suíte `test/tools/private.test.ts` cobre vazamento em TODOS os read paths (um teste por superfície) e passa.
- [x] `npm run typecheck` e `npm test` verdes.

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck        # tsc --noEmit (worker + client)
npm test                 # vitest run && vitest run --config vitest.auth.config.ts
```

Testes novos (`test/tools/private.test.ts`):
- Seed: 2 notas públicas + 1 privada, com edge explícita pública↔privada e match FTS nas três.
- Por superfície, com caller sem escopo: `recall` (query que casa a privada), `recall` com `domains_filter` do domínio da privada, `ftsSearch`, `get_note(idPrivada)` → not found, `expand(idPública)` → vizinho privado ausente, `expand(idPrivada)` → not found, `stats` → contagens excluem a privada.
- Mesmas chamadas com caller `full,private` → tudo visível.
- `update_note({ private: false })` → erro; `mark_private` idempotente.
- `hasScope`: `'full'` não contém `private`; `'read,private'` contém.

Teste manual (`wrangler dev` + preview) — **gate de release**: rodar o roteiro de vazamento acima com um cliente MCP real usando (a) PAT sem escopo e (b) PAT com escopo, ANTES de qualquer release; depois validação manual do dono no vault real (marcar 1 nota de teste, conferir os dois lados, desmarcar pela UI). **Deploy em produção SOMENTE com OK explícito do dono do vault.**

## Arquivos afetados

- `src/db/migrate.ts` — migração `0009_private_notes` (coluna + índice parcial)
- `src/db/migrations/0005_private_notes.sql` — espelho SQL (novo)
- `src/db/queries.ts` — `PUBLIC_ONLY_FILTER`; `includePrivate` em `getNoteById`/`ftsSearch`/`getEdgesFrom`/`getEdgesTo`; `private` em `insertNote`/`NotePatch`/`updateNote`
- `src/auth/api-keys.ts` — helper `hasScope` (scopes vira CSV)
- `src/mcp/registry.ts` — repasse de `auth` às tools de leitura + registro do `mark_private`
- `src/mcp/tools/recall.ts` — filtro nos 3 pontos (pool de domínio, hidratação, FTS)
- `src/mcp/tools/get-note.ts` — `canSeePrivate` no `getNoteById`
- `src/mcp/tools/expand.ts` — base + vizinhos filtrados
- `src/mcp/tools/stats.ts` — contagens por escopo + `private_notes`
- `src/mcp/tools/save-note.ts` — campo `private`
- `src/mcp/tools/update-note.ts` — `private: true` (false → erro)
- `src/mcp/tools/mark-private.ts` — tool one-way (novo)
- `src/web/notes.ts` — badge na lista/detalhe + botão toggle
- `src/web/handler.ts` — rota `POST /app/notes/{id}/private`
- `src/web/search.ts` — `includePrivate: true` (sessão do dono)
- `src/web/graph-data.ts` — campo `private` em `GraphNode`/`NoteMetaRow` + bump `CACHE_KEY`
- `src/web/config.ts` — checkbox de escopo `private` no form de PAT
- `test/tools/private.test.ts` — suíte de vazamento (novo)

## Riscos e reversão

- **Risco: um read path esquecido vaza nota privada.** Mitigação: a suíte por-superfície é critério de aceite; qualquer read path novo no futuro deve nascer com teste equivalente (mesma disciplina do soft-delete).
- **Risco: recall devolve menos resultados pra caller sem escopo** quando muitos matches do top-30 do Vectorize são privados. Aceito nesta spec (degradação de recall, nunca de confidencialidade); se incomodar, iteração futura aumenta o `topK` da query quando o caller não vê privadas.
- **Risco: agente com PAT `full` sem `private` cria nota privada que ele mesmo não relê.** Comportamento intencional (one-way, fail-safe) — documentado na description das tools.
- **Rollback:** `wrangler rollback` (ou redeploy do commit anterior). A coluna `private` e o índice são inofensivos pro código antigo (SELECTs não a referenciam, INSERTs antigos caem no DEFAULT 0) — **não reverter a migração** (`_migrations` já a marca aplicada). Efeito colateral do rollback: notas já marcadas voltam a ficar visíveis a qualquer credencial (código antigo não filtra) — se houver nota sensível marcada, avisar o dono ANTES do rollback.
