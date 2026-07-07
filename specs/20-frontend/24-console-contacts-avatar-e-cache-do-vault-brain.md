# Console contacts: consertar avatares 401 e cache do meta/grafo do vault brain

> **Status:** done (07/07/2026 — Parte A shipada: espelho GET /app/media/:hash atrás da sessão + rewrite no client; DESVIO: o payload segue emitindo /media/<hash> canônico e cada UI reescreve — o client do Brain já dependia do prefixo /media/. Partes B/C: mitigadas pela spec 20-frontend/26 (cache/escala no servidor do Brain); o console standalone é secundário ao Console v2 do Brain — staleness de até 1h no vault brain de lá aceita e registrada) · **Prioridade:** P1 · **Esforço:** S · **Repo:** expert-contacts
> **Depende de:** nenhuma

## Contexto

O Worker `expert-contacts` (Cloudflare Workers + D1 + R2 + KV) co-hospeda o Expert Console sob `/app*` e expõe a API de entidades na raiz. Três peças relevantes:

1. **Mídia (avatares).** Uploads vão pro R2 via `POST /attach_media` (`src/index.ts:466-502`) e são servidos por `GET /media/:hash` (`src/index.ts:504-516`, roteado em `src/index.ts:727-729`). Essa rota fica DEPOIS do gate `requireAuth` (`src/index.ts:693-694`), que exige `Bearer OWNER_TOKEN` (ou `CONTACTS_PROXY_TOKEN` em GET). O painel de detalhe do Console monta a URL do avatar como `/media/<hash>` em dois lugares: `avatarImg()` (`src/vaults/contacts.ts:88-91`, usado nos nodes do grafo em `contacts.ts:286`) e `fetchEntity` (`src/vaults/contacts.ts:501`). O client renderiza como `<img src>` puro (`src/web/client/detail.ts:250-255`).
2. **Sessão do Console.** Cookie `eb_session` assinado por HMAC, emitido com `Path=/app` (`src/web/session.ts:71`), verificado por `requireSession` (`src/web/session.ts:87-102`). Ou seja: o cookie NEM é enviado pelo browser em requisições fora de `/app/*`.
3. **Vault brain.** O adapter remoto `brainAdapter` (`src/vaults/brain.ts`) baixa o grafo COMPLETO do Worker do Expert Brain via service binding `env.BRAIN` + `Bearer VAULT_BRAIN_TOKEN` (`src/vaults/brain.ts:81-101`). O payload do Brain já traz `sourceHash` (`src/vaults/brain.ts:65`), computado no Brain por `computeSourceHash` (`(expert-brain) src/web/graph-data.ts:45-59` — 3 queries D1 baratas de agregados). A camada de cache do Console (`src/web/graph-api.ts`) usa chave `graph:<vault>:<sourceHash>:<paramsKey>` com TTL 1h (`src/web/graph-api.ts:23,85`), mas `vaultSourceHash` devolve a constante `'na'` pra qualquer vault que não seja contacts (`src/web/graph-api.ts:56-59`).

## Problema / Motivação

Três defeitos correlatos no Console:

1. **`media-401-console-avatar` — avatar do painel SEMPRE quebrado.** O `<img>` do painel aponta pra `/media/<hash>` (`src/vaults/contacts.ts:91` e `:501`), mas:
   - a rota `/media/:hash` exige Bearer (`src/index.ts:693-694` + `requireAuth` em `src/index.ts:69-78`), que um `<img>` de browser não envia;
   - o cookie de sessão do Console tem `Path=/app` (`src/web/session.ts:71`), então nem chega na requisição — e mesmo que chegasse, `requireAuth` não valida sessão.
   Resultado: toda imagem de avatar responde 401 e o painel renderiza ícone quebrado, sempre.
