# Contacts: dedupe por phoneVariants no upsert, proveniência preservada e canon único (CONN_TYPES/categorias/kinds)

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-contacts
> **Depende de:** 40-ops/42-contacts-testes-typecheck-ci.md (gate: cobertura de teste do upsert antes ou junto desta spec)

> **Nota de execução:** todos os 9 itens do Design implementados e testados (98 testes verdes, os 2 sentinelas `it.fails` promovidos a `it`). Decisão registrada no item 3/§4: `category: ""` — a spec descreve DUAS opções ("normalizar ''→null OU rejeitar"); segui o Design proposto §4 (normalizar `""`→`null`, COALESCE preserva a categoria existente), NÃO o rejeitar-com-400 que o texto do sentinela original supunha. O teste ex-sentinela foi reescrito pra provar a preservação. Item 6: o `SELECT DISTINCT kind FROM events` em produção (checar kind legado fora do canon antes de ativar a validação) e o deploy são owner-gated — PENDENTES de OK do dono. Índice 0004 (media dedup) entregue via spec 40-ops/44 (array `MIGRATIONS` + `.sql` espelho).

## Contexto

O `expert-contacts` é um Worker Cloudflare (D1 + Vectorize + Workers AI + R2) que mantém o grafo de contatos (entidades `person | company | group | place | event | other`, arestas em `connections`, log em `events`, arquivos em `media`). Três superfícies escrevem/leem o mesmo banco:

- **Worker (API REST)** — `src/index.ts`. Upsert em `handleSaveEntity` (src/index.ts:200-292), arestas em `handleConnect` (src/index.ts:414-443), eventos em `handleEvent` (src/index.ts:445-464), mídia em `handleAttachMedia` (src/index.ts:466-502), listagem em `handleListEntities` (src/index.ts:518-544), reembed em `handleReembedAll` (src/index.ts:577-604). Cron de manutenção que enriquece contatos a partir do CRM em `handleMaintenanceSync` (src/index.ts:627-668).
- **Console (front in-process)** — `src/vaults/contacts.ts`, adapter que roda dentro do mesmo Worker; cria arestas via `createLink` (src/vaults/contacts.ts:505-535).
- **MCP standalone (stdio)** — `mcp/index.js`, processo Node separado que fala HTTP com o Worker. Tem cópia própria dos enums nos `inputSchema` das tools.

Normalização de telefone BR (com/sem 9º dígito) já existe e funciona: `phoneVariants` (src/index.ts:89-103), usada pelo lookup determinístico `handleContactByPhone` (src/index.ts:399-412) e pelo cron (src/index.ts:650-653).

Enums canônicos hoje: `CONN_TYPES` (src/index.ts:36-45), `ENTITY_KINDS` (src/index.ts:47), `CONTACT_CATEGORIES` (src/index.ts:52-55).

Schema relevante: `migrations/0001_initial_schema.sql` criou `events.kind` com `CHECK(kind IN ('met','talked','saw_post','recommended','birthday_reminder','note','mentioned_in_brain'))`; a `migrations/0002_entities.sql` recriou a tabela como `events_v2` com `kind TEXT NOT NULL` **sem o CHECK** (0002:45-56). `connections` tem `UNIQUE(a_id, b_id, type)` (0002:34).

O repo não tem suíte de testes nem script `typecheck` (`package.json` só tem build/deploy/dev) — por isso o gate com a spec 40-ops/42.

## Problema / Motivação

Nove defeitos concretos no caminho de escrita, todos verificados no código:

1. **Dedupe do upsert NÃO usa `phoneVariants` — duplicata garantida entre fontes.** `handleSaveEntity` resolve pessoa existente com match EXATO de phone: `SELECT id FROM entities WHERE phone = ?` (src/index.ts:221). O lookup (`/get_contact_by_phone`, src/index.ts:406-409) e o cron (src/index.ts:653) já usam `phoneVariants`. Resultado: contato salvo como `55DDXXXXXXXX` (sem 9º dígito) e novo save com `55DD9XXXXXXXX` cria SEGUNDA entidade da mesma pessoa. Crítico antes de qualquer import em massa por telefone.

