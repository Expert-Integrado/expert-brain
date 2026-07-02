# Console contacts: rate-limit no login, SSO single-use e revogação de sessão

> **Status:** draft · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-contacts
> **Depende de:** `40-ops/42-contacts-testes-typecheck-ci.md` (harness de vitest + typecheck — hoje o `package.json` do expert-contacts não tem script `test` nem `typecheck` e não existe pasta `test/`)

## Contexto

O Expert Console (front multi-vault) é co-hospedado no Worker `expert-contacts`. A autenticação vive em três arquivos:

- **Login por senha** — `src/web/login.ts`. `handleLoginPost` (`src/web/login.ts:39-67`) valida origin, compara e-mail com `env.OWNER_EMAIL` e chama `verifyPassword` (`src/auth/password.ts:44`) contra `env.OWNER_PASSWORD_HASH`. O hash é PBKDF2-SHA-256 com **100.000 iterações — hard limit do runtime Workers** (`src/auth/password.ts:3-8`), abaixo do alvo OWASP (600k). O comentário do próprio módulo assume "não temos brute force de atacante externo" — premissa que só vale se houver freio externo.
- **SSO vindo do Expert Brain** — `src/web/sso.ts`. `handleSso` (`src/web/sso.ts:24-42`) recebe `GET /app/sso?exp=<ms>&sig=<hmac>`, valida a assinatura HMAC (`SSO_SECRET` compartilhado) sobre a mensagem `sso:${exp}` e cria sessão do dono sem senha. O emissor é o Brain, em `expert-brain/src/web/contacts-sso.ts:20-34` (`handleContactsSso`), que assina `exp = Date.now() + 60_000` e redireciona com `exp` e `sig` na **query string** (`contacts-sso.ts:32`).
- **Sessão** — `src/web/session.ts`. Token stateless `email.issuedAt.sig` (HMAC-SHA-256 com `SESSION_SECRET`), TTL de **7 dias** (`src/web/session.ts:1,63`), cookie `mv_session` (`session.ts:69-72`). `requireSession` (`session.ts:87-102`) só verifica assinatura + TTL — não há nenhum estado server-side de sessão.

Infra disponível sem binding novo: KV `CACHE` já bindado (`wrangler.toml:32-34`, `src/env.ts:15`). Roteamento em `src/web/handler.ts` (`/app/login` linha 70, `/app/sso` linha 79, `/app/logout` linha 100).

Referência de padrão entre repos: o Expert Brain tem a spec irmã `10-backend/18-setup-endpoints-auth-e-login-rate-limit.md`, que define o módulo de rate-limit por IP+e-mail em KV. **Esta spec replica o mesmo desenho** (mesmas constantes, mesmo esquema de key) pro Console — os dois repos devem ficar com o padrão idêntico.

## Problema / Motivação

1. **Login sem nenhum freio a brute-force.** `handleLoginPost` (`src/web/login.ts:39-53`) aceita tentativas ilimitadas; o único custo por tentativa é o PBKDF2 capado em 100k iterações (`src/auth/password.ts:8`). Sem lockout, sem backoff, sem log de falha. Como o custo do hash está abaixo do alvo OWASP por limite da plataforma, o freio TEM que ser externo ao hash.
2. **Handoff SSO é replayável e viaja em query string.** A mensagem assinada é só `sso:${exp}` (`src/web/sso.ts:33`; emissor em `expert-brain/src/web/contacts-sso.ts:29`). Dentro da janela de 60s, **a mesma URL cria quantas sessões quiser** — não há marcação de uso. E por estar na query string, a URL completa (com `sig`) fica em history do navegador, logs de proxy corporativo e header `Referer` de eventuais requests subsequentes.
3. **Logout não revoga nada.** `handleLogoutPost` (`src/web/login.ts:69-78`) apenas limpa o cookie no navegador. O token em si continua válido até completar 7 dias (`src/web/session.ts:63`) — um token roubado (ou o cookie de outro dispositivo) sobrevive ao logout e à troca de senha, porque a verificação é 100% stateless.

## Objetivo

A 6ª falha de senha em 15 minutos (mesmo IP+e-mail) responde 429 com backoff exponencial; um link de SSO usado uma vez deixa de funcionar na segunda tentativa; e um logout (ou troca de senha) invalida imediatamente todas as sessões emitidas — tudo verificado por testes automatizados.

## Design proposto

### 1. Rate-limit por IP+e-mail no `handleLoginPost` (espelho da spec 18 do Brain)

