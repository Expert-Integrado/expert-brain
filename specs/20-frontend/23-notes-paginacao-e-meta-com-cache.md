# Brain web: paginação em /app/notes e cache no /app/graph/meta (fim do full-scan por page view)

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

A superfície web do Brain (Cloudflare Worker) tem duas rotas envolvidas nesta spec:

- **`/app/notes`** — lista de notas, SSR em `src/web/notes.ts` (`handleNotesList`, linha 51). O servidor roda `SELECT id, title, domains, kind, tldr, updated_at FROM notes ... ORDER BY updated_at DESC` **sem LIMIT** (`src/web/notes.ts:55-57`) e serializa um `<a class="note-card">` por nota no HTML (`src/web/notes.ts:63-73`). O bundle client (`src/web/client/notes.ts`) então busca `/app/graph/meta` (`src/web/client/notes.ts:44`), reconstrói a lista inteira em memória e re-renderiza tudo via `listEl.innerHTML` a cada interação (`apply()`, `src/web/client/notes.ts:230`).
- **`/app/graph/meta`** — metadados leves de TODAS as notas (`id, title, tldr, kind, domains`), handler `handleGraphMeta` em `src/web/graph-data.ts:305-326`. Responde sempre com `cache-control: no-store` (`src/web/graph-data.ts:325`), ou seja, full-scan do D1 + download completo em toda chamada.

Quem chama `/app/graph/meta` hoje (grep em `src/`):

| Chamador | Quando | Arquivo |
|----------|--------|---------|
| Shell (palette Ctrl+K) | **No boot de TODA página** (`loadNotes()` chamado incondicionalmente em `src/web/client/shell.ts:334`) | `src/web/client/shell.ts:67-85` |
| Bundle da lista de notas | No boot de `/app/notes` | `src/web/client/notes.ts:44` |
| Bundle do grafo | No boot de `/app/graph` | `src/web/client/graph.ts:40` |

Ou seja: em `/app/notes` e `/app/graph` o mesmo endpoint é baixado **duas vezes** (shell + bundle da página), e em páginas que nem têm busca visível (`/app/tasks`, `/app/config`, detalhe de nota) ele é baixado mesmo assim — só pra alimentar um Ctrl+K que raramente abre.

Já existe infraestrutura de invalidação barata: `computeSourceHash(env)` (`src/web/graph-data.ts:45-59`) resume o estado do vault em 3 queries agregadas de D1 (`MAX/COUNT` de `notes`, `edges`, `similar_edges`) e é usado pelo cache KV do payload do grafo (`getPayload`, `src/web/graph-data.ts:180-188`). O comentário do `CACHE_KEY` (`src/web/graph-data.ts:43`) registra o histórico do **Error 1102** (Worker excedendo limites em vault grande) — a lista SSR sem LIMIT é da mesma família de risco.

Auth: rotas `/app/*` exigem sessão de cookie (`requireSession`, `src/web/session.ts:87`); `/app/graph/meta` também aceita `Authorization: Bearer <GRAPH_EXPORT_TOKEN>` (`authorizeGraphExport`, `src/web/graph-data.ts:16-27`). Testes existentes chamam handlers direto com `env` do `cloudflare:test` (padrão em `test/media.test.ts`, `test/e2e.test.ts`); ainda **não existe** pasta `test/web/`.

## Problema / Motivação

1. **SSR sem paginação** (`notes-ssr-no-pagination`): com 1800+ notas vivas, `handleNotesList` serializa 1800+ cards (~600KB de HTML) em toda visita a `/app/notes` (`src/web/notes.ts:55-73`). Custo de D1 (full scan), de CPU do Worker (string building) e de rede/parse no browser — mesma família do incidente 1102 documentado em `src/web/graph-data.ts:43`.
2. **Full-scan do meta em toda navegação** (`shell-meta-fullscan-every-page`): `loadNotes()` roda no boot de todo shell (`src/web/client/shell.ts:334`) e o endpoint responde `no-store` (`src/web/graph-data.ts:325`) — nem o browser pode reaproveitar. Navegar por 5 páginas = 5 full-scans de `notes` no D1 + 5 downloads do JSON completo.
3. **Download duplicado na mesma página**: em `/app/notes`, shell (`shell.ts:69`) e bundle da lista (`client/notes.ts:44`) baixam o MESMO payload em paralelo, dobrando o custo.
4. **Re-render do pool completo por keystroke**: `apply()` reconstrói `listEl.innerHTML` com o pool inteiro (`src/web/client/notes.ts:230`), e o handler de input chama `apply()` duas vezes por tecla (síncrono na linha 111 + callback do debounce na linha 121) — o browser re-parseia ~1800 nós de DOM 2x por tecla digitada.

