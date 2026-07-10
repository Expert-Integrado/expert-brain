# Observabilidade: crons por job, telemetria do dedupe_key e índice de score

> **Status:** shipped (10/07/2026) · **Prioridade:** P1 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** `71`/`72`/`73` (os jobs que passam a ser observados). Plano-mãe: diagnóstico pós-ship do grupo 70 (10/07/2026).

## Problema

1. `trackCronOutcome` (spec 40-ops/43) cobre SÓ o due-reminder. Falha do backup semanal, do re-pass e do digest de higiene = `console.error` que evapora — o dono descobre sentindo falta.
2. Hit do `dedupe_key` (spec 71, Passo 0) não gera log nem métrica: a adoção do gate hard é invisível.
3. `similar_edges` não tem índice em `score`: o digest de segunda e o /app/graph fazem full scan de ~27k linhas (ok hoje, cresce linear).
4. `update_note` re-embeda quando tldr/domains/kind muda mas não avisa se a edição aproximou a nota de uma existente (quase-clone silencioso) — o save_note avisa, o update_note não.

## Design

### 1. trackCronOutcome por job (`src/scheduled.ts`)

- Nova assinatura: `trackCronOutcome(env, job: string, ok: boolean, message?: string)`.
- Chaves KV por job: `cron:<job>:consecutive_failures` e `cron:<job>:last_error` (GRAPH_CACHE).
- **Compat**: pro job `due-reminder`, TAMBÉM escrever as chaves legadas `cron:consecutive_failures`/`cron:last_error` (health-check externo já lê).
- Alerta Telegram em 2+ falhas consecutivas de QUALQUER job, mensagem com o nome do job.
- Wire nos 4 braços do `runScheduled`: `backup`, `similar-repass`, `hygiene-digest`, `due-reminder` (autocancel segue como está — é no-op opcional).

### 2. /status por job (`src/auth/setup.ts`)

- Manter o bloco `cron` legado (espelho do due-reminder).
- Adicionar `cron_jobs: { [job]: { consecutive_failures, last_error } }` pros 4 jobs. KV transiente degrada pro default, nunca derruba o /status.

### 3. Telemetria do dedupe_key (`src/mcp/tools/save-note.ts` + `src/digest/hygiene.ts`)

- No hit do gate hard: `console.log('save_note dedupe_hit', ...)` + incremento de contador diário em KV: chave `dedupe:hits:<YYYY-MM-DD>` (UTC), TTL 8 dias. Get+put (não atômico — perda ocasional sob corrida é aceitável, é telemetria). Falha de KV nunca derruba o save.
- Digest de higiene (segunda): somar os últimos 7 dias e, se N > 0, adicionar seção "dedupe_key na semana: N hit(s)".

### 4. Migration 0018 (`src/db/migrate.ts`)

- `0018_similar_edges_score_idx`: `CREATE INDEX IF NOT EXISTS idx_similar_edges_score ON similar_edges(score)`. Aditiva, formato padrão das MIGRATIONS.

### 5. possible_duplicates no update_note (`src/db/note-write.ts` + `src/mcp/tools/update-note.ts`)

- `reembedNoteIfNeeded` passa a retornar `{ reembedded: boolean; matches: VectorMatch[] }` e, no caminho que re-embeda, faz ELE a consulta (`queryVector(env, vec, SIMILARITY_TOP_K + 2)`) e persiste via `persistSimilarEdgesFromMatches` — mesma 1-consulta-3-consumidores do save_note; `refreshSimilarEdges` sai desse caminho (faria query duplicada). Falha da consulta: matches vazio, edges ficam pro re-pass (best-effort preservado).
- Atualizar os DOIS callers (`src/mcp/tools/update-note.ts`, `src/web/notes.ts` handler de update).
- No update_note (MCP): dos matches, filtrar `id != nota` e `score >= DEDUP_MIN_SCORE`, hidratar com o selo de privacidade do caller e devolver `possible_duplicates` (mesmo shape do save_note) quando não-vazio. Aditivo — nenhum campo existente muda.
- No caminho web (notes.ts) só o retorno muda (`.reembedded`); sem UI nova aqui.

## Critérios de aceite

- [x] 2 falhas seguidas de `backup` → `cron:backup:consecutive_failures = 2` + tentativa de alerta com "backup" no texto; sucesso zera.
- [x] `due-reminder` continua escrevendo as chaves legadas (compat) além das novas.
- [x] GET /status expõe `cron_jobs` com os 4 jobs e mantém o bloco `cron`.
- [x] Hit de dedupe_key incrementa o contador diário; digest de segunda mostra a seção quando N > 0 e omite quando N = 0.
- [x] Provision novo cria `idx_similar_edges_score` (visível em sqlite_master).
- [x] update_note que re-embeda perto de nota existente devolve `possible_duplicates`; edição sem mudança semântica não consulta o Vectorize (comportamento atual preservado).
- [x] Suite verde.
