# Autenticar /setup/backfill-similar e rate-limit no /authorize

> **Status:** draft · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma (mas coordenar com a spec 13 — o passo de provision pós-deploy dela precisa continuar funcionando com o gate novo)

## Contexto

O Worker do Expert Brain (Cloudflare Workers + D1 + Vectorize + KV) expõe hoje quatro rotas públicas no `authHandler` (`src/auth/handler.ts:17-20`):

- `GET /` e `GET /status` — informativas, inofensivas.
- `POST /setup/provision` (`src/auth/handler.ts:19` → `handleProvision`, `src/auth/setup.ts:138-149`) — roda `runMigrations(env)`. Idempotente e barato, mas SEM nenhuma autenticação, mesmo depois do vault configurado. O comentário no próprio código admite: "Endpoint não-autenticado, mas re-rodar é inofensivo".
- `POST /setup/backfill-similar` (`src/auth/handler.ts:20` → `handleBackfillSimilar`, `src/auth/setup.ts:86-136`) — reconstrói as similar edges em lotes. Só exige `isSetup(env)` (`src/auth/setup.ts:87`), ou seja: num vault CONFIGURADO qualquer pessoa na internet pode chamá-lo.
- `GET|POST /authorize` (`src/auth/handler.ts:22-44`) — login OAuth com e-mail + senha, valida via `verifyPassword` (`src/auth/password.ts:44`).

Infra de auth que JÁ existe e será reutilizada:

- `authorizeBearer(req, env)` em `src/web/bearer-auth.ts:19-25` — aceita `Authorization: Bearer <token>` comparado em tempo constante com `env.GRAPH_EXPORT_TOKEN` ou `env.TASK_REMINDER_TOKEN` (ambos opcionais, `src/env.ts:19-23`).
- Sessão de app assinada por HMAC no cookie `mv_session`: `verifySession` / `readCookie` em `src/web/session.ts:49-81` (o `requireSession` de `session.ts:87` responde redirect 302 pra `/app/login` — bom pra páginas, ruim pra API JSON; aqui usaremos as primitivas direto e responderemos 401).
- KV `OAUTH_KV` já bindado (`wrangler.example.toml:57-59`) — serve de storage pro rate limit sem binding novo.

Fluxo de bootstrap do aluno (NÃO pode quebrar):

- `scripts/setup.mjs` chama `POST /setup/provision` sem credencial em DOIS lugares: modo atualização (`scripts/setup.mjs:235-243`, dentro de `buildDeployProvision`) e instalação nova (`scripts/setup.mjs:470-477`). No modo ATUALIZAÇÃO os secrets já existem (`isSetup === true`), então um gate ingênuo "exige auth depois de configurado" quebraria o update.
- `scripts/backfill-similar.mjs:23` chama `POST /setup/backfill-similar` em loop por cursor, hoje sem nenhum header.

## Problema / Motivação

1. **`/setup/backfill-similar` é queimável por qualquer IP** (`src/auth/handler.ts:20`, `src/auth/setup.ts:86-136`). Cada chamada custa até 41 subrequests (1 `getByIds` + N×(1 query Vectorize + 1 batch D1), N≤20 — conta documentada em `src/auth/setup.ts:82-85`) e faz writes reais em `similar_edges` via `refreshSimilarEdges`. Um atacante martelando o endpoint queima a quota Vectorize/AI/D1 do DONO da instalação (free tier dos alunos inclusive) sem precisar de credencial nenhuma.
2. **`POST /authorize` não tem nenhum freio a brute-force** (`src/auth/handler.ts:25-42`). O PBKDF2 está capado em 100.000 iterações pelo runtime do Workers (`src/auth/password.ts:3-8` — hard limit da plataforma, abaixo do target OWASP). O tradeoff documentado assumia ausência de brute-force externo, mas o endpoint é público e aceita tentativas ilimitadas: custo por tentativa é só o PBKDF2, sem lockout, sem log. `POST /app/login` (`src/web/login.ts:50`) tem exatamente o mesmo buraco com a mesma senha.

## Objetivo

Nenhuma rota que consome quota ou verifica senha aceita tráfego anônimo ilimitado: `/setup/backfill-similar` responde 401 sem credencial, `/setup/provision` exige credencial após o vault estar configurado, e o 6º erro de senha em 15 minutos no `/authorize` (e `/app/login`) responde 429 — com o fluxo de instalação/atualização do aluno (`npm run setup`) passando de ponta a ponta sem mudança de UX.

## Design proposto

