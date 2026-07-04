# Contacts: cartela completa de contato — múltiplos e-mails, redes sociais, link de CRM e ManyChat

> **Status:** ready · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-contacts
> **Depende de:** nenhuma bloqueante. Coordenação: `10-backend/19` (write-path/canon, draft) toca `handleSaveEntity` — se executarem próximas, sequenciar (19 antes) pra evitar conflito no mesmo arquivo.
> **Agente sugerido:** Opus (schema + contrato MCP)

## Contexto

Executa no working tree de `C:/repos/expert-contacts` (protocolo cross-repo da spec-zero, `specs/README.md` seção 6).

- A tabela `entities` tem `email` e `phone` SINGULARES — `phone` com `UNIQUE` (`src/db/migrate.ts:21-34`) — e campos de empresa (`website`, `sector`) da migration `0002` (`migrate.ts:95-98`). **Não há suporte a múltiplos e-mails/telefones nem a redes sociais**; o único lugar extensível é o JSON livre `attributes` (`migrate.ts:98`), sem estrutura nem validação.
- Fonte de verdade do schema: `src/db/migrate.ts` (array `MIGRATIONS`, última `0004_media_dedup_index`; DDL sempre aditiva — regra permanente em `migrate.ts:12-16`). NÃO usar `wrangler d1 migrations apply` (aviso em `migrations/README.md`). O número `0005` usado abaixo é INDICATIVO — a spec `10-backend/21` também cria migration no contacts; usar o próximo número livre na ordem real de execução (regra transversal na Fase 5 do `specs/90-roadmap.md`).
- Write-path: `handleSaveEntity` (`src/index.ts:142-231`) é idempotente por `phone` OU `id`; após INSERT/UPDATE chama `reembedEntity` (`src/entity-write.ts:128-149`) — texto do embedding em `src/embedding.ts:9-21` (name, role, company, sector, website, notes_text).
- Detalhe: `fetchEntity` (`src/vaults/contacts.ts:449-537`) retorna `fields[{label,value,href?}]`, `connections`, `events`, `img`, `editable`; edição via `POST /app/entity/update` (mesmo reembed compartilhado).
- MCP (`mcp/index.js` v0.3, 9 tools): `save_person` aceita `id, name, phone, email, role, company, birthday, last_contacted, source, notes_text, category, attributes` (`mcp/index.js:51-72`); `save_company` similar (`74-92`); `get_entity` → `GET /entities/:id` (`src/index.ts:233-257`).
- Lookup por telefone com tratamento de 9º dígito BR: `get_contact_by_phone` (`mcp/index.js:119-127`).

## Problema / Motivação

- Uma pessoa real tem 2+ e-mails, Instagram, LinkedIn, um card no CRM e às vezes um ID de plataforma de chat — hoje NADA disso tem lugar estruturado (`migrate.ts:21-34`); vai pro `attributes` sem validação, sem href, invisível na UI.
- O dono da instância quer a cartela completa: clicar no contato e ter TODOS os canais mapeados e clicáveis (wa.me, instagram.com/..., linkedin, link direto do card no CRM).
- `email` singular força escolher qual e-mail "vale" — perde-se o resto.

## Design proposto

### 1. Migration `0005_entity_channels` (aditiva, em `src/db/migrate.ts`)

```sql
CREATE TABLE IF NOT EXISTS entity_channels (
  id         TEXT PRIMARY KEY,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('email','phone','instagram','linkedin','crm','manychat','site','other')),
  value      TEXT NOT NULL,
  label      TEXT,                          -- ex.: "pessoal", "trabalho"
  is_primary INTEGER NOT NULL DEFAULT 0,
  position   INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (entity_id, kind, value)
);
CREATE INDEX IF NOT EXISTS idx_channels_entity ON entity_channels (entity_id);
CREATE INDEX IF NOT EXISTS idx_channels_kind_value ON entity_channels (kind, value);
```

Backfill na mesma migration: `INSERT OR IGNORE` de `entities.email` → canal `email` primário e `entities.phone` → canal `phone` primário (e `website` → canal `site` pra empresas).

### 2. Regra de espelho (compatibilidade total com dedupe/lookup)

As colunas `entities.email`/`entities.phone` NÃO morrem: passam a ser o **espelho do canal primário** daquele kind.

- Definir canal `email`/`phone` como primário → UPDATE na coluna espelhada (mesma transação). Remover o primário → promove o próximo (menor `position`) ou NULL.
- O `UNIQUE` de `entities.phone` e a idempotência por telefone do `handleSaveEntity` ficam INTACTOS.
- `get_contact_by_phone` ganha fallback: não achou na coluna → procura em `entity_channels` kind `phone` (com as mesmas `phoneVariants` de 9º dígito) — telefone secundário passa a resolver o contato.

### 3. Normalização e validação por kind (módulo novo `src/channels.ts`)