2. **`source` sempre sobrescrito no UPDATE — proveniência corrompida.** `const source = body.source || "manual"` (src/index.ts:208) nunca é `null`, então o `source = COALESCE(?, source)` do UPDATE (src/index.ts:238, bind em :245) SEMPRE sobrescreve. Um contato com `source='pipedrive'` que recebe qualquer save sem `source` vira `'manual'`.

3. **`category` string vazia bypassa a validação e apaga categoria real.** `body.category != null ? String(body.category).trim().toLowerCase() : null` (src/index.ts:211) produz `""` quando o cliente manda `category: ""`. O `if (category && ...)` (src/index.ts:212) não valida string vazia (falsy), e o `category = COALESCE(?, category)` do UPDATE (src/index.ts:240, bind em :245) grava `""` por cima da categoria real (`""` não é NULL pro COALESCE).

4. **`CONN_TYPES` triplicado — drift garantido entre Worker, Console e MCP.** Três cópias divergíveis da mesma lista: src/index.ts:36-45, src/vaults/contacts.ts:40-45 e mcp/index.js:42-47. `CONTACT_CATEGORIES` também está duplicado como enum literal no MCP (mcp/index.js:67 e :99). Adicionar um tipo novo exige lembrar de 3 arquivos; esquecer 1 gera 400 numa superfície e sucesso na outra.

5. **Conexão simétrica duplicada.** `UNIQUE(a_id, b_id, type)` não impede a invertida: `connect(A, B, 'friend')` + `connect(B, A, 'friend')` cria 2 arestas da mesma relação. Vale pros tipos semétricos (`friend`, `family`, `partner_of`, `colleague`, `peer_tech`, `competitor_of`). Afeta `handleConnect` (src/index.ts:434-436) e `createLink` (src/vaults/contacts.ts:525-527).

6. **`/event` aceita qualquer `kind`.** `handleEvent` não valida `body.kind` (src/index.ts:449) e o CHECK do schema foi dropado na migration 0002. Typo (`talkd`) entra no banco silenciosamente e o evento nunca dispara `last_contacted` (src/index.ts:460).

7. **`attach_media` deduplica no R2 mas duplica linhas no D1.** O R2 checa `head(r2Key)` antes do put (src/index.ts:489-490), mas o `INSERT INTO media` roda SEMPRE (src/index.ts:492-496). Reenviar o mesmo arquivo pro mesmo contato cria N linhas de mídia idênticas em `/entities/:id/media`.

8. **`parseInt` sem guarda vira 500.** `GET /list_entities?limit=abc` → `parseInt("abc")` = `NaN` → `Math.min(NaN, 1000)` = `NaN` → bind de `NaN` no D1 → 500 (src/index.ts:526-527). Mesmo padrão em `handleReembedAll` (src/index.ts:580-581) e no `limit` de `handleRecall` (src/index.ts:337).

9. **MCP standalone defasado.** `save_company` não expõe `category` (mcp/index.js:76-88, o Worker aceita); nenhum dos dois saves expõe `attributes` (o Worker aceita, src/index.ts:209); não existe tool `list_entities`; e a versão está dessincronizada (`Server` declara `0.2.0` em mcp/index.js:196, `mcp/package.json` diz `0.1.0`).

## Objetivo

Nenhuma escrita cria duplicata nem corrompe campo existente (`phone` com/sem 9º dígito resolve pra mesma entidade; `source` e `category` só mudam quando enviados válidos), e todos os enums (`CONN_TYPES`, `ENTITY_KINDS`, `CONTACT_CATEGORIES`, `EVENT_KINDS`) passam a ter UMA fonte (`src/canon.ts`) consumida pelas três superfícies — comprovado por testes automatizados do upsert.

## Design proposto

### 1. `src/canon.ts` — fonte única dos enums (novo arquivo)

Extrair de `src/index.ts` pra um módulo sem dependências (importável por Worker e Console, e serializável pro MCP):

