# Captura sem fricção: inbox de rascunhos + fila de triagem no console

> **Status:** ready · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma (independente do resto da Fase 6; pode rodar a qualquer momento pós-C1)
> **Agente sugerido:** Opus (schema + contrato MCP) · **Esforço de execução:** padrão

## Contexto

- Salvar no Brain hoje exige decidir na hora: `save_note` pede `kind` (obrigatório), `domains`, `tldr` com teste de Feynman — fricção CERTA pra conhecimento curado, fatal pra captura no meio do dia.
- Os canais de captura já existem como AGENTES: bots Telegram/WhatsApp nos containers da VPS e sessões Claude nas máquinas do dono — todos com acesso MCP ao Brain. O que falta não é infra de entrada; é um ALVO de baixa fricção.
- `notes.kind` NÃO tem CHECK no banco (`src/db/migrate.ts:13` — `kind TEXT,`); a validação dos 7 kinds + task é em código. Ainda assim, usar um kind novo `inbox` exigiria excluir rascunhos de TODOS os read paths de nota (recall/FTS/grafo/stats) — mesma classe de risco de vazamento do soft-delete. **Decisão: tabela separada** — rascunho não está em `notes`, logo NÃO vaza em nenhum read path por construção.
- Migrations runtime: array `MIGRATIONS` em `src/db/migrate.ts`; número indicativo (regra transversal do roadmap).

## Problema / Motivação

- Segundo cérebro morre na captura: se registrar uma ideia custa mais que 5 segundos, ela não é registrada. Hoje o caminho é "abrir sessão → agente decide kind/domain/tldr" — bom pro resultado, lento demais pro impulso.
- Não existe o conceito GTD de inbox: um lugar onde TUDO entra cru e é triado depois, em lote, com calma.

## Design proposto

### 1. Migration `0013_inbox` (aditiva — número indicativo)

```sql
CREATE TABLE IF NOT EXISTS inbox_items (
  id             TEXT PRIMARY KEY,
  body           TEXT NOT NULL,               -- texto cru, ≤4000 chars
  source         TEXT NOT NULL DEFAULT 'mcp', -- mcp | console | telegram | whatsapp (informativo, string livre)
  created_at     INTEGER NOT NULL,
  triaged_at     INTEGER,                     -- NULL = pendente
  triage_action  TEXT,                        -- note | task | discard
  result_id      TEXT                         -- id da nota/task criada na triagem (auditoria)
);
CREATE INDEX IF NOT EXISTS idx_inbox_pending ON inbox_items (created_at) WHERE triaged_at IS NULL;
```

### 2. Tools MCP (3 novas, contrato mínimo)

- **`capture`** — input `{ text, source? }`. Só isso. Sem kind, sem domain, sem tldr. Description: "captura instantânea pro inbox; a triagem decide depois se vira nota, task ou nada. Use quando o dono mandar uma ideia/lembrete solto sem pedir nota estruturada." Retorna id + contagem de pendentes.
- **`list_inbox`** — pendentes (default) ou todos; `{ id, body, source, created_at }`, ordenado por criação.
- **`resolve_inbox`** — `{ id, action: 'note'|'task'|'discard', result_id? }`. Marca triado. NÃO cria a nota/task — quem cria é o fluxo normal (`save_note`/`save_task`, com toda a curadoria), e o caller passa o `result_id` de volta. Isso mantém UMA rota de escrita de conhecimento (sem duplicar validação de kind/domain aqui).
- Gate de escopo (spec 17): `capture` e `resolve_inbox` são tools de ESCRITA (bloqueadas pra PAT `read`); `list_inbox` é leitura. Itens de inbox não têm flag private (rascunho é sempre do dono; PATs de nicho não deveriam ter `list_inbox`? — decisão: `list_inbox` respeita o gate de escrita NÃO, mas o conteúdo é pré-triagem sensível → registrar `list_inbox` como tool de escrita também, fail-closed: só PAT `full`/dono enxerga o inbox).

