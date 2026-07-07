# Contacts: cron Pipedrive com checkpoint incremental, falha visível e janela sem buraco

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-contacts
> **Depende de:** 40-ops/42-contacts-testes-typecheck-ci.md

## Contexto

O Worker `expert-contacts` (Cloudflare Workers + D1 + Vectorize + KV) tem um cron diário de manutenção (`wrangler.toml`, `[triggers] crons = ["0 9 * * *"]`) que sincroniza dados do Pipedrive de forma incremental e conservadora:

- `src/index.ts:611-615` — `pdGet(env, path)`: helper de fetch da API do Pipedrive. Anexa `api_token` na **querystring** e retorna `r.ok ? r.json() : null`.
- `src/index.ts:627-668` — `handleMaintenanceSync(env)`: lê `maint:last_run` do KV (`env.CACHE`), pagina `/recents?since_timestamp=...&items=person` (até 40 páginas × 100 = 4000 pessoas numa única invocação), e pra cada pessoa **só preenche campos vazios** (`email`, `company`) de contatos que **já existem** no D1 (match por telefone via `phoneVariants`). Re-embeda no Vectorize quando `company` muda. Ao final, grava `maint:last_run` com o timestamp de **término** do run.
- `src/index.ts:670-677` — handler `scheduled` chama `handleMaintenanceSync` via `ctx.waitUntil`, logando resultado ou erro.
- `src/index.ts:714` — rota manual `POST /maintenance/run` executa a mesma lógica sob `OWNER_TOKEN`.

Bindings relevantes (`src/env.ts`): `DB` (D1), `CACHE` (KV), `PIPEDRIVE_API_KEY?` (secret opcional), `VECTORIZE?`. Observability do Worker está **habilitada** (`wrangler.toml`, `[observability] enabled = true`) — logs de request são coletados.

O repo ainda não tem `test/` nem `vitest`/`typecheck` — a spec 40-ops/42 cria essa infraestrutura; esta spec adiciona os primeiros testes de unidade do cron sobre ela.

## Problema / Motivação

Quatro defeitos concretos, todos com evidência no código:

1. **Falha silenciosa avança a janela** (`contacts-cron-morre-em-silencio` + `maint-lastrun-janela-com-buraco`). `pdGet` retorna `null` tanto pra 401 (token revogado) quanto pra 5xx/erro de rede quanto pra "sem resultados" (`src/index.ts:614`). Em `handleMaintenanceSync`, um `null` na primeira página só encerra o loop (`if (!j) break;`, `src/index.ts:639`) e o fluxo segue com `persons = []`, termina "com sucesso" e grava `maint:last_run` (`src/index.ts:666`). No próximo run, `since` parte desse novo timestamp: **todas as modificações do período falho são perdidas pra sempre**, sem nenhum sinal externo (o log diz `ok: true, persons_recentes: 0`).
2. **Janela com buraco mesmo em sucesso** (`maint-lastrun-janela-com-buraco`). O `since` gravado é o timestamp de **término** do run (`ranAt` calculado em `src/index.ts:665`, depois de todo o processamento). Pessoas modificadas no Pipedrive **durante** a execução (que pode levar minutos com 4000 pessoas) caem entre o `since_timestamp` consultado e o `ranAt` gravado — buraco estrutural na janela.
3. **Sem teto de trabalho** (`cron-sem-teto-de-trabalho`). Uma edição em massa no Pipedrive (ex.: atualização de campo em milhares de pessoas) gera até 4000 persons numa invocação (`pages < 40`, `src/index.ts:633`), cada uma com 1-2 queries D1 + possível embedding no Workers AI. Isso estoura os limites do handler `scheduled` (CPU/subrequests) no meio do lote; como `maint:last_run` só grava no final, o próximo run **re-tenta o lote inteiro do zero** — loop de starvation em que o cron nunca conclui.
4. **API key na URL** (`pipedrive-token-na-url`). `src/index.ts:613` concatena `api_token=${env.PIPEDRIVE_API_KEY}` na querystring. URLs completas aparecem em logs de proxy/observability — e a observability está habilitada neste Worker. O Pipedrive aceita o header `x-api-token`, que não vaza em logs de URL.