### 1. Helper de auth compartilhado pros endpoints de setup

Criar em `src/auth/setup.ts` (ou módulo novo `src/auth/setup-auth.ts`) um helper:

```ts
// true se o request traz Bearer GRAPH_EXPORT_TOKEN/TASK_REMINDER_TOKEN (authorizeBearer),
// Bearer SETUP_TOKEN (novo, ver §3), OU cookie mv_session válido.
export async function isAuthorizedForSetup(req: Request, env: Env): Promise<boolean>
```

- Bearer: reutilizar `authorizeBearer` (`src/web/bearer-auth.ts:19`) e adicionar comparação em tempo constante com `env.SETUP_TOKEN` (usar a mesma `tokenMatches` — exportá-la ou replicar o padrão).
- Sessão: `readCookie(req.headers.get('cookie'), 'mv_session')` + `verifySession(token, env.SESSION_SECRET, now)` (`src/web/session.ts:49,74`). NÃO usar `requireSession` — ele devolve redirect 302; aqui o caller responde 401 JSON.

### 2. Gate no `/setup/backfill-similar`

Em `handleBackfillSimilar` (`src/auth/setup.ts:86`), logo após o check `isSetup` existente:

```ts
if (!(await isAuthorizedForSetup(req, env))) {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  });
}
```

Atualizar `scripts/backfill-similar.mjs` pra ler `GRAPH_EXPORT_TOKEN` do ambiente e enviar `Authorization: Bearer <token>` no fetch da linha 23. Sem token no env: abortar com mensagem clara ("setar GRAPH_EXPORT_TOKEN — o mesmo secret do Worker — antes de rodar"). Documentar no comentário de cabeçalho do script.

### 3. Gate no `/setup/provision` compatível com o bootstrap

Em `handleProvision` (`src/auth/setup.ts:138`) — mudar a assinatura pra receber `req` (ajustar a chamada em `src/auth/handler.ts:19`):

- `!isSetup(env)` → continua ABERTO (bootstrap de instalação nova: o aluno ainda não tem secrets; nada de valor no vault).
- `isSetup(env)` → exige `isAuthorizedForSetup(req, env)`; senão 401 JSON.

Compatibilidade com o modo ATUALIZAÇÃO do `setup.mjs` (que roda com secrets já setados e hoje chama sem credencial, `scripts/setup.mjs:235-243`):

- Adicionar `SETUP_TOKEN?: string` ao `Env` (`src/env.ts`), com comentário no padrão dos vizinhos (token efêmero do script de setup; ausente → só Bearer/sessão autorizam).
- Em `buildDeployProvision` (`scripts/setup.mjs:217-245`): gerar um token aleatório por execução (`crypto.randomUUID()` dobrado ou `randomBytes(32).toString('hex')`), fazer `wrangler secret put SETUP_TOKEN` logo após o `secret put WORKER_URL` (mesmo padrão `runWrangler` da linha 231, `allowFail: false` aqui — se falhar, o provision autenticado falharia em seguida), e então chamar `POST /setup/provision` com header `Authorization: Bearer <token>`.
- Enviar o header nos DOIS call sites (`scripts/setup.mjs:235-243` e `470-477`) — na instalação nova o gate está aberto e o header é ignorado, então o código fica uniforme.
- O `secret put` cria uma versão nova do Worker antes do fetch — mesmo padrão já usado com `WORKER_URL`, sem passo extra.
- Coordenar com a spec 13: o passo de provision pós-deploy dela deve usar o mesmo header Bearer (SETUP_TOKEN ou GRAPH_EXPORT_TOKEN).

### 4. Rate limit por IP+e-mail no `POST /authorize` (e `/app/login`)

Criar `src/auth/rate-limit.ts` com storage no `OAUTH_KV` (nenhum binding novo — migração/schema não muda; KV é aditivo e chaves expiram sozinhas):

```ts
const WINDOW_S = 15 * 60;          // janela de contagem
const MAX_FAILS = 5;               // falhas permitidas por janela
const MAX_BLOCK_S = 24 * 60 * 60;  // teto do backoff

type Bucket = { fails: number; blockedUntil: number }; // epoch seconds

// key: `rl:login:${ip}:${emailKey}` — ip = header CF-Connecting-IP (fallback 'unknown'),
// emailKey = primeiros 16 hex do SHA-256 do e-mail lowercased (não gravar e-mail em claro na key)
export async function checkLoginAllowed(env, ip, email): Promise<{ allowed: boolean; retryAfterS?: number }>
export async function registerLoginFailure(env, ip, email): Promise<void>
export async function clearLoginFailures(env, ip, email): Promise<void>
```

