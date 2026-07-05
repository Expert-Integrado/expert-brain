# Contacts: observações que alimentam a busca semântica — events no embedding + busca textual em contexts

> **Status:** ready · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-contacts
> **Depende de:** `50-console-v2/57` (função `recordEvent` extraída + form de registro no console)
> **Agente sugerido:** Opus (mexe no texto canônico de embedding)

## Contexto

Executa no working tree de `C:/repos/expert-contacts` (protocolo cross-repo da spec-zero, `specs/README.md` seção 6).

- `entities.notes_text` JÁ existe, é editável via patch (`src/entity-write.ts:104`) e JÁ entra no embedding: `embeddingTextFor` (`src/embedding.ts:9-21`) compõe `name — role — company — sector — website — notes_text` com `slice(0, 1500)`.
- Observações DATADAS vivem em `events` (kind `note` existe desde a `0001`; tabela atual sem CHECK de kind desde a `0002` — validação é em código, `canon.ts`): `id, entity_id, kind, ts, context, source`. **Nenhum event entra no embedding** — `reembedEntity` (`src/entity-write.ts:128-149`) seleciona só colunas de `entities` (linha 140).
- Busca textual (LIKE) cobre `notes_text` mas NÃO `events.context`: REST search (`src/index.ts:332`) e console search (`src/vaults/contacts.ts:366`).
- A spec `57` extrai `recordEvent(env, input)` (chamado pelo REST `POST /event` e pelos endpoints novos de console) e cria o form "Registrar interação" com kind `note` disponível.
- Vetores: bge-m3 via Workers AI (`src/embedding.ts:23-36`), metadata canônica em `vectorMetadataFor` (NUNCA montar inline — comentário em `src/embedding.ts:50-55`). Reindex em massa: `handleReembedAll` existe (usado no rollout da `0002`).

## Problema / Motivação

- O dono da instância quer que a aba de contatos seja o dossiê da pessoa: profissão, empresa, histórico, observações — e que a BUSCA SEMÂNTICA encontre por esse conteúdo ("quem era o cara que trabalha com licitações?"). Hoje, se isso foi registrado como observação datada (event `note`), o recall NUNCA acha: o embedding ignora events.
- A busca textual também não alcança `events.context` — observação registrada some de todas as buscas, só aparece rolando a timeline.
- `notes_text` (o "quem é" durável) funciona, mas está escondido na UI — o dono nem sabe que existe.

## Design proposto

### 1. Observações entram no texto de embedding

`embeddingTextFor` (`src/embedding.ts:9-21`) ganha campo opcional `observations?: string | null` e o budget sobe:

```ts
// Campos de identidade (até 1500 chars, como hoje) + bloco de observações
// (events kind='note', mais recentes primeiro) até o teto TOTAL de 3000 chars.
// bge-m3 aceita 8k tokens — 3000 chars é conservador e dobra o sinal disponível.
return [base, e.observations ? `Observações: ${e.observations}` : null]
  .filter(Boolean).join("\n").slice(0, 3000);
```

- `reembedEntity` (`src/entity-write.ts:128-149`): além do SELECT de `entities`, busca os `context` das últimas **10** events `kind='note'` da entidade (`ORDER BY ts DESC`, contexts não-nulos, cada um truncado em 280 chars, join com `" · "`) e passa como `observations`. Mesma composição em TODOS os call sites que geram vetor (`handleSaveEntity`, `handleReembedAll` — fonte única, sem duplicar a query: helper `observationsTextFor(env, entityId)` no próprio `embedding.ts` ou em `entity-write.ts`).
- **Coordenação com a `61` (privacidade)**: quando a coluna `events.private` existir, a query de observações filtra `private = 0` — conteúdo privado NUNCA entra em vetor. Se a 61 ainda não rodou, a coluna não existe e o filtro é omitido (guardar como comentário no helper).

### 2. Reembed automático ao registrar observação

- `recordEvent` (da `57`): quando `kind === 'note'`, disparar `reembedEntity(env, entityId)` via `ctx.waitUntil` (não bloqueia a resposta; falha de embedding não falha o registro — mesmo contrato de erro tolerante do `computeEmbedding`).
- Demais kinds (met/talked/meeting/...) NÃO reembedam: contexto de interação ("call de 30min") é ruído semântico; o sinal durável é a observação.

### 3. Backfill (rollout)

Mudar a composição do texto muda TODOS os vetores → após deploy, rodar `handleReembedAll` (reindex completo) **com OK explícito do dono** (custo Workers AI proporcional ao número de entidades). Até rodar, entidades antigas seguem com o vetor antigo — degradação zero, só não ganham o sinal novo.

