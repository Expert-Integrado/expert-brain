# Contacts: aplicar seeds de categoria completos com overwrite + 4ª fonte (categoria de chat WhatsApp por telefone)

> **Status:** in-progress · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-contacts
> **Parte 1 (aplicar category_seeds.json completo com overwrite):** done — 1451 categorias aplicadas em `entities.category` via batches UPDATE...WHERE id IN(...) no D1 remoto (`expert-contacts-db`); dist final bate com o seed (aluno 3, cliente 155, lead 364, lead-perdido 567, network 292, pessoal 70), 0 fora do canon, total de entidades inalterado (7587). Apenas `category` tocada (`source` NÃO alterado). Scripts `apply-category-seeds.mjs`/`apply-whatsapp-categories.mjs` HTTP-based e `docs/categorias-fontes.md` NÃO foram criados nesta onda.
> **Parte 2 (4ª fonte WhatsApp) + scripts versionados + doc de proveniência:** pendente (fora desta onda).
> **Depende de:** 10-backend/19-contacts-write-path-e-canon-unico.md (gate obrigatório — bugs de `category ""` e `source` sobrescrito corrompem exatamente este fluxo em massa) · 40-ops/44-contacts-migrations-tracking.md (somente SE a implementação optar por coluna nova; o design default desta spec não exige migration)

## Contexto

O `expert-contacts` é um Worker Cloudflare (D1 + Vectorize + Workers AI + R2) que mantém o grafo de contatos do dono do vault. A categorização de contatos já existe como coluna nativa:

- `migrations/0003_category.sql` adicionou `entities.category TEXT` + índice `idx_entities_category` (aditiva, ADD COLUMN).
- Canon de categorias: `CONTACT_CATEGORIES` em `src/index.ts:52-55` — `cliente | lead | lead-perdido | aluno | parceiro | fornecedor | equipe | familia | pessoal | network | outro`. Após a spec 10-backend/19, a fonte única passa a ser `src/canon.ts` (exposta via `GET /canon`).
- Escrita: `POST /save_person` → `handleSaveEntity` (`src/index.ts:200-292`). No UPDATE, `category = COALESCE(?, category)` (`src/index.ts:240`) — mandar `category` não-nula sobrescreve; mandar `null`/omitir preserva. Não existe hoje modo "só preencher vazio" no servidor: essa política fica no cliente (script).
- Leitura por telefone: `GET /get_contact_by_phone` → `handleContactByPhone` (`src/index.ts:399-412`), que já resolve variantes BR com/sem 9º dígito via `phoneVariants` (`src/index.ts:89-103`).
- Filtros por categoria já funcionam em `/recall_entity` (`src/index.ts:339`, `:370`, `:379-383`) e `/list_entities` (`src/index.ts:520`, `:532`).

Fontes de categoria que existem ou estão planejadas:

1. **pipedrive** — cron `handleMaintenanceSync` (`src/index.ts:627-668`) enriquece email/company de contatos existentes, mas hoje NÃO seta categoria.
2. **manual** — dono categoriza via MCP (`mcp/index.js:67`) ou Console.
3. **seeds** — arquivo JSON de curadoria completa (~1451 entradas) produzido pelo dono FORA do repo (contém PII: nomes + telefones reais). Não há script versionado que o aplique.
4. **whatsapp** — o sistema de WhatsApp do dono (projeto separado, Supabase) mantém categorias de chat (relação N:N chat ↔ categoria). O mapa `categoria-de-chat → categoria canônica de contato` é definido na spec `30-features/35`. Não existe nem stub dessa integração no repo.

Scripts existentes em `scripts/` (referência de convenção — Node puro, sem deps, `--dry-run`, token via env com fallback `~/.claude.json`): `import-google-contacts.mjs`, `fetch-zapi-photos.mjs`, `promote-companies-v2.mjs`, `reembed-all.mjs`. Nenhum trata categoria.

## Problema / Motivação

