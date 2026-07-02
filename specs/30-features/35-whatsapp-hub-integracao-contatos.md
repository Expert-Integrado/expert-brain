# Hub WhatsApp ↔ contatos: spec de INTERFACE (links cruzados na anotação + sync de categoria por telefone)

> **Status:** draft · **Prioridade:** P2 · **Esforço:** M · **Repo:** ops
> **Depende de:** 40-ops/45-contacts-category-seeds-e-4a-fonte.md · 10-backend/19-contacts-write-path-e-canon-unico.md

## Contexto

Esta spec define um **contrato de interface**, não uma implementação nestes repositórios. O consumidor do contrato é o agente de WhatsApp do dono da instância — um repositório **externo e privado**, fora desta árvore — que mantém chats com dois artefatos próprios: uma **anotação de chat** (texto livre por conversa) e uma **categoria de chat** (taxonomia própria do agente, ex.: "vendas", "time", "família"). Do lado de cá existem duas peças já em produção:

- **`expert-contacts`** (Worker Cloudflare, repo próprio em `C:/repos/expert-contacts`) — vault de contatos com API REST:
  - Lookup determinístico por telefone: `GET /get_contact_by_phone` → `handleContactByPhone` (src/index.ts:399-412), roteado em src/index.ts:708. Trata o 9º dígito BR via `phoneVariants` (src/index.ts:89-103) e retorna `{ match, results, variants }`.
  - Upsert de pessoa: `POST /save_person` → `handleSaveEntity` (src/index.ts:200-292), roteado em src/index.ts:698. Aceita `{ id?, name?, phone?, category?, source?, ... }`.
  - Categorias canônicas: `CONTACT_CATEGORIES` com **11 valores** (`cliente, lead, lead-perdido, aluno, parceiro, fornecedor, equipe, familia, pessoal, network, outro` — src/index.ts:52-55). A spec 10-backend/19 move esses enums pra `src/canon.ts` e expõe **`GET /canon`** como fonte única consumível por processos externos.
  - Auth: escrita (POST) exige `OWNER_TOKEN`; `CONTACTS_PROXY_TOKEN` autoriza somente GET (src/index.ts:69-78).
- **`expert-brain`** (este repo) — Console web com painel de contatos em `/app/contacts` (src/web/handler.ts:61-64), que proxeia pro vault preservando a query (`?focus=`, `?q=` — src/web/contacts-data.ts:18-26). `?focus=<entity_id>` abre a vizinhança do contato no grafo (expert-contacts src/vaults/contacts.ts:361-378 e :430). O MCP do Brain já expõe leitura do vault: `get_contact_by_phone` em src/mcp/tools/contacts.ts:91-104, via service binding + `CONTACTS_PROXY_TOKEN` (src/mcp/tools/contacts.ts:8-19).

Hoje a categoria de um contato tem três fontes possíveis: curadoria manual, o cron de enriquecimento via CRM (`handleMaintenanceSync`, expert-contacts src/index.ts:627-668) e escritas via MCP/API. A categoria de chat do agente de WhatsApp é a candidata a **4ª fonte** (definida na spec 40-ops/45).

## Problema / Motivação

1. **Anotação de chat não aponta pra lugar nenhum.** O agente externo anota conversas, mas a anotação não carrega link pro contato no vault nem pro deal no CRM — quem lê a anotação precisa buscar o contato manualmente. O deep-link já existe e não é usado: `/app/contacts?focus=<id>` (src/web/handler.ts:61 + expert-contacts src/vaults/contacts.ts:430).
2. **A categoria de chat morre no WhatsApp.** Um chat categorizado como "vendas" no agente não vira `category: "lead"` no contato correspondente — o vault fica com `category` nula pra contatos que o dono já classificou em outro sistema.
3. **Risco de consumidor reimplementar normalização de telefone.** A lógica do 9º dígito vive em `phoneVariants` (expert-contacts src/index.ts:89-103) e é sutil (12/13 dígitos com DDI, 10/11 sem, prefixo `9`). Qualquer cópia dessa lógica no lado WhatsApp diverge com o tempo — o mesmo tipo de drift que a spec 10-backend/19 documenta pros enums triplicados (item 4 daquela spec).
4. **Risco de sync corromper dados sem os gates.** Sem a spec 10-backend/19, `POST /save_person` sobrescreve `source` sempre (src/index.ts:208 + :238) e aceita `category: ""` por cima de categoria real (src/index.ts:211-213) — um batch de sync multiplicaria a corrupção. Sem a spec 40-ops/45 (seeds de categoria aplicados primeiro), o sync brigaria com a curadoria inicial, gravando por cima do que o dono acabou de classificar.

