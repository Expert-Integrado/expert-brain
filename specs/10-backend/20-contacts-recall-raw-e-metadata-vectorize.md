# Contacts: recall não pode voltar vazio por imports crus + metadata Vectorize consistente

> **Status:** done · **Prioridade:** P1 · **Esforço:** S · **Repo:** expert-contacts
> **Depende de:** 40-ops/42-contacts-testes-typecheck-ci.md (infra de vitest + typecheck — os testes desta spec rodam sobre ela)

> **Nota de execução:** passos 1 (over-fetch `!includeRaw`), 2 (`vectorMetadataFor` centralizada nos 3 caminhos, com `raw`+`category`) e 4 (filtro de crus no `contactsMeta`) IMPLEMENTADOS e testados. O passo 3 (índices de metadata do Vectorize `raw`/`kind`/`category` + troca pro `filter` nativo na query + reembed total dos ~7,6k vetores) fica PENDENTE de OK do dono: exige `wrangler vectorize create-metadata-index` (efeito em produção) + reembed que consome quota. Até lá o pós-filtro em memória (linha ~371) permanece como está (defesa em profundidade). Deploy do Worker também é owner-gated.

## Contexto

O Worker `expert-contacts` (Cloudflare D1 + Workers AI `@cf/baai/bge-m3` + Vectorize) guarda o grafo de contatos como entidades (`kind = person | company | ...`). Do total de ~7,6k entidades, ~5,7k são **imports crus**: contatos cujo `name` é só um número de telefone, sem nenhuma letra. Por convenção do código, cru = `name` que NÃO casa `/[A-Za-z]/` (helper `hasLetter`, `src/index.ts:342`; equivalente SQL `name GLOB '*[A-Za-z]*'` negado).

Caminhos relevantes hoje:

- **Recall semântico** — `handleRecall` em `src/index.ts:335-395`. Consulta o Vectorize, hidrata do D1 e aplica 3 pós-filtros em memória: `kind` (linha 369), `category` (linha 370) e o filtro de crus `!includeRaw → hasLetter(r.name)` (linha 371).
- **Over-fetch** — `src/index.ts:350`: `topK = (kindFilter || categoryFilter) ? Math.min(50, limit * 4) : limit`. Só `kind`/`category` acionam o over-fetch; o filtro de crus não.
- **Escrita de vetor (3 caminhos)** com metadata divergente:
  1. `handleSaveEntity` → `upsertVectorize` em `src/index.ts:270`: metadata `{ name, kind, source, category, text }` (tem `category`, não tem flag de cru).
  2. `handleReembedAll` (rota `POST /setup/reembed`) em `src/index.ts:595`: metadata `{ name, kind, source, text }` — **sem `category`**; o SELECT da página (linha 586) nem traz a coluna.
  3. `reembedEntity` (usado pelo cron de manutenção quando `company` muda) em `src/index.ts:624`: metadata `{ name, kind, source, text }` — **sem `category`**; o SELECT (linhas 618-620) nem traz a coluna.
- **Command palette do Console** — `contactsMeta` em `src/vaults/contacts.ts:207-217` lista `(id, name)` com `ORDER BY last_contacted DESC LIMIT 2000` (`META_LIST_LIMIT`, `src/vaults/contacts.ts:37`), sem filtro de crus.

A coluna `category` é nativa e indexada no D1 desde `migrations/0003_category.sql` (linhas 14-15). O índice Vectorize é `expert-contacts-vec` (`wrangler.toml`, bloco `[[vectorize]]`).

## Problema / Motivação

1. **`recall-raw-filter-sem-overfetch`** — o filtro de crus é pós-fetch (`src/index.ts:371`) mas NÃO entra na condição de over-fetch (`src/index.ts:350`). Sem `kind`/`category`, a query pede `topK = limit` (ex.: 10). Com ~75% do índice composto de crus, os 10 vizinhos mais próximos podem ser todos crus → o pós-filtro derruba tudo e o recall devolve `count: 0` mesmo existindo contatos nomeados relevantes.
2. **`reembed-perde-category-metadata`** — qualquer passada de `/setup/reembed` (`src/index.ts:595`) ou do `reembedEntity` do cron (`src/index.ts:624`) reescreve o vetor com metadata SEM `category`, apagando o que o save gravou (`src/index.ts:270`). Consequência: o filtro nativo por `category` no Vectorize fica impossível de adotar com segurança, e a metadata do índice diverge do D1 dependendo de qual caminho escreveu por último.
3. **`palette-corta-5k-contatos`** — `contactsMeta` (`src/vaults/contacts.ts:210-212`) devolve os 2000 mais recentes sem excluir crus. Com ~7,6k entidades, ~5,5k contatos nunca aparecem na busca do palette, sem nenhuma indicação de truncamento. Filtrando crus, a lista cai pra ~1,9k nomeados e cabe inteira no `META_LIST_LIMIT` de 2000.