2. **`meta-brain-sem-cache` — meta do brain re-serializa o grafo inteiro a cada palette.** `handleGraphMeta` (`src/web/graph-api.ts:116-148`) tem caminho leve só pro contacts (`contactsMeta`, linha 124-127); qualquer outro vault cai no fallback `adapter.fetchGraph(env, {})` (linha 129-132), que no brain significa baixar e desserializar o grafo COMPLETO (~1.8k notas + ~10k arestas) via service binding (`src/vaults/brain.ts:91-101`) — sem passar pelo cache KV do `handleGraphData`. O client chama `/app/graph/meta` em 3 pontos (`src/web/client/console.ts:92`, `src/web/client/graph.ts:274`, `src/web/client/detail.ts:200`), então cada load/troca de vault/palette paga o download completo de novo.
3. **`console-brain-vault-stale-1h` — nota nova no Brain demora até 1h pra aparecer no Console.** Como `vaultSourceHash` devolve `'na'` pro brain (`src/web/graph-api.ts:58`), a chave de cache do payload nunca muda por escrita — só o TTL de 1h (`src/web/graph-api.ts:23`) derruba a entrada. No vault contacts a auto-invalidação por escrita funciona (hash entra na chave); no brain não existe.

## Objetivo

Avatar do painel de contato carrega (200, imagem visível) usando a sessão do Console, e o vault brain no Console passa a refletir escrita nova no Brain em ≤ 5 min com `/app/graph/meta` respondendo de cache (sem re-download do grafo completo a cada chamada).

## Design proposto

### Parte A — rota espelho `/app/media/:hash` atrás da sessão

Decisão registrada: NÃO tornar `/media/:hash` público. Embora o hash sha256 funcione como capability URL (não-enumerável), a rota raiz é da API autenticada e abri-la mudaria a postura de segurança de um repo open-source. A rota espelho sob `/app/*` reaproveita o gate de sessão existente e o cookie `Path=/app` passa a ser enviado naturalmente.

1. **Exportar o handler de mídia.** Em `src/index.ts`, trocar `async function handleGetMedia(...)` (`src/index.ts:504`) por `export async function handleGetMedia(...)` (sem mudar o corpo — loop de extensões e headers ficam iguais).
2. **Nova rota no router do Console.** Em `src/web/handler.ts`, na seção pós-`requireSession` (depois da linha 97), adicionar:
   ```ts
   // Mídia (avatares) atrás da sessão — espelho de GET /media/:hash da API.
   const mediaMatch = path.match(/^\/app\/media\/([0-9a-f]{64})$/i);
   if (mediaMatch && method === 'GET') return handleGetMedia(mediaMatch[1], env);
   ```
   com o import `import { handleGetMedia } from '../index.js'` — se isso criar ciclo de import (`index.ts` importa `handler.ts`), mover `handleGetMedia` pra um módulo novo `src/media.ts` importado pelos dois (mudança puramente mecânica, sem alterar comportamento).
3. **Apontar as URLs pro espelho.** Em `src/vaults/contacts.ts`:
   - `avatarImg()` (`contacts.ts:91`): `/media/${m[1]}` → `/app/media/${m[1]}` (atualizar também o comentário em `contacts.ts:87` e em `src/vaults/types.ts:27`);
   - `fetchEntity` (`contacts.ts:501`): `/media/${avatar.content_hash}` → `/app/media/${avatar.content_hash}`.
   NÃO tocar nas URLs da API REST (`src/index.ts:316,331,501`) — consumidores por Bearer (MCP/scripts) continuam usando `/media/:hash`.
4. A rota original `/media/:hash` permanece intacta (aditivo, zero breaking change).

### Parte B — cache do `/app/graph/meta` do brain em KV

Em `src/web/graph-api.ts`, no ramo não-contacts de `handleGraphMeta` (linhas 128-133):

1. Antes do `fetchGraph`, tentar `env.CACHE.get('meta:' + vault, 'json')`; hit → responder direto (mesmo shape `{ list, counts }`).
2. Miss → manter o fallback `adapter.fetchGraph(env, {})`, derivar `list`/`counts` como hoje e gravar `env.CACHE.put('meta:' + vault, JSON.stringify({ list, counts }), { expirationTtl: 300 })` (TTL 5 min, alinhado com a staleness-alvo da Parte C).
3. Não cachear quando `list.length === 0` (mesma filosofia do `handleGraphData`, `graph-api.ts:102-103`).
4. Erros de KV são não-fatais (try/catch com `console.error`, padrão das linhas 88-93).