```ts
// src/canon.ts — fonte ÚNICA dos enums do vault de contatos.
// Worker (index.ts) e Console (vaults/contacts.ts) importam daqui.
// O MCP standalone consome via GET /canon (ver rota abaixo).

export const CONN_TYPES = [
  // pessoa ↔ pessoa
  "family", "friend", "colleague", "client", "mentor", "alum_g4", "peer_tech", "introduced_by",
  // pessoa ↔ empresa
  "works_at", "founded", "advisor_of", "studied_at", "member_of",
  // empresa ↔ empresa
  "partner_of", "supplier_of", "competitor_of", "parent_of", "subsidiary_of",
  // genérico / ambos
  "invested_in", "client_of", "other",
] as const;

// Tipos SIMÉTRICOS: a relação não tem direção (A friend B == B friend A).
export const SYMMETRIC_CONN_TYPES = [
  "family", "friend", "colleague", "peer_tech", "partner_of", "competitor_of",
] as const;

export const ENTITY_KINDS = ["person", "company", "group", "place", "event", "other"] as const;

export const CONTACT_CATEGORIES = [
  "cliente", "lead", "lead-perdido", "aluno", "parceiro", "fornecedor",
  "equipe", "familia", "pessoal", "network", "outro",
] as const;

// Espelha o CHECK original da migration 0001 (dropado na 0002) — validação na app.
export const EVENT_KINDS = [
  "met", "talked", "saw_post", "recommended", "birthday_reminder", "note", "mentioned_in_brain",
] as const;

export const EVENT_SOURCES = ["manual", "whatsapp", "brain_bridge", "pipedrive"] as const;

// Sets pra validação O(1) nos handlers.
export const CONN_TYPES_SET = new Set<string>(CONN_TYPES);
export const SYMMETRIC_CONN_TYPES_SET = new Set<string>(SYMMETRIC_CONN_TYPES);
export const ENTITY_KINDS_SET = new Set<string>(ENTITY_KINDS);
export const CONTACT_CATEGORIES_SET = new Set<string>(CONTACT_CATEGORIES);
export const EVENT_KINDS_SET = new Set<string>(EVENT_KINDS);
```

- Em `src/index.ts`: remover as definições locais (linhas 36-55) e importar de `./canon`.
- Em `src/vaults/contacts.ts`: remover a cópia (linhas 40-45) e importar de `../canon` (o comentário "espelha CONN_TYPES do index.ts" morre junto).
- Nova rota **`GET /canon`** no Worker (auth normal; `CONTACTS_PROXY_TOKEN` read-only já cobre GET, src/index.ts:76): retorna `{ ok: true, conn_types, symmetric_conn_types, entity_kinds, contact_categories, event_kinds, event_sources }`. É o mecanismo pro MCP standalone (processo Node separado, não importa TS do Worker) não driftar: nesta spec o MCP mantém as listas inline mas ganha um comentário apontando `GET /canon` como fonte + um teste (spec 42) que compara as listas do `mcp/index.js` com `src/canon.ts` e falha o CI em drift. (Alternativa descartada: gerar `mcp/canon.gen.js` no build — mais moving parts sem CI ainda existente.)

### 2. Dedupe do upsert por `phoneVariants` (src/index.ts:221)

Substituir o match exato por match em variantes, com ORDER BY que prioriza o match exato (mesma técnica de `handleContactByPhone`, src/index.ts:406-409):

```ts
} else if (kind === "person" && phone) {
  const variants = phoneVariants(phone);
  const list = variants.length ? variants : [phone];
  const ph = list.map(() => "?").join(",");
  existing = await env.DB.prepare(
    `SELECT id FROM entities WHERE phone IN (${ph}) ORDER BY (phone = ?) DESC LIMIT 1`
  ).bind(...list, phone).first<{ id: string }>();
}
```

Comportamento: se existir a entidade com o número EXATO, ela ganha; senão, qualquer variante (com/sem 9º dígito) resolve pra entidade existente em vez de criar duplicata. O UPDATE mantém `phone = COALESCE(?, phone)` — o formato já salvo NÃO é sobrescrito pelo formato novo (decisão: preservar o dado existente; normalização retroativa de formato é curadoria, fora de escopo).

### 3. `source` preserva proveniência (src/index.ts:208, :245)