1. **Categorização parada em ~11%.** Só ~861 de ~7,6k entidades têm `category` preenchida (contagem via `GET /list_entities?category=...` somada, ou `SELECT COUNT(*) FROM entities WHERE category IS NOT NULL`). O filtro por categoria (`src/index.ts:370`, `:532`) — a razão de existir da coluna criada na `migrations/0003_category.sql` — devolve fatias minúsculas da rede real.
2. **O trabalho de curadoria já foi feito e está órfão.** O arquivo de seeds completo (~1451 entradas) vive fora do repo sem script de aplicação versionado — a pasta `scripts/` não contém nenhum utilitário de categoria (verificável: `grep -rn "category" scripts/*.mjs` → zero hits de escrita). Aplicar hoje exige script ad-hoc irreproduzível.
3. **4ª fonte sem stub.** As categorias de chat do WhatsApp são a fonte mais viva (refletem relacionamento atual), mas nada no repo as cruza com `entities.category`. `handleMaintenanceSync` (`src/index.ts:627-668`) só cobre Pipedrive.
4. **Sem doc de proveniência.** Com 4 fontes escrevendo o mesmo campo, não há registro no repo de qual fonte vence qual — próxima aplicação em massa pode desfazer curadoria manual silenciosamente.
5. **Gate real:** os bugs da spec 10-backend/19 atingem exatamente este fluxo — `category: ""` bypassa a validação e apaga categoria real (`src/index.ts:211-213` + COALESCE em `:240`), e `source` é SEMPRE sobrescrito no UPDATE (`src/index.ts:208` + `:238`): um apply de 1451 saves sem `source` transformaria `source='pipedrive'` em `'manual'` em massa. Rodar esta spec antes da 19 corrompe proveniência em escala.

## Objetivo

Após rodar os dois novos scripts (com dry-run revisado pelo dono antes do apply real), ≥ 90% das entradas do arquivo de seeds estão aplicadas em `entities.category`, contatos com chat WhatsApp categorizado e `category` vazia ficam preenchidos, e o repo contém doc de proveniência com a precedência das 4 fontes.

## Design proposto

### 1. `scripts/apply-category-seeds.mjs` (novo)

Node puro, sem deps externas, mesmo padrão de `scripts/import-google-contacts.mjs` (token via `EXPERT_CONTACTS_TOKEN` com fallback `~/.claude.json`; `EXPERT_CONTACTS_URL` default pro Worker de produção).

**O arquivo de seeds permanece FORA do git** (contém PII — nomes e telefones reais). O script recebe o path por argumento posicional obrigatório:

```
node scripts/apply-category-seeds.mjs <path-do-seeds.json>              # DRY-RUN (default)
node scripts/apply-category-seeds.mjs <path-do-seeds.json> --apply      # aplica (só vazios)
node scripts/apply-category-seeds.mjs <path-do-seeds.json> --apply --overwrite  # sobrescreve categoria existente
```

**Contrato do JSON de seeds** (documentar no header do script, com exemplo FICTÍCIO — nunca dado real):

```json
[
  { "id": "uuid-da-entidade", "category": "cliente" },
  { "name": "Fulano Exemplo", "phones": ["5511999990000"], "category": "network" }
]
```

**Lógica por entrada:**

1. Validar `category` contra o canon — buscar via `GET /canon` (rota criada pela spec 10-backend/19); fallback: lista hardcoded com aviso. Entrada com categoria fora do canon → contabilizar como `invalida`, nunca enviar (proteção extra contra o bug do `""`: entrada sem `category` ou com string vazia é `invalida`).
2. Resolver a entidade: `id` presente → `GET /entities/:id`; senão, para cada telefone em `phones`, `GET /get_contact_by_phone?phone=...` (o servidor já aplica `phoneVariants`, `src/index.ts:399-412` — NÃO reimplementar variantes no script). Sem match → `nao_encontrada`.
3. Decidir: categoria atual vazia (`null`) → aplicar; categoria atual igual ao seed → `pulada (igual)`; categoria atual diferente → aplicar SÓ com `--overwrite`, senão `pulada (conflito)`.
4. Aplicar via `POST /save_person` com body mínimo: `{ id, name: <nome atual da entidade>, category, source: "seed" }` (`name` é obrigatório no upsert, `src/index.ts:203`; usar o nome JÁ salvo pra não alterar nada além da categoria). Depois da spec 19, `source: "seed"` só é gravado porque foi enviado explicitamente — proveniência intencional.
5. Registrar proveniência: `POST /event` com `{ entity_id, kind: "note", context: "category:<valor> via seeds (overwrite=<bool>)", source: "seed" }`. Se a spec 19 criar `EVENT_KINDS`, incluir/usar o kind `categorized` (decidir na implementação junto com a 19).