Criar `src/web/rate-limit.ts` com storage no KV `CACHE` (aditivo — nada de migration D1, chaves expiram sozinhas):

```ts
const WINDOW_S = 15 * 60;          // janela de contagem
const MAX_FAILS = 5;               // falhas permitidas por janela
const MAX_BLOCK_S = 24 * 60 * 60;  // teto do backoff

type Bucket = { fails: number; blockedUntil: number }; // epoch seconds

// key: `rl:login:${ip}:${emailKey}` — ip = header CF-Connecting-IP (fallback 'unknown'),
// emailKey = primeiros 16 hex do SHA-256 do e-mail lowercased (não gravar e-mail em claro na key)
export async function checkLoginAllowed(env: Env, ip: string, email: string): Promise<{ allowed: boolean; retryAfterS?: number }>
export async function registerLoginFailure(env: Env, ip: string, email: string): Promise<void>
export async function clearLoginFailures(env: Env, ip: string, email: string): Promise<void>
```

Semântica (idêntica à spec `10-backend/18` §4 do Brain — manter os dois módulos alinhados):

- `checkLoginAllowed`: lê o bucket; `blockedUntil > now` → `{ allowed: false, retryAfterS }`.
- `registerLoginFailure`: incrementa `fails`; quando `fails > MAX_FAILS`, `blockedUntil = now + min(WINDOW_S * 2^(fails - MAX_FAILS - 1), MAX_BLOCK_S)` (15min → 30min → 60min → … cap 24h). Gravar com `expirationTtl = max(WINDOW_S, blockedUntil - now) + 60`.
- `clearLoginFailures`: `CACHE.delete(key)` no sucesso.
- Documentar no cabeçalho do módulo: KV é eventualmente consistente entre POPs — o objetivo é matar brute-force barato, não ser contador atômico.

Fiação em `handleLoginPost` (`src/web/login.ts:39`), **ANTES** do `verifyPassword` da linha 50:

1. `checkLoginAllowed` → bloqueado: responder **429** com header `Retry-After: <retryAfterS>` e `renderLoginPage` com mensagem genérica ("Muitas tentativas. Aguarde alguns minutos.").
2. E-mail errado OU senha errada (`login.ts:49-52`) → `await registerLoginFailure(...)` + `console.warn('login: failed attempt', { ip, emailKey, fails })` antes do 401. IMPORTANTE: falha de e-mail conta igual, senão a comparação `email === env.OWNER_EMAIL` (`login.ts:49`) vira oráculo grátis.
3. Sucesso → `clearLoginFailures` antes do redirect 302.

Documentação (README ou comentário no `wrangler.toml`): recomendar, como defesa em profundidade, regra de **Cloudflare Rate Limiting (WAF)** em `/app/login` e `/app/sso` pra quem serve o Worker atrás de zona própria (o `workers.dev` default não tem WAF de zona). Só comentário — nada executável.

### 2. SSO single-use: nonce assinado + marcação em KV

Mudança nos DOIS Workers (deploy coordenado — ver Riscos):

**Emissor** (`expert-brain/src/web/contacts-sso.ts:28-33`): gerar `nonce = crypto.randomUUID()` (ou 16 bytes hex de `crypto.getRandomValues`), assinar a mensagem `sso:${exp}:${nonce}` e redirecionar pra `${CONSOLE_URL}/app/sso?exp=${exp}&nonce=${nonce}&sig=${sig}`.

**Validador** (`src/web/sso.ts:24-42`), na ordem:

1. Ler `exp`, `nonce`, `sig`; sem `nonce` → `loginRedirect` (formato antigo deixa de ser aceito).
2. Validar `exp` (janela mantida em 60s) e a assinatura sobre `sso:${exp}:${nonce}` com `constTimeEq` — igual hoje.
3. **Single-use**: `const used = await env.CACHE.get(\`ssonon:${nonce}\`)`; se existir → `loginRedirect`. Senão `await env.CACHE.put(\`ssonon:${nonce}\`, '1', { expirationTtl: 120 })` (TTL 120s cobre a janela de 60s com folga; depois disso o `exp` já rejeita sozinho) e só então criar a sessão.
4. Manter o comportamento de falha atual: qualquer problema → 302 pro `/app/login` (fallback é o login normal, nunca erro hard).