- Trocar `const source = body.source || "manual"` por `const source = body.source ?? null` (e rejeitar string vazia: `body.source?.trim() || null`).
- No **UPDATE**: bindar esse valor possivelmente-null — o `COALESCE(?, source)` existente passa a não mexer quando o cliente não mandou `source`.
- No **INSERT**: bindar `source ?? "manual"` — o default `'manual'` vale SÓ na criação.

### 4. `category` vazia normalizada pra `null` ANTES da validação (src/index.ts:211-213)

```ts
const category = body.category != null
  ? (String(body.category).trim().toLowerCase() || null)   // "" → null
  : null;
if (category && !CONTACT_CATEGORIES_SET.has(category)) {
  return err(400, `invalid category: ${category}`, { allowed: [...CONTACT_CATEGORIES] });
}
```

Com `category = null`, o `COALESCE(?, category)` do UPDATE preserva a categoria existente. Categoria inválida não-vazia continua 400 (comportamento atual mantido).

### 5. Conexão simétrica normalizada (src/index.ts:414-443 e src/vaults/contacts.ts:505-535)

Antes do INSERT, se `type ∈ SYMMETRIC_CONN_TYPES_SET`, ordenar o par lexicograficamente: `if (a > b) [a, b] = [b, a]`. Assim `connect(B, A, 'friend')` colide no `UNIQUE(a_id, b_id, type)` existente e devolve o 409 atual ("connection already exists"). Aplicar a MESMA normalização nos dois caminhos de escrita (`handleConnect` e `createLink`) — extrair um helper `normalizeConnPair(a, b, type)` (pode viver em `src/canon.ts` ou num `src/util/` — decisão do implementador, desde que seja UM lugar). Tipos direcionais (`works_at`, `introduced_by`, `parent_of`...) NÃO são normalizados. Arestas simétricas invertidas JÁ existentes no banco não são tocadas (limpeza é curadoria/merge, spec 30-features/34).

### 6. Validação de `kind` em `/event` (src/index.ts:449)

Após o parse do body: `if (!EVENT_KINDS_SET.has(body.kind)) return err(400, \`invalid kind: ${body.kind}\`, { allowed: [...EVENT_KINDS] })`. Restaura na app o CHECK que a migration 0002 dropou do schema. Validar também `body.source` contra `EVENT_SOURCES` quando enviado (o INSERT tem default `'manual'`, src/index.ts:457). Antes de ativar, rodar um `SELECT DISTINCT kind FROM events` em produção: se existir kind fora do canon (dado já gravado), adicionar ao `EVENT_KINDS` conscientemente ou deixar como está (a validação é só de escrita nova; leitura não quebra).

### 7. Dedup de mídia no D1 (src/index.ts:492-496)

Antes do `INSERT INTO media`, checar par (entidade, hash):

```ts
const dupRow = await env.DB.prepare(
  "SELECT id FROM media WHERE entity_id = ? AND content_hash = ? LIMIT 1"
).bind(entityId, hash).first<{ id: string }>();
if (dupRow) {
  // ainda honra set_as_avatar (idempotente) antes de retornar
  return json({ ok: true, id: dupRow.id, content_hash: hash, r2_key: r2Key, byte_size: bytes.length, deduped: true, url: `/media/${hash}` });
}
```

O campo `deduped` da resposta (hoje só reflete o R2, src/index.ts:501) passa a significar "linha já existia pra ESTA entidade". Mesmo arquivo em entidades DIFERENTES continua criando linhas (correto: a mídia pertence ao vínculo). Sem migration de UNIQUE — checagem na app, aditiva; índice opcional `CREATE INDEX IF NOT EXISTS idx_media_entity_hash ON media(entity_id, content_hash)` numa migration nova `0004_media_dedup_index.sql` (aditiva, não quebra nada).

### 8. `parseIntSafe` com clamp

Helper único (junto dos helpers em src/index.ts:57-67):

```ts
function parseIntSafe(v: string | null, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = parseInt(v ?? "", 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(n, max));
}
```