## Objetivo

Nenhuma modificação do Pipedrive pode ser perdida silenciosamente: run com erro HTTP não avança `maint:last_run`, run interrompido por volume retoma do checkpoint no próximo disparo, 2+ falhas consecutivas geram aviso, e o token sai da URL — tudo verificado por testes com token inválido simulado.

## Design proposto

Todas as mudanças em `src/index.ts` (+ testes novos em `test/`). Nenhuma migration D1 — estado novo vive no KV (`env.CACHE`), aditivo e descartável.

### 1. `pdGet` distingue erro de vazio + token no header

Trocar a assinatura pra retornar resultado discriminado e mover o token pro header:

```ts
type PdResult = { ok: true; data: any } | { ok: false; status: number };

async function pdGet(env: Env, path: string): Promise<PdResult> {
  try {
    const r = await fetch(`https://api.pipedrive.com/v1${path}`, {
      headers: { "x-api-token": env.PIPEDRIVE_API_KEY! },
    });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() };
  } catch {
    return { ok: false, status: 0 }; // erro de rede
  }
}
```

- `{ ok: true, data }` com `data.data = []` = "sem resultados" (legítimo, pode avançar janela).
- `{ ok: false, status }` = 401/403/429/5xx/rede — **não** pode avançar janela.
- Remover `api_token=` da querystring por completo (busca por `api_token` no arquivo deve retornar zero ocorrências).

### 2. `handleMaintenanceSync`: início-do-run como `since` + abortar sem gravar em erro

```ts
async function handleMaintenanceSync(env: Env): Promise<any> {
  if (!env.PIPEDRIVE_API_KEY) return { ok: false, error: "PIPEDRIVE_API_KEY ausente (secret não configurado)" };
  // Timestamp de INÍCIO do run — será o próximo `since` se tudo der certo.
  // A janela seguinte SOBREPÕE o período de execução em vez de furar.
  // Sobreposição é segura: o sync é idempotente (só preenche campos vazios).
  const runStartedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
  const last = await env.CACHE.get("maint:last_run");
  const since = last || /* fallback 26h como hoje */;
  ...
}
```

Na paginação, qualquer `{ ok: false }` de `pdGet`:
- interrompe o run **sem** gravar `maint:last_run` (o `since` atual permanece; próximo run repete a mesma janela);
- incrementa o contador de falhas (item 4);
- retorna `{ ok: false, error: "pipedrive_http_error", status, since, pages_ok: N }` — o `scheduled` já loga esse JSON (`src/index.ts:674`).

Em sucesso completo (todas as páginas + todas as persons processadas): gravar `maint:last_run = runStartedAt` (não mais o `ranAt` de término) e zerar o contador de falhas.

### 3. Checkpoint incremental + teto de trabalho por invocação

Estado de progresso em KV, chave `maint:cursor` (JSON):

```jsonc
{
  "since": "2026-07-01 09:00:00",       // janela sendo processada
  "run_started_at": "2026-07-02 09:00:03", // candidato a próximo maint:last_run
  "next_start": 300                        // offset de paginação do Pipedrive (start=)
}
```

Fluxo:

1. No início do run, ler `maint:cursor`. Se existir, **retomar**: usar `cursor.since` como `since`, `cursor.run_started_at` como candidato a `last_run`, e começar a paginação em `start = cursor.next_start`. Se não existir, fluxo normal (janela nova a partir de `maint:last_run`).
2. Definir constante `MAX_PERSONS_PER_RUN = 500` (5 páginas de 100 — folga ampla sob os limites do `scheduled`; ajustável por env var opcional `MAINT_MAX_PERSONS`).
3. Processar página a página: fetch da página → processar as persons dela (enriquecimento + reembed) → **só então** avançar. Quando o total de persons processadas no run atingir o teto e ainda houver `more_items_in_collection`:
   - gravar `maint:cursor` com o `next_start` retornado pela paginação;
   - **não** gravar `maint:last_run`;
   - retornar `{ ok: true, partial: true, processed, next_start }`.
4. Quando a paginação terminar naturalmente (sem `more_items`): apagar `maint:cursor` (`env.CACHE.delete`), gravar `maint:last_run = run_started_at` (do cursor, se retomada; do run atual, se janela nova) e zerar falhas.
5. Erro HTTP no meio de uma retomada: manter o cursor como está (a página que falhou re-tenta no próximo run). O reprocessamento parcial é seguro pela idempotência (só-preenche-vazios).

> Nota: `maint:last_run` só avança quando a **janela inteira** foi consumida — um lote gigante vira N runs diários parciais até drenar, sem nunca perder o `since` original.

### 4. Contador de falhas consecutivas + aviso

- Chave KV `maint:consecutive_failures` (string numérica).
- Todo run que termina em `{ ok: false }` por erro HTTP/rede: incrementar.
- Todo run com sucesso completo (janela drenada): resetar pra `0`. Run `partial: true` não mexe no contador (progresso houve).
- Quando o valor **após incremento** for `>= 2`: emitir sinal de alerta consumível pelo mecanismo de alerting da spec `40-ops/43` — nesta spec, o sinal é (a) log estruturado `console.error("[maint][alert]", JSON.stringify({ kind: "maint_sync_failing", consecutive: n, status }))` e (b) chave KV `maint:alert` com o mesmo payload (a spec 40-ops/43 decide o transporte; aqui só produzimos o sinal de forma estável).
- Expor o estado no `GET /health` (`src/index.ts:158-178`): adicionar ao JSON `maint: { last_run, consecutive_failures, cursor_pending: boolean }` — leitura barata de 3 chaves KV, dá visibilidade sem tooling novo.

### 5. Testes (sobre a infra da spec 40-ops/42)

Criar `test/maintenance-sync.test.ts` (vitest + mocks de `fetch`, `env.CACHE` e `env.DB`):

- **Gate obrigatório — token inválido simulado:** mock de `fetch` retornando 401 → `handleMaintenanceSync` retorna `ok: false`, `maint:last_run` **não** foi gravado, `maint:consecutive_failures` incrementou.
- 5xx e rejeição de rede (`fetch` lança) → mesmo comportamento do 401.
- Sucesso com 0 resultados → `ok: true`, `last_run` gravado com o timestamp de **início** do run.
- Volume acima do teto → retorna `partial: true`, `maint:cursor` gravado com `next_start` correto, `last_run` intacto.
- Retomada de cursor → começa em `start = next_start`, e ao drenar grava `last_run = cursor.run_started_at` e apaga o cursor.
- 2 falhas consecutivas → `maint:alert` gravado e `console.error` com `maint_sync_failing`.
- `pdGet` → asserção de que a URL do `fetch` **não** contém `api_token` e o header `x-api-token` está presente.

## Fora de escopo

- Importar pessoas **novas** do Pipedrive — o cron continua só atualizando contatos que já existem (decisão deliberada, `src/index.ts:654`).
- Mudar a lógica conservadora de só-preencher-campos-vazios (`src/index.ts:657-658`).
- O transporte do alerta em si (Telegram/e-mail/etc.) — é da spec 40-ops/43; aqui só produzimos log estruturado + chave KV.
- Sincronizar outros items do Pipedrive além de `person`.
- Migrations D1 (nenhuma é necessária).

## Critérios de aceite

- [x] `pdGet` retorna `{ ok, status }`/`{ ok, data }` e envia o token via header `x-api-token`; `grep api_token src/index.ts` retorna vazio.
- [x] Run com erro HTTP (401/5xx/rede) em qualquer página termina com `ok: false` e **não** grava `maint:last_run`.
- [x] Run com sucesso completo grava `maint:last_run` com o timestamp de **início** do run (janela sobrepõe, nunca fura).
- [x] Existe teto de persons por invocação (default 500); ao atingi-lo o run grava `maint:cursor` (`since`, `run_started_at`, `next_start`) e retorna `partial: true`.
- [x] Run seguinte com cursor pendente retoma do `next_start` e, ao drenar a janela, apaga o cursor e grava `last_run = run_started_at` do cursor.
- [x] `maint:consecutive_failures` incrementa em falha, zera em sucesso completo, e `>= 2` produz log `maint_sync_failing` + chave `maint:alert`.
- [x] `GET /health` expõe `maint: { last_run, consecutive_failures, cursor_pending }`.
- [x] Testes de `test/maintenance-sync.test.ts` passam, incluindo o gate de token inválido (janela não avança).
- [x] Nenhuma mudança de schema D1; nenhum comportamento de escrita em `entities` alterado além do que já existia.

## Validação

```bash
cd C:/repos/expert-contacts
npx tsc --noEmit                 # typecheck (script formal vem da spec 40-ops/42)
npx vitest run test/maintenance-sync.test.ts
```

Teste manual pós-deploy (deploy SÓ com OK do dono):

```bash
# 1. Disparo manual do cron (usa OWNER_TOKEN real, fora do repo)
curl -s -X POST https://<worker>/maintenance/run -H "Authorization: Bearer $OWNER_TOKEN"
# esperado: ok:true com since/persons_recentes coerentes, OU partial:true com next_start

