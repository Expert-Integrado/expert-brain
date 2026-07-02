# Brain web: reviver botões bloqueados pela CSP e dar erro visível quando a sessão expira

> **Status:** done · **Prioridade:** P0 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O app web (`/app/*`) é server-rendered com bundles client compilados por esbuild:

- Toda resposta HTML sai por `htmlResponse()` em `src/web/render.ts:104-129`, que envia uma CSP estrita: `script-src 'self'` — **sem** `'unsafe-inline'` e **sem** `script-src-attr`. Ou seja, atributos `onclick="..."` inline NUNCA executam, em nenhum browser moderno (o browser loga violação de CSP no console e ignora o handler).
- Bundles client vivem em `src/web/client/*.ts` e são compilados por `scripts/build-bundles.ts` (`npm run build:bundles`) para `assets/*.bundle.js`, servidos pelas rotas `/app/<área>/bundle.js` em `src/web/handler.ts:83-103` com cache-busting por hash (`src/web/asset-version.ts`).
- Esse exato problema (handler inline morto por CSP) já foi corrigido uma vez: o `onclick="this.select()"` do campo key-flash da página de config virou wiring por `addEventListener` dentro de `configPageScript()` (`src/web/config.ts:224-268`, ver comentário nas linhas 260-261). Esse é o padrão da casa.
- Sessão de browser: cookie `mv_session` (HMAC, TTL de 7 dias — `src/web/session.ts:1`). `requireSession()` (`src/web/session.ts:87-102`) devolve, pra QUALQUER request sem sessão válida, um `302` pra `/app/login?next=...` (linhas 94-97).
- Os clients fazem `fetch()` de dados/mutações: board de tasks (`src/web/client/tasks.ts` — `load()` linha 46, `setStatus()` linha 121, `complete()` linha 136), lista de notas (`src/web/client/notes.ts` — linhas 44 e 84), palette do shell (`src/web/client/shell.ts` — linhas 69 e 235) e mídia (`src/web/client/note-media.ts` — linhas 35, 71 e 87).
- A página de detalhe de nota (`handleNoteDetail`, `src/web/notes.ts`) e a de detalhe de task (`handleTaskDetail`, `src/web/notes.ts:269`) já carregam o bundle `media.bundle.js` (`src/web/notes.ts:250` e `:327`), cujo entry é `src/web/client/note-media.ts`.
- Endpoints de tasks aceitam Bearer OU sessão via `authTask()` (`src/web/tasks.ts:27-31` + `src/web/bearer-auth.ts`) — o caminho Bearer não muda nesta spec.

## Problema / Motivação

Dois defeitos ativos de produção:

1. **Dois botões mortos por CSP (regressão do mesmo bug já corrigido na config):**
   - `src/web/notes.ts:214` — botão "Copiar link" do detalhe de nota usa `onclick` inline. Nunca executa: clicar não faz nada em nenhum browser.
   - `src/web/notes.ts:304` — botão "✓ concluir" do detalhe de task usa `onclick` inline pra POSTar em `/app/tasks/complete`. Também morto.
   - O comentário em `src/web/notes.ts:301-302` é **enganoso**: afirma que "CSP do app permite handler inline". Não permite (`script-src 'self'` sem `'unsafe-inline'`/`script-src-attr`, ver `src/web/render.ts:115`). O comentário induziu a regressão e precisa ser corrigido junto.
   - `grep -rn "onclick=" src/web --include=*.ts` (fora de `client/` e testes) confirma que esses são os únicos dois handlers inline restantes no HTML server-rendered.

2. **Sessão expirada vira sucesso falso silencioso:**
   - `requireSession()` (`src/web/session.ts:94-100`) responde `302 → /app/login` pra todo request sem sessão, inclusive `fetch()` de dados. O `fetch` do browser **segue o redirect** e recebe a página de login com status `200` — `res.ok === true`.
   - Cenário real (TTL de 7 dias com tab aberta): usuário clica "✓ concluir" no board (`src/web/client/tasks.ts:136-147`), o POST em `/app/tasks/complete` "passa" (`res.ok` true na página de login), o client acha que concluiu; o `load()` seguinte recebe HTML de login, o `res.json()` falha, cai no `catch` que só faz `console.warn` (`tasks.ts:50-52`) e o board congela sem NENHUM erro visível. A task não foi concluída e o usuário não fica sabendo.
   - Mesmo padrão de falha silenciosa em `client/notes.ts:48-51`, `client/shell.ts:82-84` e `client/note-media.ts:36`.

## Objetivo

Os botões "Copiar link" (detalhe de nota) e "✓ concluir" (detalhe de task) funcionam com a CSP estrita intacta, e qualquer `fetch` do app com sessão expirada recebe `401 JSON` e redireciona o usuário pra `/app/login?next=<página atual>` — zero sucesso falso.

