# Compartilhamento público read-only de nota por token (/s/&lt;token&gt;)

> **Status:** done (07/07/2026) · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `30-features/31-selo-de-privacidade.md` (done)

> **Nota (04/07/2026):** o compartilhamento público shipou PRIMEIRO pra TASKS, com design mais simples que o desta spec — colunas `share_token`/`share_expires_at` na própria `notes` (migration runtime `0008_share_task`), módulo `src/web/share.ts`, página `/s/<token>` e tools MCP `share_task`/`unshare_task`. A UI de compartilhamento no console vive em `50-console-v2/52`; comentários de convidado na página pública, em `50-console-v2/53`. Esta spec permanece como referência pra estender o share a NOTAS de conhecimento (tabela dedicada, `include_media`); ao executá-la, reconciliar com o que já shipou — provavelmente convergindo pro mesmo trilho de `share.ts`.

> **Execução (07/07/2026, onda E12):** RECONCILIADA — convergiu no trilho de `share.ts` em vez da tabela `share_tokens` dedicada proposta abaixo. O que shipou:
>
> - `createShare`/`resolveShare`/`revokeShare`/`getShareStatus` generalizados pra QUALQUER nota viva não-privada (task ou conhecimento) — sem tabela nova; migration `0016_share_note_media` só adiciona `notes.share_include_media` (opt-in de mídia POR share, default 0).
> - Página pública de NOTA (`renderNoteSharePage`): título, tldr, tipo, áreas, corpo escapado (wikilinks viram span), mídia opt-in — SEM comentários (comentário público é feature de task, spec 53; POST `/s/<token>/comment` em share de nota → 404).
> - Proxy de mídia `GET /s/<token>/media/<id>`: só com `share_include_media=1`, só mídia da nota do share, `no-store` — zero signed URL/key R2 no HTML (item 5 da spec, como desenhado).
> - Rate-limit best-effort 30 req/min por IP (hasheado) em TODOS os GETs de `/s/*`, KV GRAPH_CACHE, fail-open (item 7).
> - Fail-closed: `setNotePrivate(priv=1)` agora revoga o share na MESMA escrita (igual `setTaskPrivate`).
> - UI logada no detalhe da nota (seção Compartilhamento com checkbox "incluir mídia"), endpoints `/app/notes/share|unshare` (aliases dos handlers de task, generalizados), wiring client extraído pra `src/web/client/share-ui.ts` (compartilhado task/nota).
> - Divergências deliberadas do design abaixo: (a) 1 share por nota (colunas na própria `notes`), não N shares por nota — renovar troca o link; (b) revogação LIMPA o token (não mantém linha auditável); (c) rate-limit por minuto (30/min) em vez de janela de 60s, mesmo teto; (d) sem `listSharesByNote` (só 1 share). Testes: `test/share.test.ts` (24) cobre módulo, página, mídia, privacidade fail-closed, endpoints e rate-limit.

## Contexto

Hoje o Expert Brain é 100% privado: toda superfície web vive sob `/app/*` e exige sessão de browser ou Bearer token.

- Roteamento: `src/index.ts` monta o `OAuthProvider` com `defaultHandler: authHandler` (`src/index.ts:12-20`). O `authHandler` (`src/auth/handler.ts:8-48`) despacha `/app/*` pra `handleApp` (`src/web/handler.ts:15`) e conhece só `/`, `/status`, `/setup/*` e `/authorize` fora do `/app`. Qualquer outra rota cai em 404 (`src/auth/handler.ts:46`).
- Detalhe de nota: `handleNoteDetail` (`src/web/notes.ts:134`) exige sessão (`requireSession`, `src/web/session.ts`), renderiza dentro do shell logado (`renderShell`, `src/web/render.ts`) e expõe edges (`getEdgesFrom`/`getEdgesTo`, `src/web/notes.ts:170-171`).
- Markdown: pipeline único com escaping — `renderMarkdown` (`src/web/markdown.ts:53`) usa `marked` com renderer que descarta HTML cru (`src/web/markdown.ts:12-16`) e resolve wikilinks pra `/app/notes/<id>` (`src/web/markdown.ts:49`).
- Mídia: blobs no R2, servidos por proxy do Worker em `/app/media/<id>` com token HMAC assinado com `SESSION_SECRET` e TTL de 1h (`TOKEN_TTL_MS`, `src/media/store.ts:15`; `signedMediaPath`, `src/media/store.ts:153-160`; `verifyMediaToken`, `src/media/store.ts:143-148`; stream em `fetchBlob`, `src/media/store.ts:225-237`).
- Credenciais com hash já existem como padrão: `api_keys` guarda `key_hash` sha256 e valida por lookup do hash (`src/auth/api-keys.ts:11-14`, `48-74`, `91-101`; migration `0003_api_keys`, `src/db/migrate.ts:83-96`).
- Migrations: aditivas, idempotentes, registradas em `_migrations` (`src/db/migrate.ts:166-191`). Última é `0007_note_media`.
- A spec 31 (selo de privacidade) introduz a marcação de nota privada em `notes` (coluna aditiva). Esta spec depende dela: nota privada NUNCA é compartilhável.