Semântica:

- `checkLoginAllowed`: lê o bucket; se `blockedUntil > now` → `{ allowed: false, retryAfterS }`. Senão permitido.
- `registerLoginFailure`: incrementa `fails`; quando `fails > MAX_FAILS`, seta `blockedUntil = now + min(WINDOW_S * 2^(fails - MAX_FAILS - 1), MAX_BLOCK_S)` (15min → 30min → 60min → … → cap 24h). Grava com `expirationTtl = max(WINDOW_S, blockedUntil - now) + 60`.
- `clearLoginFailures`: `OAUTH_KV.delete(key)` no login bem-sucedido.
- KV é eventualmente consistente entre POPs — o objetivo é matar brute-force barato/burro, não ser um contador atômico. Documentar isso no comentário do módulo.

Fiação no `POST /authorize` (`src/auth/handler.ts:25-42`), ANTES de tocar em `verifyPassword`:

1. `checkLoginAllowed` → bloqueado: responder 429 com `Retry-After: <retryAfterS>` e a página de login com mensagem genérica ("Muitas tentativas. Aguarde alguns minutos.") — ajustar `renderLogin` pra aceitar status.
2. E-mail errado (`handler.ts:29`) OU senha errada (`handler.ts:31`) → `await registerLoginFailure(...)` + `console.warn('authorize: failed login', { ip, emailKey, fails })` antes do `renderLogin('Credenciais inválidas.', ...)`. IMPORTANTE: contar a falha de e-mail também, senão o check `email !== env.OWNER_EMAIL` vira oráculo grátis.
3. Sucesso → `clearLoginFailures` antes do redirect.

Aplicar a MESMA fiação no `POST /app/login` (`src/web/login.ts:47-53`) — mesma senha, mesmo buraco, mesmo bucket (o prefixo de key é compartilhado de propósito: falhas no `/authorize` e no `/app/login` somam).

### 5. Recomendação WAF no `wrangler.example.toml`

Adicionar bloco de comentário no `wrangler.example.toml` recomendando, como defesa em profundidade pra quem serve o Worker atrás de zona própria: regra de rate limiting da Cloudflare (WAF) em `/authorize` e `/setup/*`. Só documentação — nada de config executável (o `workers.dev` default não tem WAF de zona).

## Fora de escopo

- Subir as iterações do PBKDF2 — 100k é hard limit do runtime Workers (`src/auth/password.ts:3`); migrar de algoritmo é outra spec.
- Configurar WAF/regras de zona de fato — só a recomendação em comentário (§5).
- Rate limit nas rotas MCP/token OAuth (o `@cloudflare/workers-oauth-provider` gerencia tokens próprios) e nas rotas `/app/graph/*` (já exigem sessão ou Bearer).
- CAPTCHA, lockout permanente de conta, notificação de tentativa suspeita.
- Qualquer migration de D1 — esta spec não toca schema (storage novo é só KV, aditivo).

## Critérios de aceite

- [ ] `POST /setup/backfill-similar` sem credencial num vault configurado → 401 JSON `{"error":"unauthorized"}`; com `Authorization: Bearer <GRAPH_EXPORT_TOKEN>` OU cookie `mv_session` válido → comportamento atual (lote processado).
- [ ] `POST /setup/provision` com `!isSetup(env)` → 200 sem credencial (bootstrap intacto); com `isSetup(env)` e sem credencial → 401; com Bearer `SETUP_TOKEN`/`GRAPH_EXPORT_TOKEN` ou sessão → 200.
- [ ] `scripts/setup.mjs` gera `SETUP_TOKEN`, faz `wrangler secret put SETUP_TOKEN` e envia o Bearer nos dois call sites de provision.
- [ ] `scripts/backfill-similar.mjs` envia Bearer lido de `GRAPH_EXPORT_TOKEN` e aborta com mensagem clara se o env não estiver setado.
- [ ] `POST /authorize`: 5 falhas seguidas (mesmo IP+e-mail) ainda respondem o formulário com "Credenciais inválidas."; a 6ª responde 429 com `Retry-After`; o bloqueio cresce exponencialmente (15→30→60 min) com teto de 24h.
- [ ] Falha de e-mail inexistente conta no bucket igual a falha de senha (sem oráculo de e-mail).
- [ ] Login correto após falhas (antes do bloqueio) zera o bucket (`clearLoginFailures`) e completa o OAuth normalmente.
- [ ] `POST /app/login` usa o mesmo rate limit (mesmo bucket IP+e-mail).
- [ ] Tentativa falha gera `console.warn` com IP e contagem — sem logar senha nem e-mail em claro na key do KV.
- [ ] Nenhuma migration D1 adicionada; nenhum dado existente alterado.
- [ ] `npm run typecheck` e `npm test` verdes, incluindo o novo `test/auth-handler.test.ts`.
- [ ] Fluxo de instalação de aluno testado de ponta a ponta em preview (instalação nova E atualização via `npm run setup`) ANTES da release — gate obrigatório.