## Objetivo

Uma visita a `/app/notes` responde com no máximo ~100 cards no HTML SSR (alvo: corpo da resposta cai de ~600KB pra <60KB), e navegar entre páginas do app **não** dispara download do `/app/graph/meta` — o meta só é buscado sob demanda (primeira abertura da palette ou página que precisa dele) e revalida via ETag (304 em navegações em sequência).

## Design proposto

Zero migration, zero mudança de schema — tudo é read path (SQL com LIMIT, headers HTTP, client TS). Nenhum dado existente é tocado.

### 1. `/app/notes` SSR: LIMIT + offset + "carregar mais" (src/web/notes.ts)

Em `handleNotesList`:

```ts
const PAGE_SIZE = 100;
const url = new URL(req.url);
// offset saneado: inteiro >= 0; qualquer lixo vira 0.
const rawOffset = Number(url.searchParams.get('offset') ?? '0');
const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

const [rows, totalRow] = await Promise.all([
  env.DB.prepare(
    `SELECT id, title, domains, kind, tldr, updated_at FROM notes
     WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task')
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`
  ).bind(PAGE_SIZE + 1, offset).all<NoteListItem>(),
  env.DB.prepare(
    `SELECT COUNT(*) c FROM notes WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task')`
  ).first<{ c: number }>(),
]);
const page = (rows.results ?? []).slice(0, PAGE_SIZE);
const hasMore = (rows.results ?? []).length > PAGE_SIZE;
const total = totalRow?.c ?? page.length;
```

- `ssrItems` passa a mapear `page` (não mais `notes`).
- O contador do header (`src/web/notes.ts:78`) usa `total` (continua mostrando o total real, não o tamanho da página).
- Depois do `<div id="notes-list">`, quando `hasMore`, renderizar link no-JS-friendly:

```html
<a id="notes-load-more" class="notes-load-more" href="/app/notes?offset=${offset + PAGE_SIZE}">Carregar mais</a>
```

- O empty-state (`src/web/notes.ts:123`) só aparece quando `total === 0` (não quando um offset além do fim retorna página vazia — nesse caso renderiza link "← Voltar pro início" pra `/app/notes`).
- CSS do link: adicionar classe `.notes-load-more` no CSS que o shell já injeta pra página de notas (mesmo arquivo onde vivem `.note-card`/`.notes-toolbar` — localizar por grep `notes-toolbar` em `src/web/`).

O fallback no-JS vira paginação por página (o link navega com novo offset). O comportamento rico (append) fica no client — item 2.

### 2. Client da lista: janela de render + "mostrar mais" (src/web/client/notes.ts)

O bundle continua operando sobre o meta completo (necessário pros chips de domínio/tipo e pra busca/filtros globais — `renderChips`, `src/web/client/notes.ts:160-197`), mas **para de despejar o pool inteiro no DOM**:

- Novo estado `renderLimit` iniciando em `200`. `apply()` (`src/web/client/notes.ts:199-234`) renderiza `pool.slice(0, renderLimit)` e, se `pool.length > renderLimit`, appenda um botão `<button id="notes-show-more">Mostrar mais (N restantes)</button>` cujo click faz `renderLimit += 200; apply();`.
- Toda mudança de query/filtro/sort reseta `renderLimit = 200` (busca nova = janela nova).
- Eliminar o re-render duplicado por tecla: no listener de input (`src/web/client/notes.ts:100-122`), o render síncrono com Fuse local permanece, mas o callback do debounce só chama `apply()` se o resultado do servidor efetivamente mudou o conjunto (comparar lista de ids antes de re-renderizar). Com `renderLimit`, mesmo o pior caso re-parseia ≤200 nós, não 1800.
- **`updated_at` no meta**: hoje o client lê `updated_at` do DOM SSR (`data-updated-at`, `src/web/client/notes.ts:35-40`). Com SSR paginado, só as 100 primeiras teriam o dado e o sort `updated_desc` quebraria pro resto. Corrigir na fonte: adicionar `updated_at` ao SELECT e ao payload de `handleGraphMeta` (`src/web/graph-data.ts:311-323`) e à interface `NoteMetaRow` (`src/web/graph-data.ts:259-265`). Campo ADITIVO — consumidores existentes (shell, graph) ignoram campos extras. Remover o `updatedMap` do DOM (`src/web/client/notes.ts:33-40`) e o atributo `data-updated-at` do SSR fica opcional (pode manter pro no-JS, é barato).

### 3. `/app/graph/meta`: ETag via sourceHash + cache privado (src/web/graph-data.ts)

Em `handleGraphMeta` (`src/web/graph-data.ts:305`), antes do full-scan:

```ts
// ETag barato: computeSourceHash são 3 queries agregadas (MAX/COUNT), não o full-scan.
// O hash inclui edges/similar_edges que o meta não usa — over-invalidação aceitável
// (pior caso: um 200 a mais depois de linkar notas; nunca um 304 stale).
const sourceHash = await computeSourceHash(env);
const etag = `W/"meta-${sourceHash}"`;
const headers = { etag, 'cache-control': 'private, max-age=60' };
if (req.headers.get('if-none-match') === etag) {
  return new Response(null, { status: 304, headers });
}
// ... full-scan + map existentes ...
return Response.json(meta, { headers });
```

- `private` porque a resposta é por-sessão (nunca deixar CDN/proxy compartilhar).
- `max-age=60`: navegações em sequência dentro de 60s nem revalidam (cache de memória do browser); depois disso, revalidação condicional vira 304 sem corpo enquanto o vault não mudar.
- O `no-store` atual (`src/web/graph-data.ts:325`) é removido **só** do `handleGraphMeta` — `handleGraphData` e `handleNoteGraph` continuam `no-store` (fora de escopo).

### 4. Shell: meta lazy + loader compartilhado entre bundles

Criar `src/web/client/meta-cache.ts`:

```ts
// Loader compartilhado do /app/graph/meta. Memoiza a Promise num global do
// window pra que bundles distintos (shell, notes, graph) na MESMA página
// façam no máximo 1 fetch — o dedupe entre PÁGINAS fica por conta do
// ETag/max-age do servidor (item 3).
export interface NoteMeta { id: string; title: string; kind: string; tldr: string; domains: string[]; updated_at?: number; }