Não existe hoje nenhuma forma de mostrar UMA nota pra alguém sem entregar login no vault inteiro.

## Problema / Motivação

- O dono quer compartilhar uma nota específica (ex.: um conceito, um framework) com um aluno ou parceiro, read-only, sem criar conta nem expor o vault. Hoje a única alternativa é copiar/colar o conteúdo manualmente (perde formatação, mídia e atualização).
- Item de backlog `backlog-2` (inventário em `specs/00-sistema/02-inventario-de-falhas.md`): ausência de compartilhamento granular.
- Riscos se feito errado (por isso a spec de segurança fecha ANTES de qualquer código):
  - Link derivado do id da nota seria enumerável — os ids são nanoids curtos usados em URLs internas (`src/web/handler.ts:42`).
  - Signed URL direta de mídia (`signedMediaPath`, `src/media/store.ts:153`) tem TTL de 1h — menor que o TTL de um share (dias). Embutir essas URLs numa página pública quebraria a mídia e/ou incentivaria TTLs longos no HMAC de sessão.
  - A página de nota atual vaza grafo (edges em `src/web/notes.ts:170-171`) e shell logado — nada disso pode aparecer numa superfície pública.

## Objetivo

O dono consegue gerar, pela UI logada, uma URL `/s/<token>` que exibe UMA nota read-only (opcionalmente com mídia) pra quem tiver o link, com expiração obrigatória e revogação imediata — sem expor edges, notas privadas, shell logado ou qualquer outra rota do vault.

## Design proposto

### 1. Migration `0008_share_tokens` (aditiva, em `src/db/migrate.ts`)

Adicionar ao array `MIGRATIONS` (`src/db/migrate.ts:166`) após `0007_note_media`:

```sql
CREATE TABLE IF NOT EXISTS share_tokens (
  id             TEXT PRIMARY KEY,
  note_id        TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  include_media  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_note ON share_tokens(note_id);
CREATE INDEX IF NOT EXISTS idx_share_tokens_hash ON share_tokens(token_hash);
```

- `expires_at NOT NULL`: expiração é OBRIGATÓRIA no schema — impossível criar share infinito.
- Timestamps em unix ms (`Date.now()`), igual `notes.created_at`.
- Nenhuma tabela existente é alterada. Migration idempotente (`IF NOT EXISTS`), segue o padrão de `runMigrations` (`src/db/migrate.ts:176-191`).

### 2. Token — requisitos NÃO-negociáveis

- 32 bytes de `crypto.getRandomValues`, codificados base64url — reusar o padrão de `randomSecret` (`src/auth/api-keys.ts:20-22`). O token NUNCA é derivado do id da nota nem de qualquer dado previsível.
- O banco guarda SOMENTE `token_hash = sha256Hex(token)` (mesmo padrão de `api_keys.key_hash`, `src/auth/api-keys.ts:11-14`). O plaintext aparece uma única vez, na resposta de criação. Vazamento do D1 não vaza links válidos.
- Lookup por hash (igual `validateApiKey`, `src/auth/api-keys.ts:91-101`) — sem comparação de plaintext, sem timing side-channel relevante.
- Prefixo `ebs_` no plaintext (ex.: `ebs_<base64url-43chars>`) pra ser identificável em logs/secret-scanners.