## Validação

```bash
npm run typecheck
npm test          # vitest run (pool workers) + vitest.auth.config.ts
```

Testes novos em `test/auth-handler.test.ts` (pool workers do `vitest.config.ts` — bindings `OWNER_EMAIL`/`OWNER_PASSWORD_HASH`/`SESSION_SECRET`/`OAUTH_KV` já existem no miniflare; adicionar `GRAPH_EXPORT_TOKEN` e `SETUP_TOKEN` de teste aos `bindings` se necessário):

- backfill-similar: 401 sem credencial / 200 com Bearer / 200 com cookie de sessão assinado via `signSession`.
- provision: 200 sem credencial quando `!isSetup` (env sem `OWNER_EMAIL`) / 401 configurado sem credencial / 200 com Bearer `SETUP_TOKEN`.
- rate limit: 5 falhas → 6ª = 429 com `Retry-After`; backoff dobra; sucesso limpa o bucket; e-mail errado conta.

Teste manual em preview (deploy SÓ com OK do dono):

1. `npm run setup` numa conta de teste do zero (instalação nova) — wizard completa, `/status` → `configured:true`.
2. `npm run setup` de novo na mesma conta (modo atualização) — provision autenticado passa, dados intactos.
3. `curl -X POST https://<preview>/setup/backfill-similar` → 401; com `-H "Authorization: Bearer $GRAPH_EXPORT_TOKEN"` → JSON de lote.
4. 6 POSTs de senha errada no `/authorize` → o 6º responde 429.

## Arquivos afetados

- `src/auth/handler.ts` — fiação do gate no provision/backfill + rate limit no `/authorize` + `renderLogin` com status
- `src/auth/setup.ts` — `isAuthorizedForSetup`, gates em `handleBackfillSimilar` e `handleProvision` (assinatura recebe `req`)
- `src/auth/rate-limit.ts` (novo) — buckets de falha de login no `OAUTH_KV`
- `src/web/bearer-auth.ts` — exportar `tokenMatches` (ou aceitar `SETUP_TOKEN` no `authorizeBearer`)
- `src/web/login.ts` — mesma fiação de rate limit no POST
- `src/env.ts` — `SETUP_TOKEN?: string`
- `scripts/setup.mjs` — gerar/putar `SETUP_TOKEN` + Bearer nos dois call sites de provision
- `scripts/backfill-similar.mjs` — enviar Bearer `GRAPH_EXPORT_TOKEN`
- `wrangler.example.toml` — comentário com recomendação de WAF/rate-limiting de zona
- `test/auth-handler.test.ts` (novo)
- `vitest.config.ts` — bindings de teste (`GRAPH_EXPORT_TOKEN`, `SETUP_TOKEN`) se necessário

## Riscos e reversão

- **Risco principal: quebrar o bootstrap/atualização do aluno.** Mitigação: gate do provision só ativa com `isSetup(env)`; `setup.mjs` sempre envia o Bearer; gate de release exige teste ponta a ponta em preview (instalação nova + atualização).
- **Instalações antigas rodando `backfill-similar.mjs` da versão anterior** vão receber 401 depois do deploy — a mensagem de erro do script novo instrui a setar `GRAPH_EXPORT_TOKEN`; documentar no changelog da release.
- **Falso positivo de rate limit** (dono atrás de NAT/proxy errando senha): bloqueio expira sozinho (TTL no KV) e o teto é 24h; em emergência, o dono deleta as chaves `rl:login:*` no dash do KV (`OAUTH_KV`).
- **Rollback:** mudanças são só de código + secrets novos opcionais (`SETUP_TOKEN`), sem migration — reverter o commit e redeployar (`npm run deploy`) restaura o comportamento anterior; chaves `rl:login:*` remanescentes no KV expiram sozinhas e são ignoradas pelo código antigo; `SETUP_TOKEN` órfão no Worker é inerte (pode ser removido com `wrangler secret delete SETUP_TOKEN`).