## Objetivo

Publicar o contrato que permite ao agente de WhatsApp externo (a) enriquecer anotações de chat com deep-links pro contato no Console e pro deal no CRM e (b) sincronizar categoria de chat → categoria canônica do contato via API do `expert-contacts`, sem nunca reimplementar normalização de telefone, sem nunca sobrescrever categoria já preenchida sem flag explícita, e de forma idempotente por `(phone, category)`.

## Design proposto

Todo o código consumidor vive no repo externo do agente de WhatsApp. Nestes repositórios, esta spec só formaliza o contrato (as capacidades servidoras já existem ou chegam pelas dependências). Os quatro blocos do contrato:

### 1. Resolução de identidade — SEMPRE via `GET /get_contact_by_phone`

- O consumidor resolve "telefone do chat → contato do vault" chamando `GET /get_contact_by_phone?phone=<E.164 sem +>` no `expert-contacts` (rota src/index.ts:708) com o token de leitura (`CONTACTS_PROXY_TOKEN` cobre GET, src/index.ts:76).
- A resposta é `{ match: boolean, results: [...], variants: [...] }`. O consumidor usa `results[0].id` como identidade do contato.
- **Regra dura:** o consumidor NUNCA reimplementa `phoneVariants` nem qualquer normalização além de "remover não-dígitos antes de mandar" — o tratamento do 9º dígito é responsabilidade exclusiva do servidor (src/index.ts:89-103).
- `match: false` → o contato não existe no vault. O sync **não cria** contato (ver Fora de escopo); registra o telefone num relatório de "não resolvidos" pro dono decidir.

### 2. Enriquecimento de anotação — deep-links escritos pelo agente externo

Ao anotar um chat cujo telefone resolveu pra um contato, o agente externo acrescenta à anotação (no armazenamento DELE) um bloco de links:

```
Contato: {BRAIN_URL}/app/contacts?focus={entity_id}
CRM: {CRM_DEAL_URL}            ← somente quando existir deal associado
```

- `{BRAIN_URL}` é a URL da instância do Console do dono (configuração do lado externo; nunca hardcodada nesta árvore). O formato `?focus=<entity_id>` é o deep-link suportado (src/web/handler.ts:61 + src/web/contacts-data.ts:21; foco tratado em expert-contacts src/vaults/contacts.ts:430).
- O link de CRM vem do sistema de CRM do dono (resolução deal↔telefone é responsabilidade do lado externo); quando não houver deal, a linha é omitida — nunca link vazio.
- O bloco é **idempotente**: antes de escrever, o agente verifica se a anotação já contém o link daquele `entity_id` e não duplica.
- Nenhuma escrita no `expert-contacts` acontece neste bloco — é enriquecimento do artefato do lado WhatsApp.

### 3. Sync de categoria — chat → 4ª fonte de categoria do contato