# 2. Gate de falha: trocar temporariamente o secret por valor inválido
npx wrangler secret put PIPEDRIVE_API_KEY   # valor lixo
curl -s -X POST https://<worker>/maintenance/run -H "Authorization: Bearer $OWNER_TOKEN"
# esperado: ok:false, status 401; /health mostra consecutive_failures=1 e last_run INALTERADO

# 3. Restaurar o secret verdadeiro e repetir o passo 1; /health volta a failures=0
```

## Arquivos afetados

- `src/index.ts` — `pdGet` (611-615), `handleMaintenanceSync` (627-668), `handleHealth` (158-178), handler `scheduled` (670-677, só se a assinatura de retorno mudar o log).
- `test/maintenance-sync.test.ts` — novo (depende da infra de testes da spec 40-ops/42).
- `wrangler.toml` — sem mudança obrigatória (comentário do cron pode ser atualizado).

## Riscos e reversão

- **Risco: cron parado em loop de falha** (ex.: Pipedrive fora do ar por dias) — a janela não avança e o backlog cresce. Mitigado pelo alerta em 2 falhas e pelo fato de `/recents` aceitar `since_timestamp` arbitrariamente antigo; ao voltar, o cursor/teto drenam o backlog em runs parciais.
- **Risco: sobreposição de janela reprocessa persons** — inócuo por design (só-preenche-vazios é idempotente); custo é algumas queries D1 extras.
- **Risco: teto mal calibrado** (500 baixo demais pra backlog grande) — ajustável via `MAINT_MAX_PERSONS` sem redeploy de código novo; um backlog de 4000 drena em ~8 dias no pior caso, ou imediatamente via disparos manuais repetidos de `POST /maintenance/run`.
- **Reversão:** `git revert` do commit + `wrangler deploy` — o estado novo em KV (`maint:cursor`, `maint:consecutive_failures`, `maint:alert`) é ignorado pelo código antigo e pode ser apagado com `wrangler kv key delete`. `maint:last_run` mantém o mesmo formato de sempre, então o rollback retoma exatamente de onde parou. Nenhum dado de `entities` é tocado de forma nova.