## Objetivo

`recall` com `limit=10` sobre um banco majoritariamente cru devolve os contatos nomeados relevantes (nunca `0` por causa de crus no topK), e os 3 caminhos de escrita de vetor gravam exatamente a mesma metadata (incluindo `category` e flag `raw`).

## Design proposto

### 1. Curto prazo — incluir `!includeRaw` no over-fetch (`src/index.ts:350`)

```ts
// antes
const topK = (kindFilter || categoryFilter) ? Math.min(50, limit * 4) : limit;
// depois
const topK = (kindFilter || categoryFilter || !includeRaw) ? Math.min(50, limit * 4) : limit;
```

Como `includeRaw` é `false` por padrão, na prática o recall passa a sempre over-fetchar. Mitiga, não elimina: com 75% de crus, até 50 vizinhos podem ser insuficientes em regiões densas de crus — por isso o passo 3.

### 2. Centralizar metadata do vetor — `vectorMetadataFor(e)`

Criar UMA função em `src/index.ts` e usá-la nos 3 caminhos de escrita:

```ts
// Metadata canônica do vetor no Vectorize. Usada por handleSaveEntity,
// handleReembedAll e reembedEntity — NUNCA montar metadata inline.
function vectorMetadataFor(e: {
  name: string; kind: string; source?: string | null;
  category?: string | null;
}, text: string): Record<string, any> {
  return {
    name: e.name,
    kind: e.kind,
    source: e.source ?? null,
    category: e.category ?? null,
    raw: !/[A-Za-z]/.test(e.name || ""),   // import cru = nome sem letra
    text: text.slice(0, 500),
  };
}
```

Ajustes por caminho:
- `handleSaveEntity` (`src/index.ts:270`): trocar o objeto inline por `vectorMetadataFor(...)`. O SELECT da linha 262-264 já traz `category`; adicionar `kind`/`source` ao SELECT ou passar as variáveis locais já disponíveis.
- `handleReembedAll` (`src/index.ts:586` e `:595`): incluir `category` no SELECT da página e usar `vectorMetadataFor(e, text)` no batch.
- `reembedEntity` (`src/index.ts:618-624`): incluir `category` no SELECT e usar `vectorMetadataFor(e, text)`.

### 3. Estrutural — filtro nativo do Vectorize (elimina a classe do problema)

1. Criar índices de metadata no Vectorize (operação aditiva, não mexe nos vetores existentes):
   ```sh
   npx wrangler vectorize create-metadata-index expert-contacts-vec --property-name=raw --type=boolean
   npx wrangler vectorize create-metadata-index expert-contacts-vec --property-name=kind --type=string
   npx wrangler vectorize create-metadata-index expert-contacts-vec --property-name=category --type=string
   ```
2. Em `handleRecall`, quando o índice estiver populado (pós-reembed), migrar do pós-filtro pro `filter` nativo:
   ```ts
   const filter: Record<string, any> = {};
   if (!includeRaw) filter.raw = false;
   if (kindFilter) filter.kind = kindFilter;
   if (categoryFilter) filter.category = categoryFilter;
   queryRes = await env.VECTORIZE.query(vec, {
     topK: limit, returnMetadata: true,
     ...(Object.keys(filter).length ? { filter } : {}),
   });
   ```
   Com filter nativo, `topK = limit` volta a bastar (o over-fetch do passo 1 vira redundância inofensiva e pode ser removido nessa hora).
3. **Atenção Vectorize:** índice de metadata só filtra vetores upsertados DEPOIS da criação do índice — exige um reembed total (`POST /setup/reembed` paginado por `offset`/`limit`, `src/index.ts:577-604`) pra repopular a metadata. Ver "Fora de escopo": esse reembed total só roda com OK do dono. Até lá, manter o pós-filtro da linha 371 como está (defesa em profundidade — pode inclusive ficar permanente, é barato).

### 4. Command palette — filtrar crus no `contactsMeta` (`src/vaults/contacts.ts:210-212`)

```ts
const rows = await env.DB.prepare(
  `SELECT id, name FROM entities
    WHERE name GLOB '*[A-Za-z]*'
    ORDER BY last_contacted DESC LIMIT ${META_LIST_LIMIT}`
).all<{ id: string; name: string }>();
```

Os counts totais (`entities`/`connections`) continuam SEM filtro — são estatística do vault, não lista de busca.

**Nenhuma migration de D1 é necessária** — `category` já existe (0003) e a flag `raw` é derivada de `name`, não persistida no D1. Nada é destruído: índices de metadata do Vectorize são aditivos e o upsert de vetor já é a operação normal do sistema.