### Parte C — `sourceHash` real pro brain (endpoint `/app/graph/hash` no Brain)

Gate aceito: esta parte toca os DOIS repos — 1 commit em `expert-brain` + 1 commit em `expert-contacts`.

1. **(expert-brain)** Em `src/web/graph-data.ts`, novo handler exportado:
   ```ts
   // GET /app/graph/hash — só o sourceHash (3 agregados D1), pra caches remotos
   // (Expert Console) comporem chave de cache sem baixar o payload inteiro.
   export async function handleGraphHash(req: Request, env: Env): Promise<Response> {
     if (!authorizeGraphExport(req, env)) {
       const session = await requireSession(req, env);
       if (!session.ok) return session.response;
     }
     return Response.json({ sourceHash: await computeSourceHash(env) }, { headers: { 'cache-control': 'no-store' } });
   }
   ```
   Reusa `computeSourceHash` (`graph-data.ts:45-59`) e o mesmo padrão de auth de `handleGraphData` (`graph-data.ts:191-194`). Rota em `(expert-brain) src/web/handler.ts`, junto das outras `/app/graph/*` (após a linha 68): `if (path === '/app/graph/hash' && req.method === 'GET') return handleGraphHash(req, env);`.
2. **(expert-contacts)** Em `src/vaults/brain.ts`, exportar:
   ```ts
   // Hash leve da fonte do Brain (GET /app/graph/hash). Falha → 'na' (cache cai só por TTL).
   export async function brainSourceHash(env: Env): Promise<string> {
     try {
       const res = await brainFetch(env, '/app/graph/hash');
       if (!res.ok) return 'na';
       const data = (await res.json()) as { sourceHash?: string };
       return data.sourceHash || 'na';
     } catch { return 'na'; }
   }
   ```
3. **(expert-contacts)** Em `src/web/graph-api.ts:56-59`, `vaultSourceHash` passa a rotear: `if (vault === brainAdapter.id) return brainSourceHash(env);` (mantém `'na'` pra vaults futuros). Atualizar o comentário das linhas 52-55.
4. **Ordem de deploy:** Brain PRIMEIRO (endpoint novo é aditivo), Console depois. Enquanto o Brain não tiver a rota, `brainSourceHash` devolve `'na'` (404 → fallback) — comportamento idêntico ao atual, sem janela de quebra.
5. Com o hash real na chave, o TTL de 1h pode ficar como está (o hash muda a chave a cada escrita no Brain; a chamada de hash custa 3 agregados D1 + 1 hop de service binding, ordens de grandeza mais barato que o payload). Opcionalmente invalidar/regravar `meta:brain` (Parte B) quando o `handleGraphData` detectar miss por hash novo — não obrigatório: o TTL de 5 min do meta já limita a staleness da palette.

Sem migrations, sem mudança de schema — tudo aditivo (rotas novas + chaves KV novas).

## Fora de escopo

- Mudanças no renderer do grafo (`src/web/client/graph.ts`) — consome os mesmos payloads.
- Escopo/allowlist da auth da API REST (`requireAuth`, `CONTACTS_PROXY_TOKEN`) — coberto pela spec `10-backend/24-contacts-tokens-api-escopo.md`.
- Tornar `/media/:hash` público ou assinar URLs de mídia.
- Busca semântica/params no endpoint de grafo do Brain (segue devolvendo o grafo completo).
- Avatares pros nós do CANVAS do brain (Brain não tem mídia por nó nesse payload).

## Critérios de aceite