Nota de honestidade no comentário do código: KV eventualmente consistente significa que um replay em POP diferente dentro de segundos PODE passar — o single-use elimina o replay trivial (URL em history/log reutilizada minutos ou dias depois... não: dentro de 60s; o ganho real é matar reuso por quem capturou a URL em log/history dentro da janela) e reduz a janela efetiva de 60s reutilizável pra 1 uso. Não é proteção criptográfica perfeita contra atacante posicionado em rede — pra isso existe o TLS.

### 3. Session-epoch: logout e troca de senha revogam todas as sessões

Introduzir estado mínimo server-side no material do HMAC, em `src/web/session.ts`:

```ts
// Material efetivo da chave HMAC de sessão. Combina:
//  - SESSION_SECRET (secret estático)
//  - epoch (contador em KV, key 'session:epoch', default '0') — bump = revoga tudo
//  - fingerprint do password hash (sha256(OWNER_PASSWORD_HASH), 16 hex) — troca de senha revoga tudo
export async function getSessionKeyMaterial(env: Env): Promise<string>
// → `${env.SESSION_SECRET}|${epoch}|${pwdFingerprint}`
```

- `signSession` e `verifySession` mantêm as assinaturas atuais (`session.ts:38,49`) recebendo `secret: string`; os call sites passam a passar `await getSessionKeyMaterial(env)` em vez de `env.SESSION_SECRET` cru. Call sites: `src/web/login.ts:55`, `src/web/sso.ts:37`, `src/web/session.ts:99` (`requireSession`).
- `handleLogoutPost` (`src/web/login.ts:69`) passa a receber `env` (ajustar a chamada em `src/web/handler.ts:100-105`) e, além de limpar o cookie, faz o bump: lê `session:epoch` do `CACHE`, grava `String(n + 1)` **sem TTL** (chave permanente, ~2 bytes). Console é single-user, então logout == logout-all por definição.
- A fingerprint do `OWNER_PASSWORD_HASH` no material faz troca de senha (novo `wrangler secret put OWNER_PASSWORD_HASH`) invalidar tudo automaticamente, sem passo manual.
- Custo: 1 leitura de KV por request autenticado dentro de `requireSession` — aceitável (KV read é cacheado no edge). Documentar: por consistência eventual do KV, o bump pode levar até ~60s pra valer em outros POPs; o objetivo é matar token roubado de 7 dias, não revogação sub-segundo.
- **Nenhuma migration**: KV é aditivo; ausência da chave `session:epoch` = epoch `'0'` (comportamento default).

### 4. Testes (novo `test/`)

Sobre o harness criado pela spec `40-ops/42` (vitest pool workers / miniflare com bindings `CACHE`, `OWNER_EMAIL`, `OWNER_PASSWORD_HASH`, `SESSION_SECRET`, `SSO_SECRET`), criar `test/console-auth.test.ts`:

- rate-limit: 5 falhas → 6ª responde 429 com `Retry-After`; backoff dobra; e-mail errado conta no bucket; sucesso limpa via `clearLoginFailures`.
- sso: URL válida → 302 com `set-cookie`; a MESMA URL de novo → 302 pro `/app/login` sem cookie; `exp` vencido → login; `sig` sobre mensagem sem nonce (formato antigo) → login.
- epoch: sessão assinada, `requireSession` ok → `POST /app/logout` → mesma sessão agora falha; sessão nova pós-bump passa; mudar `OWNER_PASSWORD_HASH` no env de teste invalida sessão antiga.

## Fora de escopo

- Multi-usuário (o Console é e continua single-owner) e OAuth/OIDC.
- Subir as iterações do PBKDF2 ou migrar de algoritmo de hash (100k é hard limit do runtime — `src/auth/password.ts:3`).
- Configurar WAF/regra de zona de fato — só a recomendação em comentário (§1).
- Rate-limit nas rotas `/app/graph/*` e no `CONTACTS_PROXY_TOKEN` (já exigem sessão ou Bearer).
- Trocar o handoff SSO de query string pra POST/fragment — o nonce single-use neutraliza o risco de URL em history/log; redesenho do transporte fica pra spec futura se necessário.
- Qualquer mudança de schema D1 — storage novo é só KV, aditivo.

## Critérios de aceite