## Design proposto

### 1. Mover os dois handlers inline pra bundle (mesmo padrão do `configPageScript`)

Os dois botões vivem em páginas que **já carregam** `media.bundle.js` (entry `src/web/client/note-media.ts`), então o wiring vai nesse bundle — sem rota nova, sem entry novo no `scripts/build-bundles.ts`.

a) Em `src/web/notes.ts:214` (detalhe de nota), remover o atributo `onclick` inteiro. O botão fica só com `id="btn-copy-link"` (que já tem) + o `style` atual:

```html
<button id="btn-copy-link" style="...">Copiar link</button>
```

b) Em `src/web/notes.ts:303-305` (detalhe de task), remover o `onclick` e passar o id da task por data-attribute:

```html
<button type="button" class="task-d-btn task-d-complete"
        data-task-complete data-task-id="${esc(task.id)}">✓ concluir</button>
```

c) Em `src/web/client/note-media.ts`, adicionar wiring guardado por existência do elemento (roda nas duas páginas; cada bloco só age se o elemento existir):

- `#btn-copy-link`: `addEventListener('click', ...)` → `navigator.clipboard.writeText(location.href)` com feedback "Link copiado!" por 2s (mesma UX do inline atual). Reusar o fallback de `copyText` do `configPageScript` (textarea + `execCommand`) pra contexts sem `navigator.clipboard`.
- `[data-task-complete]`: `addEventListener('click', ...)` → desabilita o botão, texto "concluindo...", `POST /app/tasks/complete` com `{ id: btn.dataset.taskId }` (mesmos headers/`credentials` do inline atual), sucesso → `location.href = '/app/tasks'`, falha → reabilita + `alert('Falha ao concluir')`.

d) Corrigir o comentário enganoso em `src/web/notes.ts:301-302`: o novo texto deve dizer que a CSP (`script-src 'self'`, `src/web/render.ts:115`) **bloqueia** handler inline e que o wiring vive em `client/note-media.ts`.

**NÃO afrouxar a CSP** — nada de `'unsafe-inline'`, `script-src-attr` ou nonce. A correção é mover o código, não abrir a política.

### 2. `requireSession`: 401 JSON pra requests de dados

Em `src/web/session.ts:87-102`, antes de montar o `redirect`, classificar o request:

```ts
function isDataRequest(req: Request, url: URL): boolean {
  if ((req.headers.get('accept') || '').includes('application/json')) return true;
  if (req.method !== 'GET' && /\/(data|status|complete|link|prefs|media)(\/|$)/.test(url.pathname)) return true;
  return false;
}
```

Quando `isDataRequest` for true e não houver sessão válida, devolver:

```ts
new Response(JSON.stringify({ error: 'session expired' }), {
  status: 401,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})
```

Caso contrário, manter o `302 → /app/login?next=...` atual (navegação de página e form POSTs — ex.: `/app/api-keys/create` — continuam com o fluxo de login intacto). O caminho Bearer (`authorizeBearer`, chamado ANTES de `requireSession` em `src/web/tasks.ts:28` e `src/web/media.ts:17`) não é tocado.

### 3. Clients: helper `appFetch` com accept JSON + tratamento de 401

Criar `src/web/client/http.ts` (módulo compartilhado, esbuild inclui em cada bundle que importar):

```ts
export async function appFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  const res = await fetch(input, { credentials: 'same-origin', ...init, headers });
  if (res.status === 401) {
    location.href = '/app/login?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('session expired');
  }
  return res;
}
```

Trocar os `fetch()` de dados por `appFetch()` em:

- `src/web/client/tasks.ts` — `load()` (linha 46), `setStatus()` (linha 121), `complete()` (linha 136)
- `src/web/client/notes.ts` — fetch de `/app/graph/meta` (linha 44) e `/app/search` (linha 84)
- `src/web/client/shell.ts` — `loadNotes()` (linha 69) e `searchNotes()` (linha 235)
- `src/web/client/note-media.ts` — list/upload/delete (linhas 35, 71, 87) e o novo handler do botão concluir (item 1c)

O header `accept: application/json` garante que até os GETs de dados caiam no ramo 401 do item 2 (sem ele, o fetch do browser manda `*/*` e receberia o 302).

Sem mudança de banco: **nenhuma migration** nesta spec.

## Fora de escopo

- Refresh/renovação automática de sessão (sliding TTL).
- Transformar o app em SPA ou trocar o modelo SSR + bundles.
- Afrouxar a CSP (`unsafe-inline`, nonce, `script-src-attr`).
- Mudar o fluxo Bearer (`GRAPH_EXPORT_TOKEN` / `TASK_REMINDER_TOKEN`) ou o fluxo de login/logout.
- Toast/UI de erro mais sofisticada que o redirect pro login (fica pra spec futura de feedback de erro global).