| kind | normalização | validação | href gerado |
|---|---|---|---|
| `email` | trim, lowercase | regex leve `x@y.z` | `mailto:<value>` |
| `phone` | só dígitos (E.164 sem `+`) | 8-15 dígitos | `https://wa.me/<value>` |
| `instagram` | strip `@` e URL → handle | `[a-z0-9._]{1,30}` | `https://instagram.com/<handle>` |
| `linkedin` | aceitar URL completa ou handle | URL https OU `[\w-]{3,100}` | URL como veio, ou `https://www.linkedin.com/in/<handle>` |
| `crm` | trim | URL http(s) válida | a própria URL (link do card no CRM do dono) |
| `manychat` | trim | ID livre ≤100 OU URL https | href só quando URL |
| `site` | trim | URL http(s) | a própria URL |
| `other` | trim | ≤200 chars | sem href |

Valores sempre ≤200 chars; `label` ≤40. Tudo validado no servidor (o MCP repassa).

### 4. Contrato de escrita (REST + MCP)

- `handleSaveEntity` aceita `channels: [{kind, value, label?, primary?}]` — upsert por `(entity_id, kind, value)`; NÃO remove canais ausentes (save parcial não destrói; remoção é explícita).
- **Atalhos** no `save_person`/`save_company` do MCP (viram `channels` no corpo): `emails: string[]`, `instagram`, `linkedin`, `crm_url`, `manychat_id`. Os params atuais `email`/`phone` continuam funcionando (viram canal primário via espelho). Descrições das tools atualizadas.
- Endpoint de remoção: `POST /app/entity/channel_delete { id }` (sessão) e aceitar `channels_remove: [id]` no update REST.
- **Embedding INALTERADO** (`src/embedding.ts:9-21`): sociais/URLs são ruído semântico — anotar isso em comentário no código.

### 5. Leitura e UI

- `fetchEntity` (`src/vaults/contacts.ts:449-537`): `fields[]` ganha os canais com `href` pronto (ordenados por kind/position, primário com selo); `editable` ganha `channels[]` cru.
- `GET /entities/:id` (`src/index.ts:233-257`): inclui `channels[]` — `get_entity` do MCP herda.
- Console (painel/página de detalhe): seção "Canais" com CRUD (adicionar por kind, editar label, marcar primário, remover) via `POST /app/entity/update` estendido — reusar o form pattern de edição existente.

## Fora de escopo

- Página própria do contato e conexões 1º/2º nível (`50-console-v2/56`).
- Timeline de interações (`50-console-v2/57`).
- Import/merge de duplicatas (`30-features/34`), sync com CRM externo (o campo `crm` é só o LINK; integração viva é outra spec).
- Mudança no texto de embedding.

## Critérios de aceite

- [ ] Migration + backfill: todo contato com `email`/`phone` preexistente tem os canais primários correspondentes; contagens batem (teste com fixture).
- [ ] Pessoa com 3 e-mails: os 3 aparecem no detalhe com `mailto:`; trocar o primário atualiza `entities.email` na mesma transação.
- [ ] `get_contact_by_phone` resolve por telefone SECUNDÁRIO (canal), incluindo variante de 9º dígito.
- [ ] `save_person` com `emails/instagram/linkedin/crm_url/manychat_id` cria os canais; chamadas antigas (só `email`/`phone`) seguem funcionando idênticas.
- [ ] Instagram salvo como `@Fulano` ou URL completa normaliza pro mesmo handle; href abre o perfil.
- [ ] Valor inválido (email sem `@`, crm sem https) → erro claro, nada persiste.
- [ ] `attributes` JSON continua aceito e intocado (compat).
- [ ] Save parcial NÃO apaga canais existentes; remoção só pelo endpoint explícito.

## Validação

- `npx tsc --noEmit` + `npm test` (suíte vitest do contacts, 109+ testes) verdes; testes novos: normalização/validação por kind (tabela acima), espelho primário↔coluna, lookup por canal, upsert idempotente, backfill.
- Manual (`wrangler dev`): criar pessoa com todos os kinds, editar pela UI, conferir hrefs.
- **Gate de deploy:** `wrangler deploy` só com OK explícito do dono da instância.

## Arquivos afetados (todos em `C:/repos/expert-contacts`)

- `src/db/migrate.ts` (0005 + backfill), `src/channels.ts` (novo)
- `src/index.ts` (`handleSaveEntity`, `handleGetEntity`, `get_contact_by_phone`, endpoint remoção)
- `src/vaults/contacts.ts` (`fetchEntity` fields/editable), `src/web/*` (form de canais no console)
- `mcp/index.js` (params novos + descrições)
- `test/` (suites acima) — e update de status desta spec no repo expert-brain

## Riscos e reversão

- **Risco**: espelho primário↔coluna divergir (escrita fora da transação). Mitigação: única função `setPrimaryChannel` transacional; teste de invariante.
- **Risco**: colisão de telefone secundário com `UNIQUE` do primário de OUTRA entidade ao promover. Mitigação: promover valida contra `entities.phone` e falha com mensagem (dedupe/merge é a spec 34).
- **Reversão**: revert do código; tabela `entity_channels` fica inerte (aditiva). Colunas espelhadas continuam válidas — comportamento volta ao atual sem perda.