**Dry-run (default):** imprime diff por entrada (`nome mascarado | categoria atual → nova | ação`) e NÃO faz nenhum POST. **Relatório final** (dry-run e apply): `aplicadas / puladas (igual) / puladas (conflito) / nao_encontradas / invalidas`, com lista das não-encontradas pra curadoria. Concorrência limitada (`IMPORT_CONCURRENCY`, default 8, mesmo padrão do import do Google).

### 2. `scripts/apply-whatsapp-categories.mjs` — 4ª fonte (novo)

A atribuição deixa aberto "script ou etapa do cron"; **decisão desta spec: script versionado**, pelos mesmos motivos do item 1 (dry-run revisável pelo dono, sem credencial do sistema de WhatsApp dentro do Worker). Promover pra etapa do cron fica como evolução futura (fora de escopo aqui).

1. Ler do sistema de WhatsApp do dono (API REST do Supabase do projeto; `WA_DB_URL` + `WA_DB_KEY` via env — NUNCA hardcoded, NUNCA commitados) a lista `{ telefone_do_chat, categorias_do_chat[] }` dos chats individuais categorizados.
2. Traduzir `categoria-de-chat → categoria canônica de contato` usando o mapa definido na spec `30-features/35` (fonte do mapa; se a 35 ainda não estiver implementada, o mapa vai como constante no script com comentário apontando pra 35). Chat com múltiplas categorias: aplicar a de maior precedência conforme o mapa; sem tradução definida → `sem_mapa` no relatório, não escrever.
3. Cruzar por telefone via `GET /get_contact_by_phone` (variantes resolvidas no servidor).
4. Política de escrita: **preencher SÓ `category` vazia** por default; sobrescrever exige `--overwrite` explícito. Escrita idêntica ao item 1 (`POST /save_person` com `source: "whatsapp"` + `POST /event`).
5. `--dry-run` default + relatório final com os mesmos contadores do item 1 (+ `sem_mapa`).

### 3. `docs/categorias-fontes.md` — proveniência e precedência (novo)

Criar a pasta `docs/` no repo com o doc canônico das 4 fontes. Conteúdo mínimo:

- Tabela das fontes: `manual` (MCP/Console), `seed` (curadoria em massa), `whatsapp` (categoria de chat), `pipedrive` (cron — hoje não seta categoria; reservado).
- **Precedência (maior vence):** `manual > seed > whatsapp > pipedrive`. Operacionalização: scripts NUNCA sobrescrevem sem `--overwrite`; `--overwrite` é o dono exercendo a precedência conscientemente após revisar o dry-run.
- Como auditar de onde veio uma categoria: trilha nos `events` da entidade (`GET /entities/:id` → `recent_events`).
- Zero exemplo com dado real — nomes/telefones sempre fictícios.

**Sem migration:** o design registra proveniência via `events` (tabela existente) e `source` explícito no save — nada de coluna nova. SE a implementação decidir por coluna dedicada `category_source` em `entities`, a migration é aditiva (ADD COLUMN) e segue o processo da spec 40-ops/44. NUNCA quebrar dados existentes.

## Fora de escopo

- UI de curadoria de categorias no Console.
- Recategorização por IA (classificador semântico sugerindo categoria).
- Promover a 4ª fonte pra etapa do cron `scheduled` do Worker.
- Corrigir os bugs de `category ""` / `source` sobrescrito (é a spec 10-backend/19 — pré-requisito, não escopo daqui).
- Backfill de categoria a partir do Pipedrive (fonte reservada, sem implementação nesta spec).
- Commitar o arquivo de seeds ou qualquer dump com PII no repo.

## Critérios de aceite