## Critérios de aceite

- [ ] `grep -rn "onclick=" src/web --include=*.ts` não retorna nenhum handler inline em HTML server-rendered (só menções em comentário, se houver).
- [ ] Detalhe de nota: clicar em "Copiar link" copia a URL e mostra "Link copiado!" por ~2s, sem violação de CSP no console.
- [ ] Detalhe de task (status `open` ou `in_progress`): clicar em "✓ concluir" conclui a task e navega pra `/app/tasks`; a task aparece na coluna "Concluído".
- [ ] O comentário em `src/web/notes.ts` (antigas linhas 301-302) não afirma mais que a CSP permite handler inline.
- [ ] A CSP em `src/web/render.ts` permanece byte a byte igual (`script-src 'self'`, sem `unsafe-inline`).
- [ ] `requireSession` devolve `401` com body JSON `{"error":"session expired"}` pra request sem sessão com `accept: application/json`, e pra método != GET em rota casando `/data|/status|/complete|/link|/prefs|/media`.
- [ ] `requireSession` continua devolvendo `302 → /app/login?next=...` pra GET de página sem sessão (ex.: `GET /app/notes` com `accept: text/html`).
- [ ] Teste automatizado novo em `src/web/session.test.ts` cobrindo os dois ramos (401 JSON e 302) — passa em `npm test`.
- [ ] Com cookie de sessão removido/expirado, clicar "✓ concluir" no board `/app/tasks` redireciona pra `/app/login?next=%2Fapp%2Ftasks` em vez de "passar" silenciosamente; a task NÃO é marcada como concluída.
- [ ] Requests com Bearer válido em `/app/tasks/data|status|complete` e `/app/notes/:id/media` seguem funcionando sem cookie (caminho `authorizeBearer` intacto).
- [ ] `npm run typecheck` e `npm test` passam.

## Validação

```bash
npm run typecheck        # tsc do worker + tsc dos clients (src/web/client/tsconfig.json)
npm test                 # vitest run && vitest run --config vitest.auth.config.ts
npm run build:bundles    # regenera assets/*.bundle.js + src/web/asset-version.ts
npx wrangler dev         # teste manual local
```

Teste manual (em `wrangler dev` logado):
1. Abrir detalhe de uma nota → clicar "Copiar link" → colar em outro lugar e conferir a URL; console sem erro de CSP.
2. Abrir detalhe de uma task aberta → "✓ concluir" → volta pro board com a task em "Concluído".
3. DevTools → Application → apagar o cookie `mv_session` → clicar "✓ concluir" em outra task no board → deve cair em `/app/login?next=%2Fapp%2Ftasks`; após login, conferir que a task continua aberta.
4. `curl -s -o /dev/null -w "%{http_code}" -H "accept: application/json" http://localhost:8787/app/tasks/data` → `401` (sem cookie); sem o header accept e via navegação, `GET /app/tasks` → `302`.

Deploy (`npm run deploy`) SOMENTE com OK explícito do dono do repo.

## Arquivos afetados

- `src/web/notes.ts` — remove os dois `onclick` inline (linhas 214 e 304) + corrige comentário (301-302)
- `src/web/session.ts` — `requireSession` com ramo 401 JSON pra requests de dados
- `src/web/client/note-media.ts` — wiring do copy-link e do botão concluir do detalhe; adota `appFetch`
- `src/web/client/tasks.ts` — adota `appFetch` (load/setStatus/complete)
- `src/web/client/notes.ts` — adota `appFetch` (meta/search)
- `src/web/client/shell.ts` — adota `appFetch` (loadNotes/searchNotes)
- `src/web/client/http.ts` — NOVO: helper `appFetch` compartilhado
- `src/web/session.test.ts` — testes do 401 JSON vs 302
- `assets/*.bundle.js` + `src/web/asset-version.ts` — regenerados por `npm run build:bundles` (não editar à mão)

## Riscos e reversão

**Riscos:**
- Falso-positivo de 401 em algum consumidor que envie `accept: application/json` esperando redirect — mitigado porque todo consumidor JSON conhecido (bundles do app, Bearer da VPS/Console) ou já trata status não-2xx ou autentica antes de `requireSession`.
- Regex de rota de dados capturar rota futura que preferisse 302 — o ramo só dispara pra método != GET, e navegação de browser é GET; risco residual baixo.
- Esquecer `npm run build:bundles` antes do deploy serviria bundles velhos — o `npm run deploy` já encadeia o build; hash em `asset-version.ts` denuncia divergência no code review.

**Reversão:** mudança é 100% código de aplicação, sem migration e sem alteração de dado — rollback é `git revert` do(s) commit(s) da spec + `npm run deploy`. O comportamento anterior (botões mortos + 302 silencioso) volta imediatamente; nenhum dado precisa ser restaurado.
