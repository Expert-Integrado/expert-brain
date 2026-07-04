# Brain web polish: CSS externo cacheável, bundle de config versionado, 404 não-immutable, links canônicos e filtro "hoje" em BRT

> **Status:** done · **Prioridade:** P2 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O app web do Brain (`/app/*`) roda num Cloudflare Worker. Peças relevantes:

- **CSS**: todo o tema mora em `src/web/styles.ts` (~49 KB) como a string `NEBULA_CSS`, injetada **inline** num `<style>` em três lugares:
  - `src/web/render.ts:53` (`renderShell`, todas as páginas do app)
  - `src/web/login.ts:13` (página de login)
  - `src/auth/handler.ts:56` (página de consentimento OAuth)
- **Bundles JS**: `scripts/build-bundles.ts` compila os clients (esbuild) para `assets/*.bundle.js` e gera `src/web/asset-version.ts` com `ASSET_HASHES` (sha256 truncado em 12 chars por bundle) e o helper `assetVersion(name)`. As tags `<script>` usam `?v=<hash>` (ex.: `src/web/render.ts:100`).
- **Servir bundles**: `src/web/handler.ts:76-81` define `serveBundle(asset)`, que busca do binding `env.ASSETS` e aplica `cache-control: public, max-age=31536000, immutable` (`handler.ts:75`) incondicionalmente.
- **Bundle de config**: `/app/config/bundle.js` NÃO passa pelo pipeline do esbuild — é a string retornada por `configPageScript()` (`src/web/config.ts:224`), servida em `src/web/handler.ts:111-118` com `cache-control: public, max-age=3600` e referenciada **sem `?v=`** em `src/web/config.ts:213`.
- **Kanban de tasks**: SSR em `src/web/tasks.ts` (`renderCardSSR`, linha 138) e client em `src/web/client/tasks.ts` (`cardHTML`, linha 75). A rota canônica de detalhe de task é `/app/tasks/<id>` (`handler.ts:55-56`); `handleNoteDetail` redireciona 302 de `/app/notes/<id>` para lá quando `kind === 'task'` (`src/web/notes.ts:155-157`).
- **CSP**: `htmlResponse` (`render.ts:113-122`) já tem `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`, então um `<link rel="stylesheet">` same-origin já é permitido hoje.

## Problema / Motivação

Cinco acabamentos independentes de cache e consistência:

1. **CSS inline re-baixado a cada clique** — `NEBULA_CSS` (~49 KB brutos) vai embutido no HTML de TODA página (`render.ts:53`). Navegação no app é full page load, então cada clique re-baixa o tema inteiro, que nunca é cacheado.
2. **`/app/config/bundle.js` fora do esquema de versão** — é o único bundle sem `?v=<hash>` (`config.ts:213`) e com `max-age=3600` (`handler.ts:115`). Um fix de bug nesse script demora até 1h pra chegar no browser do usuário.
3. **Erro cacheado como immutable por 1 ano** — `serveBundle` (`handler.ts:76-81`) copia o status da resposta do ASSETS e aplica `immutable` mesmo quando `r.ok === false`. Se um deploy sair sem um asset (janela de deploy, bundle esquecido), o 404 fica preso no cache do browser na URL versionada — e como a URL só muda quando o hash muda, o usuário pode ficar travado no erro.
4. **Card SSR do kanban aponta pra rota errada** — `renderCardSSR` usa `href="/app/notes/${id}"` (`tasks.ts:142` e `tasks.ts:145`), enquanto o client já usa `/app/tasks/${id}` (`client/tasks.ts:79` e `:82`). O link SSR funciona só porque `handleNoteDetail` faz um 302 extra (`notes.ts:155-157`) — round-trip desnecessário e inconsistência entre SSR e client.
5. **Filtro "Vencem hoje" na verdade é "próximas 24h"** — `passesFilter` usa `t.due_at <= now + 24 * 3600_000` (`client/tasks.ts:59`). Às 20h de hoje, uma task que vence amanhã às 15h aparece como "hoje". Diverge da semântica do `list_tasks_due_today` do MCP (dia calendário em America/Sao_Paulo).

## Objetivo

Depois do lote: nenhum clique de navegação re-baixa o CSS do tema (cache hit em `/app/styles.css`), todo JS servido pelo Worker tem URL versionada por hash de conteúdo, nenhuma resposta de erro carrega `immutable`, o card SSR linka direto pra `/app/tasks/<id>` sem 302, e o filtro "Vencem hoje" corresponde ao dia calendário em BRT.

## Design proposto

**Commit separado por item** (reversão granular). Nenhuma migration de dados envolvida.

### 1. CSS externo versionado (`/app/styles.css?v=<hash>`)