### 3. Fluxo dos bots (zero infra nova)

O bot Telegram/WhatsApp (sessão Claude na VPS) chama `capture` quando a mensagem do dono for ideia/lembrete solto. Documentar no retorno da tool a frase de confirmação curta ("capturado; N pendentes na triagem"). NENHUM webhook novo, NENHUMA rota pública — a captura entra pelo MCP autenticado que já existe.

### 4. UI: `/app/inbox` (fila de triagem)

- Item da fila: body (render markdown leve), source, idade ("há 2d"). Ações por item:
  - **Virar nota** → editor de nota pré-preenchido (body → corpo; título = primeira linha truncada); ao salvar, `resolve_inbox` automático com o id criado.
  - **Virar task** → quick-create de task pré-preenchido (título = primeira linha; body → detalhes); idem.
  - **Descartar** → `resolve_inbox action:discard` (sem confirmação — descarte é barato, o item fica auditável na tabela).
- **Badge de pendentes na navegação** (shell em `src/web/layout.ts`): contador ao lado do link Inbox quando > 0.
- **Quick-add no console**: campo de captura de 1 linha no topo do `/app/inbox` (e atalho na paleta da `66`, quando existir) → POST sessão → `inbox_items`.
- Endpoints (sessão, padrões CSRF dos POSTs atuais): `GET /app/inbox`, `POST /app/inbox/add | resolve`.

### 5. Interações com vizinhas (registrar)

- Digest (`64`): inclui contagem de pendentes >7 dias ("inbox acumulando").
- Home (`65`): card de inbox pendente.
- Paleta (`66`): ação "Capturar: <texto>".

## Fora de escopo

- Captura por e-mail, share-sheet nativo (PWA share target é a `68`), webhook público.
- Triagem automática por LLM (o dono tria manualmente ou pede pro agente na sessão — que usa `list_inbox` + `save_note`/`save_task` + `resolve_inbox`).
- Anexos/mídia no inbox (texto puro nesta fase).
- Retenção/expurgo de descartados (ficam na tabela; volume é trivial).

## Critérios de aceite

- [ ] `capture` grava em <1 roundtrip e NADA aparece em recall/FTS/grafo/stats (por construção — teste de vazamento confirmando).
- [ ] `list_inbox` lista pendentes; item triado some do default.
- [ ] `/app/inbox`: virar nota e virar task pré-preenchem, salvam pelo fluxo normal e resolvem o item com `result_id`; descartar marca `discard`.
- [ ] Badge na navegação mostra contagem correta e some em zero.
- [ ] PAT com escopo `read`: nenhuma das 3 tools registrada (inbox é superfície do dono).
- [ ] Quick-add do console grava com `source: 'console'`.

## Validação

- `npm run typecheck` + `npm test`; testes novos: CRUD do inbox, exclusão dos read paths (vazamento), gate de escopo, resolve com/sem result_id.
- Manual (`wrangler dev`): capturar via MCP, triar os 3 caminhos pela UI.
- **Gate de deploy:** `wrangler deploy` só com OK explícito do dono.

## Arquivos afetados

- `src/db/migrate.ts` (0013), `src/db/queries.ts` (queries de inbox)
- `src/mcp/tools/capture.ts`, `list-inbox.ts`, `resolve-inbox.ts` (novos) + `src/mcp/registry.ts`
- `src/web/inbox.ts` (novo: página + endpoints), `src/web/layout.ts` (link + badge), `src/web/handler.ts` (rotas)
- `test/` (suites acima)

## Riscos e reversão

- **Risco**: inbox virar cemitério (captura sem triagem). Mitigação: badge persistente + item no digest da `64`; a fricção de triagem é 2 cliques.
- **Risco**: bot capturar TUDO (ruído). Mitigação: description da tool restringe a ideia/lembrete solto do DONO; conversa normal não captura.
- **Reversão**: revert do código; tabela fica inerte. Zero acoplamento com `notes`.