### 3. Módulo novo `src/web/share.ts`

Funções:

- `createShare(env, noteId, { includeMedia, ttlDays }, now)`:
  1. Carrega a nota via `getNoteById` (`src/db/queries.ts`); 404 se inexistente ou `deleted_at IS NOT NULL`.
  2. **Recusa (400) se a nota estiver marcada como privada** pela coluna da spec 31 — checagem server-side, não só na UI.
  3. `ttlDays` default **30**, mínimo 1, máximo 365. Não existe valor "sem expiração".
  4. Gera token (item 2), grava linha em `share_tokens`, retorna `{ id, url: '/s/<token>', expires_at }`. Plaintext não é persistido.
- `resolveShare(env, token, now)`: hash → lookup → válido somente se `revoked_at IS NULL` e `expires_at > now` e a nota alvo existe, não está soft-deletada e **não está privada** (re-checa a privacidade a CADA acesso: se o dono privatizar a nota depois de compartilhar, o link morre na hora).
- `revokeShare(env, shareId, now)`: seta `revoked_at` (não deleta — auditável).
- `listSharesByNote(env, noteId)`: pra UI de gestão.

### 4. Rota pública `/s/<token>` — server-rendered, fora do shell

Roteada em `src/auth/handler.ts` (é path fora de `/app`, então entra ANTES do fallback 404 da linha 46):

```ts
const shareMatch = url.pathname.match(/^\/s\/(ebs_[A-Za-z0-9_-]{40,})$/);
if (shareMatch && req.method === 'GET') return handleSharePage(req, env, shareMatch[1]);
```

`handleSharePage` (em `src/web/share.ts`):

- **SEM** `requireSession`, **SEM** `renderShell` — HTML standalone mínimo (título, tldr, badges de domínio, corpo, mídia opt-in, rodapé "somente leitura"). Zero links pra `/app/*`, zero menção a e-mail/credenciais do dono.
- Corpo renderizado com **o mesmo pipeline de escaping existente**: `renderMarkdown` (`src/web/markdown.ts:53`). Wikilinks: passar resolver vazio (`{ titleIndex: new Map(), idSet: new Set() }`) — todo `[[link]]` vira `<span class="wikilink broken">` com texto escapado (`src/web/markdown.ts:47`), NUNCA um `<a href="/app/notes/...">`. Nenhum título/id de outra nota é resolvido nem vazado.
- **Edges/vizinhos NÃO expostos**: não chamar `getEdgesFrom`/`getEdgesTo` nem `similar_edges`. Só a nota.
- Headers obrigatórios da resposta (200 e também 404/410):
  - `cache-control: no-store`
  - `x-robots-tag: noindex, nofollow` + `<meta name="robots" content="noindex, nofollow">`
  - CSP restritiva no padrão da página de login (`src/auth/handler.ts:69-80`), `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`
- Token inválido, expirado, revogado, nota privada ou deletada → **mesma resposta 404 genérica** ("Link inválido ou expirado"), sem distinguir o motivo (não confirmar existência de nota).

### 5. Mídia — opt-in por share, sempre via proxy server-side

- `include_media = 0` por default. Só shares criados explicitamente com `includeMedia: true` exibem anexos.
- **NUNCA** embutir `signedMediaPath` (`src/media/store.ts:153`) na página pública: o TTL da assinatura é 1h (`TOKEN_TTL_MS`, `src/media/store.ts:15`) &lt; TTL do share (dias), e o HMAC usa `SESSION_SECRET` — superfície de sessão não se mistura com superfície pública.
- Rota nova: `GET /s/<token>/media/<mediaId>` (também em `src/auth/handler.ts` → `handleShareMedia` em `src/web/share.ts`):
  1. `resolveShare` valida o token (mesmas regras do item 3).
  2. 404 se `include_media = 0`.
  3. `getMediaById` (`src/db/media-queries.ts`) e **verificar `media.note_id === share.note_id`** — um token de share só serve mídia da SUA nota.
  4. Stream via `fetchBlob` (`src/media/store.ts:225`) com `cache-control: no-store` sobrescrevendo o `private, max-age=3600` default (`src/media/store.ts:231`).