1. Em `scripts/build-bundles.ts`, após o loop de bundles, importar `NEBULA_CSS` de `../src/web/styles.js` (o script roda via `tsx`, resolve o `.ts`) e incluir no objeto `hashes` a chave `"styles.css"` com o mesmo sha256-12 do conteúdo. O arquivo gerado `src/web/asset-version.ts` passa a versionar o CSS junto dos bundles.
2. Em `src/web/handler.ts`, adicionar rota ANTES do 404 final:
   ```ts
   if (path === '/app/styles.css' && req.method === 'GET') {
     return new Response(NEBULA_CSS, {
       headers: {
         'content-type': 'text/css; charset=utf-8',
         'cache-control': 'public, max-age=31536000, immutable',
       },
     });
   }
   ```
   Servir direto do módulo (import de `./styles.js`) em vez do binding ASSETS: garante que o CSS servido é SEMPRE o do Worker deployado (zero janela de dessincronia) e a rota não depende do build copiar arquivo pra `assets/`. Rota é pública (sem sessão) de propósito — a página de login também usa o tema e CSS não carrega segredo.
3. Trocar o `<style>${NEBULA_CSS}</style>` por `<link rel="stylesheet" href="/app/styles.css?v=${assetVersion('styles.css')}">` nos três pontos: `render.ts:53`, `login.ts:13`, `auth/handler.ts:56`. `<link>` no `<head>` é render-blocking — não há FOUC, então NÃO adicionar CSS crítico inline (só considerar se, no teste manual, aparecer flash; nesse caso inline mínimo: `body{background:#070a13}`).
4. Conferir a CSP das três páginas: `htmlResponse` já permite `style-src 'self'`; validar que a página de login e a de consentimento OAuth (que montam headers próprios) também permitem `style-src 'self'` — ajustar se necessário.

### 2. `/app/config/bundle.js` versionado

1. Em `scripts/build-bundles.ts`, importar `configPageScript` de `../src/web/config.js`, e adicionar em `hashes` a chave `"config.bundle.js"` = sha256-12 de `configPageScript()`. (A função é determinística — retorna string fixa.)
   - Atenção: se o import de `config.ts` puxar dependências de runtime do Worker (env, D1), extrair `configPageScript` pra um módulo folha sem dependências (ex.: `src/web/config-script.ts`) e importar dos dois lados. Validar com `npm run build:bundles`.
2. Em `src/web/config.ts:213`, trocar por `<script src="/app/config/bundle.js?v=${assetVersion('config.bundle.js')}" defer></script>` (importar `assetVersion`).
3. Em `src/web/handler.ts:115`, trocar `'cache-control': 'public, max-age=3600'` por `'cache-control': 'public, max-age=31536000, immutable'` — agora a URL é versionada, mesmo racional dos demais bundles.

### 3. `serveBundle`: immutable só em sucesso

Em `src/web/handler.ts:76-81`:

```ts
async function serveBundle(asset: string): Promise<Response> {
  const r = await env.ASSETS.fetch(new Request(new URL(asset, url.origin)));
  const h = new Headers(r.headers);
  if (r.ok) {
    h.set('cache-control', 'public, max-age=31536000, immutable');
  } else {
    h.set('cache-control', 'no-store');
  }
  return new Response(r.body, { status: r.status, headers: h });
}
```

(Remover a const `bundleHeaders` da linha 75 ou adaptá-la.) Assim um 404/5xx transitório de deploy nunca fica preso no cache do browser.

### 4. Card SSR do kanban com link canônico

Em `src/web/tasks.ts`, `renderCardSSR` (linha 138): trocar os DOIS hrefs `/app/notes/${esc(v.id)}` (linhas 142 e 145) por `/app/tasks/${esc(v.id)}` — idêntico ao que `cardHTML` do client já faz (`client/tasks.ts:79` e `:82`). O redirect em `notes.ts:155-157` PERMANECE (links antigos do MCP/notas continuam funcionando); só deixa de ser exercitado pelo board.

### 5. Filtro "Vencem hoje" = dia calendário em America/Sao_Paulo

Em `src/web/client/tasks.ts`, adicionar helper (client-side, sem libs — `Intl` nativo):

```ts
// Fim do dia calendário corrente em America/Sao_Paulo, em epoch ms.
function endOfDayBRT(now: number): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsedMs = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000;
  return now + (86_400_000 - elapsedMs) - 1;
}
```

E em `passesFilter` (linha 59), trocar:

```ts
if (filter === 'today') return t.due_at <= now + 24 * 3600_000;
```

por:

```ts
if (filter === 'today') return t.due_at <= endOfDayBRT(now);
```

`now` continua vindo de `board.now` (relógio do servidor, `tasks.ts:86`) — o cálculo fica imune a relógio local errado. Semântica final: task com `due_at` até 23:59:59 BRT de hoje (incluindo atrasadas) — alinhada ao `list_tasks_due_today` do MCP. O filtro `week` (linha 60) fica como está (janela relativa é aceitável pra "esta semana"; mudar seria outro escopo).

## Fora de escopo