- [ ] `scripts/apply-category-seeds.mjs` existe, roda em dry-run por default e NÃO faz nenhum POST sem `--apply`.
- [ ] O script recebe o path do JSON de seeds por argumento e falha com mensagem clara se o arquivo não existir ou não parsear; o arquivo de seeds NÃO está no git (conferir `git status` / `.gitignore` se o path usado for interno ao repo).
- [ ] Sem `--overwrite`, nenhuma entidade com `category` já preenchida é alterada (verificável no relatório: `puladas (conflito)` > 0 e diff vazio pra elas).
- [ ] Com `--overwrite`, a categoria do seed vence e o evento de proveniência registra `overwrite=true`.
- [ ] Entrada com categoria fora do canon ou vazia é rejeitada localmente (`invalidas` no relatório), sem request ao Worker.
- [ ] Relatório final imprime `aplicadas / puladas (igual) / puladas (conflito) / nao_encontradas / invalidas`.
- [ ] Cada categoria aplicada gera 1 registro em `events` da entidade com a fonte (`seed` ou `whatsapp`) visível em `GET /entities/:id`.
- [ ] `scripts/apply-whatsapp-categories.mjs` existe, cruza por `GET /get_contact_by_phone`, preenche só `category` vazia por default e exige `--overwrite` pra sobrescrever.
- [ ] Mapa `categoria-de-chat → canon` referencia a spec `30-features/35` (import ou comentário apontando pra ela); categoria de chat sem tradução aparece como `sem_mapa` e não escreve.
- [ ] `docs/categorias-fontes.md` existe com as 4 fontes, a precedência `manual > seed > whatsapp > pipedrive` e zero dado pessoal.
- [ ] Após o apply real dos seeds (autorizado pelo dono), `SELECT COUNT(*) FROM entities WHERE category IS NOT NULL` reflete ≥ 90% das entradas resolvidas do arquivo.
- [ ] Nenhum `source` pré-existente foi corrompido pelo apply (amostrar 10 entidades `source='pipedrive'` antes/depois — depende do fix da spec 19 estar deployado).

## Validação

```bash
# gate: confirmar que a spec 10-backend/19 está deployada (canon exposto = fix no ar)
curl -s https://<worker>/canon -H "Authorization: Bearer $EXPERT_CONTACTS_TOKEN"

# typecheck (script tsc criado pela 40-ops/42; se ainda ausente, node --check nos .mjs)
npm run typecheck 2>/dev/null || node --check scripts/apply-category-seeds.mjs && node --check scripts/apply-whatsapp-categories.mjs

# dry-run dos dois (nenhuma escrita) — saída revisada pelo dono ANTES do apply
node scripts/apply-category-seeds.mjs "<path-externo>/seeds.json"
node scripts/apply-whatsapp-categories.mjs

# baseline antes/depois
wrangler d1 execute expert-contacts-db --remote --command "SELECT category, COUNT(*) FROM entities GROUP BY category"

# apply real SÓ com OK explícito do dono sobre o dry-run
node scripts/apply-category-seeds.mjs "<path-externo>/seeds.json" --apply
node scripts/apply-whatsapp-categories.mjs --apply

# teste manual pós-apply: filtro por categoria volta fatias coerentes
curl -s "https://<worker>/list_entities?category=cliente&limit=5" -H "Authorization: Bearer $EXPERT_CONTACTS_TOKEN"
```

Deploy do Worker não é necessário (scripts são clientes da API existente); qualquer deploy eventual SÓ com OK do dono.

## Arquivos afetados

- `scripts/apply-category-seeds.mjs` (novo)
- `scripts/apply-whatsapp-categories.mjs` (novo — 4ª fonte)
- `docs/categorias-fontes.md` (novo)
- `src/index.ts` (somente SE a implementação adicionar o event kind `categorized` ao canon junto com a spec 19; caso contrário, intocado)
- `package.json` (opcional: scripts npm `categories:seed` / `categories:whatsapp` apontando pros .mjs)

## Riscos e reversão

- **Categorização errada em massa (mapa ou seed ruim):** mitigado pelo dry-run default + relatório revisado pelo dono. Reversão: os `events` de proveniência dizem exatamente quais entidades cada rodada tocou e com qual fonte — script de rollback ad-hoc lê esses events e reaplica a categoria anterior registrada no diff do dry-run (guardar a saída do dry-run aprovado como artefato local da rodada, fora do git).
- **Corrupção de `source` (bug spec 19):** NÃO rodar `--apply` antes do fix deployado (gate verificado via `GET /canon`). Se corromper mesmo assim: `source` original recuperável só por backup do D1 — tirar snapshot antes do apply real (`wrangler d1 export expert-contacts-db --remote --output <local-fora-do-git>.sql`; contém PII, nunca commitar).
- **Vazamento de PII:** seeds e dumps ficam fora do git por contrato (path por argumento, export local). Revisar `git status` antes de qualquer commit da implementação.
- **Sistema de WhatsApp indisponível/credencial errada:** script da 4ª fonte falha rápido na leitura, antes de qualquer escrita — sem estado parcial.
- **Rollback total:** restaurar o snapshot do D1 tirado antes do apply (`wrangler d1 execute ... --file <snapshot>.sql` em banco limpo, ou restore pontual das linhas afetadas via events). Nenhuma mudança de schema envolvida no caminho default — nada a reverter no código do Worker.