## Fora de escopo

- **Reembed total imediato dos ~7,6k vetores** — custa quota de Workers AI + Vectorize. Rodar SOMENTE quando a migração pro filter nativo (passo 3.2) for ativada, com OK explícito do dono. Os passos 1, 2 e 4 entregam valor sem reembed nenhum.
- **UI do palette** (indicador de truncamento, toggle "mostrar crus") — só a query do `contactsMeta`.
- Deduplicação/curadoria dos imports crus em si (é outra frente).
- Mudanças no fallback SQL do recall (`src/index.ts:376-394`) — já filtra crus corretamente via `GLOB`.

## Critérios de aceite

- [ ] `src/index.ts:350` inclui `!includeRaw` na condição de over-fetch.
- [ ] Existe `vectorMetadataFor(e, text)` e é o ÚNICO ponto que monta metadata de vetor — `handleSaveEntity`, `handleReembedAll` e `reembedEntity` a utilizam (zero objetos de metadata inline nesses caminhos).
- [ ] Os SELECTs de `handleReembedAll` (`src/index.ts:586`) e `reembedEntity` (`src/index.ts:618-620`) incluem `category`.
- [ ] Metadata gravada pelos 3 caminhos contém `raw: boolean` e `category: string | null`.
- [ ] `contactsMeta` exclui crus via `name GLOB '*[A-Za-z]*'`; counts totais permanecem sem filtro.
- [ ] Teste (gate): fixture com maioria de entidades cruas + minoria nomeada semanticamente relevante → `GET /recall_entity?q=...&limit=10` devolve os nomeados (count > 0) sem `include_raw`.
- [ ] Teste: com `include_raw=true`, os crus aparecem no resultado (comportamento atual preservado).
- [ ] Teste: `vectorMetadataFor` marca `raw: true` pra nome só-dígitos e `raw: false` pra nome com letra; propaga `category` quando presente e `null` quando ausente.
- [ ] Índices de metadata (`raw`, `kind`, `category`) criados no `expert-contacts-vec` (passo aditivo; a troca pro filter nativo fica atrás do reembed total gated).
- [ ] Nenhuma migration destrutiva; `wrangler d1 migrations list` não muda.

## Validação

```sh
# no diretório do repo expert-contacts
npx tsc --noEmit                 # typecheck (script vem da spec 42 de CI)
npx vitest run                   # testes unitários (infra da spec 42)

# manual — dev local
npx wrangler dev
curl -s "http://localhost:8787/recall_entity?q=teste&limit=10" -H "Authorization: Bearer $OWNER_TOKEN"
curl -s "http://localhost:8787/recall_entity?q=teste&limit=10&include_raw=true" -H "Authorization: Bearer $OWNER_TOKEN"
```

Deploy (`npm run deploy`) SOMENTE com OK do dono. Reembed total (`POST /setup/reembed` em loop de `next_offset`) SOMENTE com OK do dono, e só quando for ativar o filter nativo.

## Arquivos afetados

- `src/index.ts` — over-fetch do recall, `vectorMetadataFor`, SELECTs + metadata de `handleSaveEntity` / `handleReembedAll` / `reembedEntity`, e (fase 2, pós-reembed) filter nativo na query do Vectorize.
- `src/vaults/contacts.ts` — filtro de crus no `contactsMeta`.
- `test/` (novo) — testes de `vectorMetadataFor` e do gate de recall com fixture crus+nomeados (usa a infra da spec 40-ops/42).

## Riscos e reversão

- **Over-fetch sempre ativo** (passo 1): 1 query Vectorize com `topK` até 50 em vez de 10 — custo marginal, sem risco funcional. Reversão: reverter a condição da linha 350 (1 linha).
- **Metadata nova (`raw`)**: campos extras na metadata são ignorados por quem não os lê — zero impacto nos leitores atuais. Reversão: voltar os objetos inline (git revert do commit).
- **Índices de metadata Vectorize**: aditivos; se algo der errado, `npx wrangler vectorize delete-metadata-index expert-contacts-vec --property-name=<nome>`. Não afetam queries sem `filter`.
- **Filter nativo prematuro** (antes do reembed total): vetores antigos sem a propriedade indexada saem do resultado — por isso a troca fica explicitamente atrás do reembed gated; até lá o pós-filtro continua no lugar. Reversão: remover o `filter` da chamada `VECTORIZE.query` (o pós-filtro da linha 371 segue funcionando como antes).
- **Palette filtrado**: se algum fluxo dependia de achar cru pelo palette, usar `list_entities?include_raw=true` (já existe, `src/index.ts:525`). Reversão: remover o `WHERE` (1 linha).
- Rollback geral: `git revert` do(s) commit(s) + `npm run deploy` — nenhum dado é migrado ou destruído por esta spec.