Aplicar em: `handleListEntities` (`limit` def 500 max 1000, `offset` def 0 — src/index.ts:526-527), `handleReembedAll` (`offset` def 0, `limit` def 30 max 50 — src/index.ts:580-581) e `handleRecall` (`limit` def 10 max 50 — src/index.ts:337). `?limit=abc` passa a usar o default em vez de 500.

### 9. MCP standalone atualizado (mcp/index.js)

- `save_company`: adicionar `category` (mesmo enum de `save_person`, mcp/index.js:67) ao inputSchema.
- `save_person` e `save_company`: adicionar `attributes` (`type: "object"`, descrição "JSON livre de extras por kind") — o Worker já aceita (src/index.ts:209).
- Nova tool `list_entities` → `GET /list_entities` com `kind`, `category`, `has_phone`, `include_raw`, `limit`, `offset` (espelha src/index.ts:518-544).
- Comentário no topo das listas de enum apontando `GET /canon` como fonte canônica.
- Sincronizar versão: `mcp/package.json` e o construtor `Server` (mcp/index.js:196) ambos em `0.3.0`; bump do `User-Agent` (mcp/index.js:31).

### Gate de testes (dependência 40-ops/42)

Os bugs 2 e 3 passariam num teste de 5 linhas. Esta spec NÃO entra em produção sem os testes de upsert da spec 40-ops/42 cobrindo no mínimo: dedupe por variante de telefone, `source` preservado em update sem source, `category: ""` não sobrescreve, conexão simétrica invertida → 409, `/event` com kind inválido → 400, `attach_media` repetido → `deduped: true`, `?limit=abc` → 200 com default.

## Fora de escopo

- **Merge de entidades duplicadas já existentes** no banco (spec 30-features/34) — esta spec só impede duplicatas NOVAS.
- **Mudanças de schema** além do índice opcional do item 7 — nenhum CHECK volta pro DB, validação continua na app; nenhuma coluna alterada/removida.
- Normalização retroativa do formato de `phone` já salvo (o UPDATE continua preservando o valor existente).
- Limpeza de `events.kind` fora do canon já gravados.
- Geração de `canon` no build do MCP (fica o teste anti-drift da spec 42 + `GET /canon`).
- Qualquer mudança no front do Console (`src/web/`) além do import do canon no adapter.

## Critérios de aceite

- [ ] `POST /save_person` com `phone` variante (com/sem 9º dígito) de contato existente retorna `action: "updated"` no MESMO `id` — nenhuma entidade nova criada; match exato tem prioridade quando as duas variantes existem.
- [ ] `POST /save_person` de update SEM `source` no body preserva o `source` existente da entidade; INSERT sem `source` continua gravando `'manual'`.
- [ ] `POST /save_person` com `category: ""` (ou `"  "`) não altera a categoria existente; categoria inválida não-vazia continua retornando 400 com a lista `allowed`.
- [ ] `CONN_TYPES`, `ENTITY_KINDS`, `CONTACT_CATEGORIES` e `EVENT_KINDS` existem SÓ em `src/canon.ts`; `src/index.ts` e `src/vaults/contacts.ts` importam de lá (zero definição local remanescente).
- [ ] `GET /canon` retorna as 6 listas e responde com `CONTACTS_PROXY_TOKEN` (read-only).
- [ ] `POST /connect` com tipo simétrico invertido (`b,a` de uma aresta `a,b` existente) retorna 409; tipos direcionais continuam permitindo os dois sentidos; `createLink` do Console tem o mesmo comportamento.
- [ ] `POST /event` com `kind` fora de `EVENT_KINDS` retorna 400 com `allowed`; kinds válidos continuam funcionando e atualizando `last_contacted` quando aplicável.
- [ ] `POST /attach_media` repetido (mesma entidade, mesmo conteúdo) retorna `deduped: true` com o `id` da linha original e NÃO cria linha nova em `media`; mesmo conteúdo em OUTRA entidade cria linha normalmente.
- [ ] `GET /list_entities?limit=abc&offset=xyz` e `POST /setup/reembed?offset=abc` retornam 200 com defaults (nunca 500 por NaN).
- [ ] MCP: `save_company` aceita `category`; ambos os saves aceitam `attributes`; tool `list_entities` disponível; `mcp/package.json` e `Server` na mesma versão.
- [ ] Testes da spec 40-ops/42 cobrindo os cenários do gate passam todos.
- [ ] Nenhuma linha existente de `entities`, `connections`, `events` ou `media` é modificada ou apagada pelo deploy (mudança 100% de código + 1 índice aditivo opcional).