- **Mapa de categorias:** o consumidor mantém um mapa `categoria-de-chat → categoria canônica` (ex. fictício: `"vendas" → "lead"`, `"time" → "equipe"`, `"família" → "familia"`). O lado direito do mapa é validado contra **`GET /canon`** (rota criada pela spec 10-backend/19) a cada execução do batch — os 11 valores de `contact_categories` **nunca são hardcodados** no consumidor. Categoria de chat sem mapeamento → chat pulado (não vira `"outro"` automaticamente).
- **Escrita:** `POST /save_person` com body **mínimo** `{ "id": "<entity_id>", "category": "<canônica>" }`, autenticado com **o token de menor escopo que autorize esta escrita**. Hoje isso é o `OWNER_TOKEN` (POST exige, src/index.ts:72-76); quando existir token de escrita escopado (evolução natural da spec 10-backend/24, que hoje só cobre o token de leitura), o consumidor migra pra ele. O token vive apenas na configuração do repo externo — nunca nesta árvore.
- **Não mandar `source` no body** — com a spec 10-backend/19 aplicada, update sem `source` preserva a proveniência existente do contato. Não mandar `name`/`phone` — o body mínimo evita qualquer efeito colateral de upsert.
- **Precondição de leitura:** antes de escrever, o consumidor lê a `category` atual do contato (já vem na resposta do `get_contact_by_phone`). Regras do bloco 4 decidem se escreve.

### 4. Regras de segurança do sync

1. **Nunca sobrescrever categoria preenchida sem flag explícita.** `category` atual não-nula e diferente da proposta → skip, a menos que o batch rode com `--overwrite` (decisão manual do dono, nunca default). Categoria nula/ausente → escreve.
2. **Idempotência por `(phone, category)`.** O consumidor guarda (no lado externo) o par já sincronizado; reexecutar o batch com o mesmo estado não gera nenhum novo POST. Como reforço, a precondição do bloco 3 (categoria atual == proposta → skip) torna o re-POST inócuo mesmo com o cache perdido.
3. **Batch com rate-limit.** Execução em lote serializada com intervalo mínimo entre requests (sugestão: ≥ 200 ms, ≤ 5 req/s) — o Worker é compartilhado com o Console e o MCP.
4. **Ordem dos gates (regra dura de rollout):** o sync SÓ pode rodar pela primeira vez depois de (a) spec **40-ops/45** com os seeds de categoria aplicados — senão o batch briga com a curadoria inicial — e (b) spec **10-backend/19** em produção — senão o write path corrente corrompe `source` (src/index.ts:208) e aceita `category: ""` destrutiva (src/index.ts:211-213).
5. **Relatório, não silêncio:** cada execução do batch produz um sumário (escritos / pulados-por-preenchida / sem-mapeamento / não-resolvidos / erros HTTP) pro dono auditar.

### Anti-vazamento

Esta spec e qualquer documentação derivada nesta árvore usam apenas dados fictícios (`5511900000000`, "Contato Exemplo") — nenhum número de telefone, ID de chat, ID de deal ou nome real entra no repositório público (regra da seção 4 do `specs/README.md`).

## Fora de escopo

- **Qualquer código do lado WhatsApp** — o agente externo é repo privado do dono; esta árvore não recebe nenhum arquivo dele.
- **Import em massa de contatos do WhatsApp** — o sync não cria contato quando `match: false`; o gatilho de escala (volume de entidades, prevenção do limite 1102 do Vectorize) é tratado na spec 10-backend/21.
- **Mudança de código no `expert-contacts` ou no `expert-brain`** — as capacidades servidoras (`/get_contact_by_phone`, `/save_person`, `/canon`, `?focus=`) já existem ou chegam pelas dependências; esta spec não altera handler nenhum.
- **Token de escrita escopado** (write allowlist análoga à do `CONTACTS_PROXY_TOKEN`) — se necessário, vira spec própria em `10-backend/`; aqui só se declara a preferência por menor escopo.
- **Sync reverso** (categoria do vault → categoria de chat) e merge de contatos duplicados.
- **Migrations** — nenhuma; nenhuma tabela nova nestes repos.

## Critérios de aceite