- [ ] `POST /app/login`: 5 falhas seguidas (mesmo IP+e-mail) ainda respondem 401 com "Credenciais inválidas."; a 6ª responde **429** com `Retry-After`; o bloqueio cresce exponencialmente (15→30→60 min) com teto de 24h.
- [ ] Falha de e-mail inexistente conta no bucket igual a falha de senha (sem oráculo de e-mail).
- [ ] Login correto após falhas (antes do bloqueio) zera o bucket e cria sessão normalmente.
- [ ] Tentativa falha gera `console.warn` com IP e contagem — sem senha nem e-mail em claro na key do KV (usar hash truncado).
- [ ] `GET /app/sso` com URL assinada válida cria sessão UMA vez; a mesma URL na segunda chamada redireciona pro `/app/login` sem `set-cookie`.
- [ ] `GET /app/sso` no formato antigo (sem `nonce`) redireciona pro login — e o Brain deployado junto já emite o formato novo (`sso:${exp}:${nonce}`).
- [ ] `POST /app/logout` invalida TODAS as sessões emitidas (cookie de outro "dispositivo" simulado deixa de passar em `requireSession`), não só limpa o cookie local.
- [ ] Trocar `OWNER_PASSWORD_HASH` invalida sessões antigas sem passo manual adicional.
- [ ] Nenhuma migration D1 adicionada; nenhum dado existente alterado; ausência das chaves KV novas reproduz o comportamento default (epoch 0, bucket vazio).
- [ ] Comentário/README com recomendação de Cloudflare Rate Limiting rule pra `/app/login` e `/app/sso`.
- [ ] Módulo `src/web/rate-limit.ts` com constantes e esquema de key idênticos ao do Brain (spec `10-backend/18`) — padrão único entre os dois repos.
- [ ] `npm run typecheck` e `npm test` verdes, incluindo `test/console-auth.test.ts`.

## Validação

```bash
# no repo expert-contacts (scripts criados pela spec 40-ops/42)
npm run typecheck
npm test              # vitest run — inclui test/console-auth.test.ts
```

Teste manual em preview (`wrangler dev` ou deploy de preview — **deploy em produção SÓ com OK do dono**, e coordenado com o deploy do expert-brain por causa do formato novo do SSO):

1. 6 POSTs de senha errada em `/app/login` → o 6º responde 429 com `Retry-After`.
2. Login correto → sessão ok; abrir `/app/contacts-sso` no Brain → cai logado no Console; copiar a URL `/app/sso?...` do redirect e abrir de novo em janela anônima → cai no `/app/login` (single-use funcionando).
3. Logar em duas janelas; `POST /app/logout` numa delas → a outra perde a sessão no próximo request (tolerar ~60s de propagação KV).

## Arquivos afetados

- `src/web/login.ts` — fiação do rate-limit no `handleLoginPost`; `handleLogoutPost` recebe `env` e bumpa o epoch
- `src/web/sso.ts` — validação do nonce + marcação single-use em KV
- `src/web/session.ts` — `getSessionKeyMaterial(env)`; `requireSession` usa o material novo
- `src/web/handler.ts` — passar `env` pro `handleLogoutPost` (linha 100-105)
- `src/web/rate-limit.ts` (novo) — buckets de falha de login no KV `CACHE`
- `test/console-auth.test.ts` (novo — sobre o harness da spec `40-ops/42`)
- `wrangler.toml` ou `README.md` — comentário com recomendação de WAF/rate-limiting de zona
- **Repo expert-brain:** `src/web/contacts-sso.ts` — incluir nonce no payload assinado e na URL de redirect (mudança pequena, deployada em conjunto)

## Riscos e reversão

- **Deploy coordenado do SSO:** se o Console (formato novo) subir antes do Brain (emissor antigo), o SSO cai no fallback já existente — 302 pro login normal, sem lockout. Janela de minutos é aceitável; ainda assim, deployar Brain e Contacts na mesma sessão de release.
- **Sessões existentes morrem no deploy** (o material do HMAC muda de `SESSION_SECRET` cru pra `secret|epoch|fingerprint`): o dono re-loga uma vez. Comunicar no changelog.
- **Falso positivo de rate limit** (dono atrás de NAT errando senha): o bloqueio expira sozinho (TTL) com teto de 24h; em emergência, deletar as chaves `rl:login:*` no dash do KV `CACHE`.
- **Epoch preso** (bump acidental em loop): a chave `session:epoch` é um contador simples — deletá-la no dash volta ao epoch 0 e re-logar resolve.
- **Rollback completo:** mudanças são só de código + chaves KV aditivas, sem migration — reverter o commit e redeployar (`npm run deploy` nos dois repos) restaura o comportamento anterior; chaves `rl:*`/`ssonon:*` expiram sozinhas e `session:epoch` remanescente é ignorada pelo código antigo.