- [ ] `GET /app/media/<hash-válido>` com cookie de sessão do Console responde 200 com `content-type` de imagem; sem sessão responde 302 pra `/app/login`.
- [ ] `GET /media/<hash>` sem Bearer segue respondendo 401 (rota antiga intacta) e com `Bearer OWNER_TOKEN` segue 200.
- [ ] Painel de detalhe de um contato com avatar renderiza a imagem (sem ícone quebrado); `EntityDetail.img` e `GraphNode.img` começam com `/app/media/`.
- [ ] `GET /app/graph/meta?vault=brain` duas vezes seguidas: a segunda responde de cache KV (`meta:brain`) sem chamar `adapter.fetchGraph` (verificável por log/`x-cache` ou por tempo de resposta).
- [ ] `GET /app/graph/hash` no Brain responde `{ "sourceHash": "n..." }` com Bearer `GRAPH_EXPORT_TOKEN` ou sessão, e 401/302 sem ambos.
- [ ] `vaultSourceHash(env, 'brain')` devolve o hash real; após uma escrita no Brain (nota nova), a chave `graph:brain:*` muda e o próximo `/app/graph/data?vault=brain` é MISS → nota aparece no Console em ≤ 5 min (limitado pelo TTL do meta), não mais até 1h.
- [ ] Brain fora do ar ou sem a rota `/app/graph/hash`: Console degrada pro comportamento atual (`'na'`, cache por TTL) sem erro 500.
- [ ] Zero mudança de schema D1/R2; nenhuma chave KV existente é reinterpretada (só chaves novas `meta:*`).

## Validação

Nos dois repos (cada um na sua pasta):

```bash
npm run typecheck   # (ou npx tsc --noEmit, conforme scripts do package.json)
npx vitest run
```

Testes a adicionar/ajustar:
- `expert-contacts`: teste do router pra `GET /app/media/:hash` (302 sem sessão, 200 com sessão + MEDIA mock); teste do `handleGraphMeta` brain com KV hit/miss; teste do `vaultSourceHash` roteando pro `brainSourceHash` e caindo pra `'na'` em erro.
- `expert-brain`: teste do `/app/graph/hash` em `src/web/graph.test.ts` (auth + shape + hash muda após escrita — reusar os fixtures existentes de `sourceHash`).

Teste manual (preview/local com `wrangler dev`): abrir o Console, clicar num contato com avatar (imagem carrega), trocar pro vault brain (palette rápida no 2º load), criar nota no Brain e confirmar que aparece no Console em ≤ 5 min.

Deploy (Brain primeiro, Console depois) SOMENTE com OK explícito do dono.

## Arquivos afetados

- `src/index.ts` — export do `handleGetMedia` (ou extração pra `src/media.ts`)
- `src/web/handler.ts` — rota `GET /app/media/:hash` atrás da sessão
- `src/vaults/contacts.ts` — `avatarImg()` e `fetchEntity` apontando pra `/app/media/`
- `src/vaults/types.ts` — comentário do campo `img`
- `src/web/graph-api.ts` — cache KV `meta:<vault>` no `handleGraphMeta` + `vaultSourceHash` roteando pro brain
- `src/vaults/brain.ts` — `brainSourceHash()` novo
- `(expert-brain) src/web/graph-data.ts` — `handleGraphHash` novo
- `(expert-brain) src/web/handler.ts` — rota `GET /app/graph/hash`
- Testes: `expert-contacts` (router/graph-api) e `(expert-brain) src/web/graph.test.ts`

## Riscos e reversao

- **Ciclo de import `index.ts` ↔ `handler.ts`** ao exportar `handleGetMedia`: mitigar extraindo pra módulo próprio (`src/media.ts`). Risco baixo, detectado no typecheck/bundle.
- **Meta stale por até 5 min** (Parte B): aceitável e alinhado com a staleness-alvo; se incomodar, reduzir o TTL da chave `meta:*` (número num único lugar).
- **Custo extra de 1 chamada de hash por `graph/data` do brain**: 3 agregados D1 + service binding — desprezível vs. o payload completo; em caso de latência inesperada, reverter só o item C.3 (`vaultSourceHash` volta a `'na'`).
- **Rollback:** tudo é aditivo. `git revert` do commit no `expert-contacts` restaura URLs `/media/` e o fallback `'na'`; o endpoint `/app/graph/hash` no Brain pode ficar no ar sem consumidor (inofensivo) ou ser revertido no próprio repo. Chaves KV `meta:*` órfãs expiram sozinhas pelo TTL. Nenhum dado de D1/R2 é tocado.