- A URL pública do R2 nunca aparece; o bucket continua sem acesso público.

### 6. UI logada — criar e revogar

Na página de detalhe da nota (`handleNoteDetail`, `src/web/notes.ts:134`), seção "Compartilhamento":

- `POST /app/notes/<id>/share` → `createShare` (sessão obrigatória via `requireSession`). Form com TTL (default 30 dias) e checkbox "incluir mídia" (default off). Resposta mostra a URL completa UMA vez.
- `GET` da própria página lista shares ativos da nota (`listSharesByNote`): prefixo do token, criado em, expira em, include_media, botão revogar.
- `POST /app/share/<shareId>/revoke` → `revokeShare` (sessão obrigatória).
- Rotas registradas em `src/web/handler.ts` (junto dos matches de nota existentes, `src/web/handler.ts:29-43`), padrão CSRF/sessão igual às demais rotas POST do app.
- Botão de compartilhar fica desabilitado (e o endpoint recusa) quando a nota é privada (spec 31).

### 7. Rate-limit básico na rota pública

- Contador por IP (`cf-connecting-ip`) em KV (`OAUTH_KV`, já bindado — `src/env.ts`), janela de 60s, teto de 30 req/min por IP pra `/s/*` (página + mídia). Excedeu → 429 com `retry-after: 60`.
- Chave: `share-rl:<ip>:<epoch-min>` com `expirationTtl: 120`. Best-effort (KV é eventual) — objetivo é frear brute-force de token e scraping, não ser um WAF.
- Brute-force residual: token de 32 bytes random torna enumeração inviável mesmo sem rate-limit; o rate-limit é defesa em profundidade.

### 8. Gate de segurança (bloqueante, antes do deploy)

1. **Revisão de segurança dedicada**: percorrer o checklist abaixo item a item, com evidência (teste ou leitura de código) pra cada um. Sem checklist 100% verde, não há deploy.
   - [x] Token 32+ bytes crypto random, não derivado do id da nota
   - [x] Só `token_hash` no banco; plaintext exibido uma única vez
   - [x] `expires_at NOT NULL` no schema; default 30d; sem opção infinita
   - [x] Revogação funciona e é imediata (próximo request → 404)
   - [x] Nota privada (spec 31) recusada na criação E re-checada a cada acesso
   - [x] Nota soft-deletada → 404
   - [x] `/s/*` sem shell logado, sem link pra `/app/*`, sem edges, sem dados do dono
   - [x] Headers: `no-store`, `noindex` (header + meta), CSP, frame DENY em TODAS as respostas de `/s/*`
   - [x] Mídia só com `include_media=1`, só da nota do share, só via proxy (zero signed URL / URL R2 na página)
   - [x] Wikilinks não resolvem nem vazam ids/títulos de outras notas
   - [x] Erros indistinguíveis (404 único pra inválido/expirado/revogado/privado/deletado)
   - [x] Rate-limit ativo em `/s/*`
2. **Deploy SÓ com OK explícito do dono** após a revisão.
3. **Release pros alunos** (release notes / template público) só depois de a feature rodar **ao menos 2 semanas** na instância do dono sem incidente.

## Fora de escopo

- Compartilhar subgrafo, coleção ou múltiplas notas num link.
- Edição colaborativa ou comentários na página pública.
- Analytics de acesso (contador de views, geolocalização etc.).
- Share protegido por senha ou restrito a e-mails.
- Presigned URL S3 do R2 ou acesso público ao bucket.
- Expor tasks (`kind='task'`) — share é só de nota de conhecimento; criação recusa `kind='task'`.

## Critérios de aceite