## Validação

```sh
# no repo expert-contacts
npx tsc --noEmit                      # typecheck (adicionar script "typecheck" se a spec 42 ainda não adicionou)
npx vitest run                        # suíte da spec 40-ops/42 (gate obrigatório)
npx wrangler dev                      # smoke local
```

Teste manual (local, `wrangler dev`, com `OWNER_TOKEN` de dev):

```sh
# 1. dedupe por variante
curl -sX POST localhost:8787/save_person -H "Authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"name":"Teste Nono Digito","phone":"5511987654321","source":"pipedrive","category":"network"}'
curl -sX POST localhost:8787/save_person -H "Authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"name":"Teste Nono Digito","phone":"551187654321"}'
# esperado: mesmo id, action=updated; GET /entities/:id mostra source=pipedrive e category=network intactos

# 2. category vazia e event kind inválido
curl -sX POST localhost:8787/save_person ... -d '{"name":"Teste Nono Digito","phone":"5511987654321","category":""}'
curl -sX POST localhost:8787/event ... -d '{"entity_id":"<id>","kind":"typo_qualquer"}'   # → 400

# 3. NaN
curl -s "localhost:8787/list_entities?limit=abc" -H "Authorization: Bearer $T"            # → 200
```

Antes do deploy: `SELECT DISTINCT kind FROM events` em produção (via `wrangler d1 execute`) pra conferir se há kind legado fora do canon (item 6). **Deploy (`npm run deploy`) SÓ com OK explícito do dono do repo.** Pós-deploy: `GET /health` + repetir o teste 1 contra produção com um contato descartável.

## Arquivos afetados

- `src/canon.ts` (novo) — enums canônicos + `SYMMETRIC_CONN_TYPES` + helper de par simétrico
- `src/index.ts` — imports do canon; `handleSaveEntity` (dedupe variants, source, category); `handleConnect` (par simétrico); `handleEvent` (validação kind/source); `handleAttachMedia` (dedup D1); `parseIntSafe` em `handleListEntities`/`handleReembedAll`/`handleRecall`; rota `GET /canon`
- `src/vaults/contacts.ts` — remove cópia de `CONN_TYPES`, importa canon; `createLink` normaliza par simétrico
- `mcp/index.js` — `category` no save_company, `attributes` nos dois saves, tool `list_entities`, versão sincronizada, comentário apontando `GET /canon`
- `mcp/package.json` — bump de versão
- `migrations/0004_media_dedup_index.sql` (novo, opcional) — índice aditivo `(entity_id, content_hash)`
- `test/` (novo, via spec 40-ops/42) — testes de upsert/connect/event/media/parseIntSafe

## Riscos e reversão

**Riscos:**
- *Falso-positivo do dedupe por variante:* dois contatos legitimamente distintos cujos números diferem só pelo 9º dígito seriam fundidos no save. Probabilidade baixíssima (a variante sem 9 é o MESMO celular em formato antigo), e o lookup/cron já operam com essa premissa há tempo — o upsert só fica consistente com o resto.
- *Kind legado em `events`:* se produção tiver kind fora do canon, clientes que reenviam esse kind passam a tomar 400 — mitigado pelo `SELECT DISTINCT` pré-deploy.
- *Consumidor que dependia do bug do `source`* (usar update pra "resetar" source pra manual): passa a precisar mandar `source: "manual"` explícito. Comportamento novo é o correto; documentar no README.

**Reversão:** mudança é 100% stateless no Worker — rollback é `wrangler rollback` (ou redeploy do commit anterior; manter tag `pre-spec-19` antes do deploy). A migration 0004 é só um índice: reverter com `DROP INDEX idx_media_entity_hash` sem perda de dados. Nenhum dado é transformado no deploy, então não existe "rollback de dados" a fazer; entidades deduplicadas corretamente após o fix permanecem válidas mesmo com o código revertido.