- Redesign visual, refatoração do `NEBULA_CSS` ou split de CSS por página.
- Mudanças de CSP (só validação de que `style-src 'self'` já cobre o `<link>`).
- Mudar o filtro "Esta semana" pra semana-calendário.
- Mudar a semântica de `?scope=due&horizon_hours=N` do endpoint `/app/tasks/data` (consumido por API — comportamento contratual).
- Service worker (`assets/sw.js`) e `assets/_headers` — pipeline de assets estáticos não muda.

## Critérios de aceite

- [ ] `GET /app/styles.css` responde 200, `content-type: text/css`, `cache-control: public, max-age=31536000, immutable`, e o corpo é o `NEBULA_CSS` atual.
- [ ] HTML de `/app/notes`, `/app/login` e da página de consentimento OAuth contém `<link rel="stylesheet" href="/app/styles.css?v=...">` e NÃO contém mais o bloco `<style>` com o tema inteiro (HTML por página cai ~49 KB).
- [ ] Navegar entre páginas do app com DevTools aberto mostra `styles.css` vindo do disk/memory cache (sem novo download) e nenhuma quebra de estilo/FOUC.
- [ ] `src/web/asset-version.ts` gerado contém as chaves `styles.css` e `config.bundle.js`; rodar `npm run build:bundles` duas vezes sem mudar código produz hashes idênticos.
- [ ] Página `/app/config` referencia `/app/config/bundle.js?v=<hash>` e a resposta vem com `immutable`; alterar `configPageScript()` e rebuildar muda o `?v=`.
- [ ] Requisição a uma rota de bundle cujo asset não existe (simulável apontando `serveBundle` pra um path inexistente em teste) responde com `cache-control: no-store`; bundles existentes seguem `immutable`.
- [ ] HTML SSR de `/app/tasks` contém `href="/app/tasks/<id>"` nos cards (título e "abrir") e nenhuma ocorrência de `/app/notes/<id>` em `renderCardSSR`; clicar num card não gera 302.
- [ ] Com relógio simulado às 20h BRT e task vencendo amanhã 15h BRT: filtro "Vencem hoje" NÃO a exibe; task vencendo hoje 23h BRT e task atrasada de ontem SÃO exibidas.
- [ ] `npm run typecheck` e `npm test` passam.

## Validação

```bash
npm run build:bundles   # gera asset-version.ts com styles.css + config.bundle.js
npm run typecheck       # tsc worker + tsc client
npm test                # vitest run (2 configs)
npx wrangler dev        # teste manual local
```

Teste manual (wrangler dev): login → navegar Grafo/Notas/Tarefas/Config checando Network (styles.css cacheado, sem FOUC); board de tasks → clicar card (URL vai direto pra `/app/tasks/<id>`, sem 302 no Network); filtro "Vencem hoje" com uma task de amanhã criada via MCP. Testar também a página de login deslogado e o fluxo de consentimento OAuth (tema íntegro).

**Deploy (`npm run deploy`) SOMENTE com OK explícito do dono do repo.**

## Arquivos afetados

- `scripts/build-bundles.ts` — hash de `styles.css` e `config.bundle.js` no `ASSET_HASHES`
- `src/web/asset-version.ts` — regenerado (auto)
- `src/web/handler.ts` — rota `/app/styles.css`; `serveBundle` condicional em `r.ok`; headers do `/app/config/bundle.js`
- `src/web/render.ts` — `<link>` no lugar do `<style>` inline
- `src/web/login.ts` — idem
- `src/auth/handler.ts` — idem
- `src/web/config.ts` — `?v=` no script da página (e possível extração de `configPageScript` pra módulo folha)
- `src/web/tasks.ts` — hrefs canônicos em `renderCardSSR`
- `src/web/client/tasks.ts` — helper `endOfDayBRT` + filtro `today`

## Riscos e reversao

- **Lote seguro, sem gate e sem dados** — nenhuma escrita em D1/Vectorize/R2; tudo é serving de HTML/CSS/JS. Rollback por item: cada item é um commit — `git revert <sha>` do commit específico + `npm run deploy`.
- **Risco item 1**: página sem estilo se a rota `/app/styles.css` falhar ou a CSP de login/OAuth não permitir `style-src 'self'`. Mitigação: validar as três páginas no wrangler dev antes do deploy. Reversão: revert do commit devolve o `<style>` inline.
- **Risco item 2**: browsers com o `/app/config/bundle.js` antigo (sem `?v=`) em cache por até 1h após o deploy — janela curta e o script antigo continua funcional; expira sozinho.
- **Risco item 5**: `Intl.DateTimeFormat` com `timeZone` é suportado em todos os browsers-alvo (ES2020+); se `formatToParts` falhar, o pior caso é o filtro voltar ao comportamento de janela — aceitável e revertível por commit.
- Hashes em `asset-version.ts` são gerados no build: esquecer `npm run build:bundles` antes do deploy serviria `?v=` velho com conteúdo novo (cache busting atrasado). O script `deploy` do `package.json` já encadeia `build:bundles && wrangler deploy` — usar sempre `npm run deploy`.