- [x] Migration `0008_share_tokens` aplica em banco novo E em banco existente sem tocar nenhuma linha de `notes`/`edges`/`note_media` (aditiva, idempotente).
- [x] `POST /app/notes/<id>/share` (sessão) cria share com TTL default 30 dias e retorna URL `/s/ebs_...` exibida uma única vez.
- [x] Impossível criar share sem expiração (schema `NOT NULL` + validação 1–365 dias).
- [x] `GET /s/<token>` renderiza título, tldr, domínios e corpo (markdown escapado pelo pipeline existente) SEM sessão, SEM shell logado, SEM edges/vizinhos, SEM links pra `/app/*`.
- [x] Resposta de `/s/*` sempre traz `cache-control: no-store` e `x-robots-tag: noindex, nofollow` (+ meta robots no HTML).
- [x] Token expirado, revogado, inexistente, nota privada, nota deletada e `kind='task'` → todos retornam o MESMO 404 genérico.
- [x] Revogar pela UI logada mata o link no request seguinte.
- [x] Nota marcada privada (spec 31) não pode ser compartilhada; se privatizada após o share, o link para de funcionar imediatamente.
- [x] Share sem `include_media` não exibe nem serve mídia; com `include_media`, mídia sai só por `/s/<token>/media/<id>`, só da nota do share, com `no-store` — nenhuma signed URL (`?t=&sig=`) ou key R2 aparece no HTML público.
- [x] Wikilinks `[[...]]` na página pública viram texto (span), nunca âncora pra `/app/notes/`.
- [x] Banco guarda apenas `token_hash` (sha256) — nenhum plaintext de token em D1.
- [x] Mais de 30 req/min por IP em `/s/*` → 429.
- [x] Checklist de segurança da seção 8 verificado item a item antes do deploy; deploy só com OK do dono.

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck          # tsc --noEmit (server + client)
npm test                   # vitest run + vitest run --config vitest.auth.config.ts
npx vitest run test/web/share.test.ts   # suíte nova da feature
```

Teste manual (wrangler dev):

1. `npm run dev`, logar em `/app`, abrir uma nota, criar share (default) → copiar URL.
2. Abrir `/s/<token>` em janela anônima: nota renderiza, sem sidebar/shell, headers conferidos no DevTools (`no-store`, `x-robots-tag`).
3. Revogar na UI → recarregar a janela anônima → 404.
4. Criar share com mídia → confirmar que o `<img src>` aponta pra `/s/<token>/media/<id>` (sem `?t=&sig=`).
5. Marcar a nota como privada (spec 31) → link vivo passa a dar 404.
6. Loop de 40 requests no `/s/<token>` em <60s → 429.

Deploy (`npm run deploy`) SOMENTE após checklist da seção 8 completo e OK explícito do dono. Release pros alunos: só após 2 semanas rodando na instância do dono.

## Arquivos afetados

- `src/web/share.ts` (novo — create/resolve/revoke/list, página pública, proxy de mídia, rate-limit)
- `src/auth/handler.ts` (rotas `/s/<token>` e `/s/<token>/media/<id>`)
- `src/web/handler.ts` (rotas logadas `POST /app/notes/<id>/share` e `POST /app/share/<id>/revoke`)
- `src/db/migrate.ts` (migration `0008_share_tokens`)
- `src/media/store.ts` (export/ajuste de `fetchBlob` pra permitir override de `cache-control` no caminho público)
- `src/web/notes.ts` (seção "Compartilhamento" no detalhe da nota)
- `test/web/share.test.ts` (novo — cobre todos os critérios de aceite testáveis)

## Riscos e reversao

- **Risco: link vazado além do destinatário.** Mitigação: expiração obrigatória + revogação imediata pela UI + `no-store`/`noindex`. Resposta a incidente: revogar o share (1 clique) — efeito no request seguinte.
- **Risco: bug expor nota errada/privada.** Mitigação: checagem de privacidade e de `note_id` da mídia no server a cada request + suíte `share.test.ts` cobrindo os casos negativos + gate de revisão dedicada.
- **Risco: scraping/brute-force.** Mitigação: token 32 bytes + rate-limit KV; residual aceito.
- **Rollback total (kill switch):** remover (ou comentar) as duas rotas `/s/*` em `src/auth/handler.ts` e redeployar — toda superfície pública morre; nada mais no sistema depende de `share.ts`.
- **Rollback de dados:** a migration é puramente aditiva; pra desativar de vez, `UPDATE share_tokens SET revoked_at = <now> WHERE revoked_at IS NULL` invalida todos os links sem dropar nada. A tabela pode ficar no schema sem efeito colateral (nenhum read path existente a consulta).