### 4. Busca textual alcança observações

Nos DOIS caminhos LIKE, adicionar (com o mesmo termo já escapado):

```sql
OR EXISTS (SELECT 1 FROM events ev WHERE ev.entity_id = e.id
           AND LOWER(COALESCE(ev.context,'')) LIKE ?)
```

- REST search (`src/index.ts:332`) e console search (`src/vaults/contacts.ts:366`). (Na `61`, este EXISTS ganha `AND ev.private = 0` quando o caller não vê privados.)

### 5. UI: o dossiê fica visível (coordena com 56/57)

- Painel/página da entidade: seção **"Observações"** exibindo `notes_text` com edição inline (o write path já existe: `POST /app/entity/update` → patch `notes_text`), acima da timeline da `57`.
- Diretriz de uso (nas descriptions do MCP e placeholder da UI): **fato durável** sobre a pessoa ("é advogado tributarista, sócio da firma X") → `notes_text`; **observação episódica/datada** ("disse que vai trocar de emprego em março") → registrar interação `kind: note` (form da `57` / tool `log_event`).
- Descriptions das tools `save_person`/`save_company` (param `notes_text`) e `log_event` (kind `note`) atualizadas com essa diretriz — o agente MCP decide o destino certo sem adivinhação.

## Fora de escopo

- Migration (nenhuma — usa colunas/tabelas existentes; a flag `private` é da `61`).
- Novos kinds de event (a `57` já define o enum estendido).
- Extração automática de fatos de transcrições/WhatsApp (spec `30-features/35`).
- Sumarização por LLM das observações antigas (as 10 últimas truncadas bastam; iteração futura se o recall degradar).
- Mudança de metadata do Vectorize (`vectorMetadataFor` intocado).

## Critérios de aceite

- [ ] Registrar observação (`log_event` kind `note` ou form do console) → vetor da entidade atualizado (verificável: `recall` semântico do próprio worker encontra a entidade por termo que SÓ existe na observação).
- [ ] Registrar event de kind ≠ `note` NÃO dispara reembed.
- [ ] `embeddingTextFor` com observações respeita teto de 3000 chars e trunca cada context em 280; sem observações, saída idêntica à atual (compat).
- [ ] Busca textual (REST e console) encontra entidade por termo presente só em `events.context`.
- [ ] Seção "Observações" na UI mostra e edita `notes_text`; salvar dispara o reembed compartilhado (caminho existente).
- [ ] `handleReembedAll` regenera todos os vetores com a composição nova (teste com 2 entidades fixture, uma com observações).
- [ ] Nenhuma chamada existente muda de contrato (params novos são opcionais; `notes_text` já existia).

## Validação

- `npx tsc --noEmit` + `npm test` (suíte vitest do contacts) verdes; testes novos: composição do texto (com/sem observações, truncamento, teto), gatilho de reembed por kind, EXISTS na busca.
- Manual (`wrangler dev`): registrar observação com termo único, buscar por texto e por recall, conferir.
- **Gate de deploy:** `wrangler deploy` só com OK explícito do dono; backfill (`handleReembedAll`) é segundo OK separado.

## Arquivos afetados (todos em `C:/repos/expert-contacts`)

- `src/embedding.ts` (`observations` + teto 3000 + helper `observationsTextFor`)
- `src/entity-write.ts` (`reembedEntity` compõe observações)
- `src/index.ts` (gatilho no `recordEvent`/`handleEvent`, EXISTS na search REST, descriptions)
- `src/vaults/contacts.ts` (EXISTS na search do console, seção Observações no detalhe)
- `src/web/*` (edição inline de `notes_text` na página da entidade — reusar form pattern da `55`)
- `mcp/index.js` (descriptions de `save_person`/`save_company`/`log_event`)
- `test/` (suites acima) — e update de status desta spec no repo expert-brain

## Riscos e reversão

- **Risco**: observação com dado sensível entra no vetor e "vaza" por similaridade em superfície proxy. Mitigação: o conteúdo em si nunca é servido pelo vetor (só ids; hidratação D1 filtra) e a `61` exclui events privados do embedding na origem.
- **Risco**: custo do reembed em massa. Mitigação: backfill é ação manual separada com OK do dono; o incremental é 1 chamada por observação nova.
- **Reversão**: revert do código; vetores já regravados ficam com o texto estendido até o próximo save/reembed de cada entidade (inócuo — só sinal a mais). `handleReembedAll` no código antigo restaura a composição anterior se necessário.