export function loadMeta(): Promise<NoteMeta[]> {
  const w = window as any;
  if (!w.__ebMetaPromise) {
    w.__ebMetaPromise = fetch('/app/graph/meta', { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error(`meta ${res.status}`);
        return res.json() as Promise<NoteMeta[]>;
      })
      .catch((err) => {
        w.__ebMetaPromise = undefined; // permite retry na próxima chamada
        throw err;
      });
  }
  return w.__ebMetaPromise as Promise<NoteMeta[]>;
}
```

- **`src/web/client/shell.ts`**: remover a chamada incondicional `loadNotes()` do boot (`src/web/client/shell.ts:334`). `openPalette()` (`src/web/client/shell.ts:215-222`) passa a disparar `ensureNotesLoaded()` — wrapper que chama `loadMeta()` uma vez, popula `notes`/`notesById`/`fuseNotes` (`src/web/client/shell.ts:56-58`) e re-renderiza a lista da palette quando resolve (o empty-state "Notas ainda carregando" de `src/web/client/shell.ts:182` já cobre a janela de latência). O corpo de `loadNotes` (`src/web/client/shell.ts:67-85`) é reescrito em cima de `loadMeta()`.
- **`src/web/client/notes.ts`**: trocar o `fetch` direto (`src/web/client/notes.ts:44`) por `loadMeta()`.
- **`src/web/client/graph.ts`**: trocar o fetch do meta (região da linha 40 — localizar o `fetch('/app/graph/meta')` exato) por `loadMeta()`.

Resultado por página: `/app/tasks`, `/app/config`, detalhe de nota → **zero** fetch de meta no boot; `/app/notes` e `/app/graph` → exatamente 1 fetch (compartilhado com a palette se ela abrir depois); qualquer fetch repetido em até 60s sai do cache do browser, e depois disso vira 304.

### 5. Gate de medição (obrigatório antes do merge)

Registrar nesta spec (seção Validação) os números antes/depois, medidos no deploy de preview ou local com o vault de produção replicado:

- Tamanho do corpo de `GET /app/notes` (bytes) — antes e depois.
- Tempo de resposta de `GET /app/notes` (p50 de 5 requests).
- Nº de requests a `/app/graph/meta` numa sequência de navegação notes → tasks → graph → config (aba Network) — antes (4+, sendo 2 duplicados) e depois (≤2, com 304/memory-cache nos repetidos).

## Fora de escopo

- Virtualização completa de lista (windowing com scroll infinito real) — a janela de 200 + botão resolve o custo sem dependência nova.
- Transformar o app em SPA ou mudar o roteamento.
- Mudanças no payload do grafo principal (`/app/graph/data`, `handleGraphData`) — coberto pela spec 26.
- Paginação server-side da BUSCA (`/app/search`) — já retorna ids limitados.
- Tocar em `handleNoteGraph`, cache KV do grafo (`GRAPH_CACHE`) ou `computeSourceHash` em si.
- Service worker / estratégias de cache offline (`sw.js`).

## Critérios de aceite

- [ ] `GET /app/notes` com vault de 250+ notas renderiza no máximo 100 `note-card` no HTML e inclui link `#notes-load-more` com `href="/app/notes?offset=100"`.
- [ ] `GET /app/notes?offset=100` renderiza a segunda página (cards 101–200 na ordem `updated_at DESC`) e o contador do header continua mostrando o TOTAL de notas, não o tamanho da página.
- [ ] `offset` inválido (negativo, não-numérico) é tratado como 0 — sem erro 500.
- [ ] Vault vazio: `/app/notes` mostra o empty-state e NÃO mostra "Carregar mais"; offset além do fim mostra link de volta ao início.
- [ ] `GET /app/graph/meta` responde com header `etag` (contendo o sourceHash) e `cache-control: private, max-age=60`; segunda chamada com `If-None-Match` igual retorna **304 sem corpo**.
- [ ] Após criar/editar/deletar uma nota, o ETag muda e a chamada condicional volta **200** com o payload novo (sem 304 stale).
- [ ] Payload do `/app/graph/meta` inclui `updated_at` (ms) por nota; shell e graph continuam funcionando (campo aditivo).
- [ ] No boot de `/app/tasks` (ou qualquer página sem lista/grafo), NENHUM request a `/app/graph/meta` é feito; abrir a palette (Ctrl+K) dispara o fetch e a busca funciona.
- [ ] Em `/app/notes`, a aba Network mostra exatamente 1 request a `/app/graph/meta` no boot (não 2).
- [ ] Na lista client-side, com 1800+ notas o DOM contém no máximo ~200 cards + botão "Mostrar mais"; clicar no botão appenda os próximos 200; mudar busca/filtro reseta a janela.
- [ ] Ordenação `updated_desc` correta pra notas além da primeira página SSR (usa `updated_at` do meta, não do DOM).
- [ ] `handleGraphData` e `handleNoteGraph` continuam respondendo `cache-control: no-store` (sem regressão).
- [ ] Números antes/depois registrados na seção Validação desta spec (gate do merge).
- [ ] `npm run typecheck` e `npm test` verdes.

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck        # tsc do worker + tsc do client (src/web/client/tsconfig.json)
npm test                 # vitest run + vitest run --config vitest.auth.config.ts
npm run build:bundles    # esbuild dos bundles client precisa passar
```

Testes novos em `test/web/notes.test.ts` (criar a pasta `test/web/`; seguir o padrão de `test/media.test.ts`: `env` de `cloudflare:test`, `runMigrations`, seed direto no D1):

- Seed de 250 notas (`kind='concept'`) + 5 tasks (`kind='task'`, que NÃO devem aparecer) com `updated_at` crescente.
- `handleNotesList`: montar `Request` com cookie de sessão válido (setar `E.SESSION_SECRET = 'test-secret'` e usar `signSession`/`sessionCookie` de `src/web/session.ts:38,69`) e assertar: contagem de `class="note-card"` no HTML ≤ 100; presença/ausência do link `notes-load-more`; offset inválido → 200.
- `handleGraphMeta`: autenticar via `E.GRAPH_EXPORT_TOKEN = 'tok'` + header `Authorization: Bearer tok` (dispensa cookie, ver `src/web/graph-data.ts:16`); assertar headers `etag`/`cache-control`, o fluxo 200 → 304 → (update de nota) → 200, e `updated_at` presente no payload.

Teste manual (preview): navegar notes → tasks → graph → config com a aba Network aberta e conferir a contagem de requests do meta e os 304; abrir Ctrl+K numa página "fria" e buscar uma nota.

**Registro de medição (preencher antes do merge):**

| Métrica | Antes | Depois |
|---------|-------|--------|
| Corpo de `GET /app/notes` (bytes) | _medir_ | _medir_ |
| p50 `GET /app/notes` (5 reqs) | _medir_ | _medir_ |
| Requests `/app/graph/meta` em 4 navegações | _medir_ | _medir_ |

Deploy (`npm run deploy`) SOMENTE com OK explícito do dono do repo.

## Arquivos afetados

- `src/web/notes.ts` — LIMIT/OFFSET + COUNT + link "Carregar mais" no SSR (`handleNotesList`)
- `src/web/client/notes.ts` — janela de render (`renderLimit`), botão "Mostrar mais", `updated_at` do meta, uso do `loadMeta()`
- `src/web/client/shell.ts` — remoção do `loadNotes()` do boot, carga lazy na palette via `loadMeta()`
- `src/web/client/graph.ts` — troca do fetch direto do meta por `loadMeta()`
- `src/web/client/meta-cache.ts` — **novo**: loader compartilhado/memoizado do meta
- `src/web/graph-data.ts` — ETag + `cache-control: private, max-age=60` + `updated_at` no `handleGraphMeta`
- `test/web/notes.test.ts` — **novo**: testes de paginação SSR e de ETag/304 do meta

## Riscos e reversão

- **Risco: 304 stale.** Mitigado por construção — o ETag deriva de `computeSourceHash`, que já é a fonte de invalidação do cache do grafo (`src/web/graph-data.ts:45-59`) e muda em qualquer write de nota/edge/similar. Over-invalidação (hash muda por edge que o meta não usa) custa só um 200 a mais; **under**-invalidação não acontece porque `MAX(updated_at)`/`COUNT` cobrem create/update/soft-delete de notas. Se ainda assim aparecer staleness em produção, hotfix de 1 linha: voltar `cache-control` pra `no-store` e remover o branch do 304 (o resto da spec continua valendo).
- **Risco: quebra do sort/filtro no client por falta de `updated_at`.** Coberto pelo item 2 (campo aditivo no meta) e por critério de aceite dedicado.
- **Risco: consumidor externo do `/app/graph/meta` via `GRAPH_EXPORT_TOKEN`** (Expert Console) surpreendido pelo 304. Só ocorre se o consumidor ENVIAR `If-None-Match` — clientes existentes que não enviam continuam recebendo 200. Campo `updated_at` extra é ignorável.
- **Reversão:** mudanças são todas de código, sem migration e sem escrita em dados — `git revert` do(s) commit(s) da spec restaura o comportamento anterior integralmente. Nenhum estado persistido novo é criado (o cache HTTP vive no browser e expira sozinho em 60s).