- [ ] O contrato dos 4 blocos (identidade, anotação, sync de categoria, regras de segurança) está documentado nesta spec com endpoints, formato de body e semântica de erro suficientes pra um agente implementar o consumidor lendo APENAS esta spec + `specs/README.md`.
- [ ] O contrato exige resolução de identidade exclusivamente via `GET /get_contact_by_phone` e proíbe explicitamente reimplementar normalização de telefone no consumidor.
- [ ] O contrato exige obter as categorias canônicas via `GET /canon` (spec 10-backend/19) e proíbe hardcodar os 11 valores no consumidor.
- [ ] O deep-link documentado (`/app/contacts?focus=<entity_id>`) abre o contato correto no Console de uma instância de teste (verificação manual com um contato fictício).
- [ ] A escrita de categoria documentada é `POST /save_person` com body mínimo `{ id, category }`, sem `source`, e o contrato declara a regra de não-sobrescrita sem flag, a idempotência por `(phone, category)` e o rate-limit do batch.
- [ ] A ordem dos gates está declarada como regra dura: sem 40-ops/45 aplicada e 10-backend/19 em produção, o sync não roda.
- [ ] A spec não contém número de telefone real, ID de chat, ID de deal, nome de pessoa real, URL de instância privada nem credencial (varredura antes do commit).
- [ ] Todo o texto está em PT-BR com acentuação correta.

## Validação

Este entregável é só Markdown neste repo — sanidade padrão:

```bash
cd C:/repos/expert-brain
npm run typecheck
npm test
```

Teste manual do contrato (contra `wrangler dev` do `expert-contacts`, com contato fictício e `OWNER_TOKEN` de dev):

```bash
# 1. identidade (leitura) — 9º dígito resolvido pelo servidor
curl -s "localhost:8787/get_contact_by_phone?phone=551190000000" -H "Authorization: Bearer $T"
# esperado: match=true com o contato salvo como 5511900000000 (variante com 9)

# 2. sync de categoria — body mínimo, sem source
curl -sX POST localhost:8787/save_person -H "Authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"id":"<entity_id>","category":"lead"}'
# esperado: action=updated; GET /entities/<id> mostra category=lead e source INTACTO (exige spec 19 aplicada)

# 3. canon consumível
curl -s "localhost:8787/canon" -H "Authorization: Bearer $PROXY_T"
# esperado: contact_categories com os 11 valores (exige spec 19 aplicada)
```

Deploy: não se aplica nestes repos (documento). A primeira execução do batch de sync no repo externo é um side-effect em produção do vault — acontece **SOMENTE com OK explícito do dono da instância**, após confirmar os dois gates de dependência.

## Arquivos afetados

- `specs/30-features/35-whatsapp-hub-integracao-contatos.md` (novo — este documento)
- (externo) repo do agente WhatsApp do dono — implementação do consumidor (fora desta árvore)

## Riscos e reversão

**Riscos:**

- *Sync rodar antes dos gates:* corrompe `source`/`category` em lote (bugs 2 e 3 da spec 10-backend/19). Mitigação: regra dura de rollout (bloco 4.4) + o batch valida `GET /canon` na partida — a rota só existe com a spec 19 aplicada, funcionando como gate técnico natural.
- *Mapa de categorias mal calibrado:* chats mapeados pra categoria errada em lote. Mitigação: skip de categoria preenchida (sem `--overwrite`), relatório por execução e idempotência — corrigir o mapa e rodar de novo só toca os contatos ainda nulos.
- *Deep-link quebrar se a rota do Console mudar:* links antigos em anotações apontariam pra 404. Mitigação: `/app/contacts?focus=` é rota estável do Console (src/web/handler.ts:61); mudança futura exige redirect na própria rota.

**Reversão:**

- Nesta árvore: `git revert` do commit desta spec — documento puro, zero efeito em runtime.
- Do sync (lado externo): desligar o batch. As categorias já gravadas ficam — pra desfazer um lote errado, o relatório da execução (bloco 4.5) lista exatamente quais `entity_id` foram escritos; reverter é `POST /save_person` com a categoria anterior (nula → exige `update` manual/curadoria, por isso o skip-por-preenchida é default). Nenhum dado é apagado em nenhum cenário.
