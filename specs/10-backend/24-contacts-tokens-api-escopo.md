# Contacts: allowlist de paths pro proxy token, comparação constante e runbook de rotação

> **Status:** done · **Prioridade:** P2 · **Esforço:** S · **Repo:** expert-contacts
> **Depende de:** nenhuma

## Contexto

O Worker `expert-contacts` (Cloudflare Workers + D1 + Vectorize + R2) expõe uma API de entidades (pessoas/empresas/grafo) e co-hospeda o Expert Console sob `/app*`. A autenticação da API usa dois bearers estáticos definidos em `src/env.ts`:

- `OWNER_TOKEN` (`src/env.ts:10`) — token do dono, leitura E escrita total na API.
- `CONTACTS_PROXY_TOKEN` (`src/env.ts:22`) — token que o Worker do Brain usa via service binding pra embutir o vault contacts na UI do Brain. Foi desenhado pra ler SOMENTE o grafo (`/app/graph/data` e `/app/graph/meta`).

Hoje existem DOIS pontos de checagem do proxy token, com semânticas diferentes:

1. `src/web/handler.ts:43-53` — `proxyTokenOk()`: comparação em tempo constante (XOR por char), restrita corretamente a `GET /app/graph/data` e `GET /app/graph/meta` (`src/web/handler.ts:91-93`).
2. `src/index.ts:69-78` — `requireAuth()`: aceita o mesmo `CONTACTS_PROXY_TOKEN` pra **QUALQUER rota GET da API de entidades** (`src/index.ts:76`), com comparação `===`.

Também já existe um utilitário de comparação constante em `src/web/session.ts:31-36` (`constantTimeEqual` sobre `Uint8Array`), usado só na verificação de cookie de sessão.

A base tem milhares de contatos com PII (telefone, e-mail, notas pessoais, aniversário) nas tabelas `entities`/`events`/`media`.

## Problema / Motivação

1. **Escopo total do proxy token** — `src/index.ts:76`: `if (env.CONTACTS_PROXY_TOKEN && token === env.CONTACTS_PROXY_TOKEN && req.method === "GET") return null;`. Com esse token dá pra chamar `GET /list_entities?limit=1000` (`src/index.ts:704`, handler em `src/index.ts:518-544`), `GET /recall_entity` (`src/index.ts:702`), `GET /entities/:id` (`src/index.ts:724-725`, retorna telefone, e-mail, notas, eventos e mídia) e `GET /media/:hash` (`src/index.ts:728-729`) — ou seja, exfiltrar TODA a base de PII paginando. O secret vive como binding no Worker do Brain, cujo código é open-source e compartilhado com alunos; se vazar, o blast radius hoje é a base inteira, quando deveria ser só o payload de grafo.
2. **Comparação não constante do OWNER_TOKEN** — `src/index.ts:72`: `token === env.OWNER_TOKEN`. Comparação de string com `===` pode encerrar no primeiro byte divergente (timing side-channel teórico). O idioma correto já existe no próprio repo, duplicado em dois lugares (`src/web/handler.ts:48-52` e `src/web/session.ts:31-36`) — falta extrair pra um util e usar no `requireAuth`.
3. **Sem runbook de rotação** — não existe `docs/` no repo nem procedimento documentado pra rotacionar os dois tokens. Rotação hoje depende de memória do dono (secret no Worker + consumidores espalhados: Worker do Brain, MCPs/scripts locais).

## Objetivo

`CONTACTS_PROXY_TOKEN` passa a autorizar SOMENTE uma allowlist explícita de paths GET (definida num único módulo), toda comparação de bearer usa tempo constante, e o repo ganha runbook de rotação — sem quebrar nenhum consumidor legítimo atual.

## Design proposto

### 1. Módulo único de auth de tokens — `src/auth/tokens.ts` (novo)

Criar o arquivo com dois exports:

```ts
// Comparação de strings em tempo constante (mesmo idioma de src/web/session.ts:31).
// O vazamento do TAMANHO do token é aceitável (padrão da indústria).
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// FONTE ÚNICA do escopo do CONTACTS_PROXY_TOKEN. Sempre GET, sempre leitura.
// Racional: o token existe pro Brain (service binding) renderizar o vault
// contacts na UI e resolver contatos pontuais — grafo + lookups pontuais.
// NADA de listagem em massa (/list_entities, /list_people) nem mídia.
const PROXY_ALLOWED_EXACT = new Set([
  "/app/graph/data",
  "/app/graph/meta",
  "/recall_entity",
  "/recall_person",       // alias de /recall_entity (src/index.ts:702)
  "/get_contact_by_phone",
]);
const PROXY_ALLOWED_PATTERNS = [
  /^\/(?:entities|people)\/[0-9a-f-]+$/i, // detalhe de 1 entidade (mesmo regex de src/index.ts:724)
];

export function proxyTokenAllowsPath(path: string): boolean {
  if (PROXY_ALLOWED_EXACT.has(path)) return true;
  return PROXY_ALLOWED_PATTERNS.some((re) => re.test(path));
}
```

Documentar no topo do arquivo que este módulo é O lugar canônico do escopo — quem quiser abrir rota nova pro proxy token edita aqui e justifica no commit.

### 2. `requireAuth` em `src/index.ts`

Substituir o corpo atual (`src/index.ts:69-78`) por:

```ts
import { timingSafeEqualStr, proxyTokenAllowsPath } from "./auth/tokens";

function requireAuth(req: Request, env: Env): Response | null {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (env.OWNER_TOKEN && timingSafeEqualStr(token, env.OWNER_TOKEN)) return null;
  // CONTACTS_PROXY_TOKEN: leitura ESCOPADA — só os paths da allowlist em
  // src/auth/tokens.ts (grafo + recall + lookup por telefone + detalhe de entidade).
  if (
    env.CONTACTS_PROXY_TOKEN &&
    req.method === "GET" &&
    timingSafeEqualStr(token, env.CONTACTS_PROXY_TOKEN) &&
    proxyTokenAllowsPath(new URL(req.url).pathname)
  ) return null;
  return err(401, "unauthorized");
}
```

Efeito prático: com o proxy token, `GET /list_entities`, `GET /list_people`, `GET /list_companies`, `GET /entities/:id/media`, `GET /media/:hash` e `GET /graph/data` (da API, distinto de `/app/graph/data`) passam a responder 401. `OWNER_TOKEN` continua funcionando em tudo.

### 3. `proxyTokenOk` em `src/web/handler.ts`

Trocar o loop XOR inline (`src/web/handler.ts:49-52`) por chamada a `timingSafeEqualStr` do novo módulo (comportamento idêntico, sem duplicação). Manter a allowlist do handler (`src/web/handler.ts:91`) como está — ela já é um subconjunto (`/app/graph/data|meta`) e o gate de sessão do browser fica intacto.

Opcional (não obrigatório nesta spec): migrar `constantTimeEqual` de `src/web/session.ts` pro módulo novo — só se não gerar churn; a versão de session opera sobre `Uint8Array` e pode ficar onde está.

### 4. Runbook de rotação — `docs/rotacao-tokens.md` (novo)

Criar `docs/rotacao-tokens.md` com o procedimento (SEM valores de token — a fonte canônica dos secrets do dono fica fora do repo, em cofre próprio):

```md
# Rotação de OWNER_TOKEN e CONTACTS_PROXY_TOKEN

Ambos são bearers estáticos (secrets do Worker `expert-contacts`). Rotacionar
sempre que houver suspeita de vazamento e periodicamente (sugestão: a cada 90d).

## OWNER_TOKEN
1. Gerar valor novo: `openssl rand -hex 32` (ou equivalente).
2. Guardar no cofre de secrets do dono (fonte canônica, fora deste repo).
3. `wrangler secret put OWNER_TOKEN` (neste repo) e colar o valor novo.
4. Atualizar TODOS os consumidores que chamam a API com esse token
   (MCPs/scripts/CLIs locais do dono) a partir do cofre.
5. Validar: `curl -H "Authorization: Bearer <novo>" https://<worker>/health`
   e uma escrita de teste (`POST /event` em entidade de teste) → 200;
   token antigo → 401.

## CONTACTS_PROXY_TOKEN
1. Gerar valor novo (`openssl rand -hex 32`) e guardar no cofre.
2. `wrangler secret put CONTACTS_PROXY_TOKEN` (neste repo).
3. No repo do Brain: `wrangler secret put CONTACTS_PROXY_TOKEN` com o MESMO
   valor (é o Brain que envia esse bearer via service binding).
4. Validar: UI do Brain renderiza o vault contacts; com o token novo,
   `GET /app/graph/meta` → 200 e `GET /list_entities` → 401 (escopo).
5. Token antigo em qualquer rota → 401.

Obs.: secrets de Worker aplicam na próxima invocação — não precisa redeploy,
mas os DOIS lados (contacts e brain) precisam trocar juntos pra não abrir
janela de 401 na UI.
```

### Notas de compatibilidade

- Mudança é só de autorização em runtime — zero migration, zero alteração de dados (D1/Vectorize/R2 intactos).
- Único consumidor conhecido do proxy token é o Worker do Brain, que hoje chama apenas `/app/graph/data`, `/app/graph/meta` e lookups pontuais — todos dentro da allowlist. Antes do deploy, grepar no repo do Brain os paths chamados com `CONTACTS_PROXY_TOKEN` e conferir que todos estão na allowlist; se aparecer path fora dela, adicionar à allowlist com justificativa (nunca voltar ao "qualquer GET").

## Fora de escopo

- **Portar o modelo de PATs hasheados com escopo read/write do Brain** — explicitamente ADIADO até o selo de privacidade (spec `30-features/31`) exigir, pra não duplicar trabalho de auth. Esta spec só reduz blast radius dos bearers estáticos existentes.
- Rate limiting, audit log de acessos, expiração de token.
- Mexer no fluxo de sessão do Console (`src/web/session.ts`, login, SSO) — permanece como está.
- Escopar o `OWNER_TOKEN` (continua leitura+escrita total; é o token do dono).

## Critérios de aceite

- [x] Existe `src/auth/tokens.ts` exportando `timingSafeEqualStr` e `proxyTokenAllowsPath`, com a allowlist documentada como fonte única do escopo do proxy token.
- [x] `requireAuth` (`src/index.ts`) não contém mais `===` na comparação de nenhum token.
- [x] Com `CONTACTS_PROXY_TOKEN`: `GET /recall_entity?q=x`, `GET /get_contact_by_phone?phone=...`, `GET /entities/:id` → 200; `GET /list_entities`, `GET /list_people`, `GET /graph/data`, `GET /media/:hash`, `GET /entities/:id/media` → 401; qualquer `POST` → 401.
- [x] Com `OWNER_TOKEN`: todas as rotas (GET e POST) continuam 200 como antes.
- [x] `proxyTokenOk` em `src/web/handler.ts` usa `timingSafeEqualStr` (loop XOR inline removido) e `GET /app/graph/{data,meta}` com o proxy token continua 200.
- [x] `docs/rotacao-tokens.md` existe, cobre os dois tokens, e não contém nenhum valor de secret.
- [x] UI do Console no browser (sessão via cookie) segue funcionando sem mudança.
- [ ] Pós-deploy: rotação dos dois tokens ADIADA pelo dono em 07/07/2026 ("nao precisa rotacionar nada agora") — runbook pronto pra quando autorizar.

## Validação

```bash
# typecheck (repo não tem vitest — validação é tsc + curl)
cd C:/repos/expert-contacts && npx tsc --noEmit

# dev local
npx wrangler dev
# matriz de auth (usar tokens de dev):
curl -s -H "Authorization: Bearer $PROXY" "http://localhost:8787/recall_entity?q=teste"        # 200
curl -s -H "Authorization: Bearer $PROXY" "http://localhost:8787/list_entities"                 # 401
curl -s -H "Authorization: Bearer $PROXY" "http://localhost:8787/app/graph/meta"                # 200
curl -s -X POST -H "Authorization: Bearer $PROXY" "http://localhost:8787/save_person" -d '{}'   # 401
curl -s -H "Authorization: Bearer $OWNER" "http://localhost:8787/list_entities?limit=1"         # 200
curl -s -H "Authorization: Bearer errado" "http://localhost:8787/recall_entity?q=x"             # 401
```

Deploy (`npm run deploy`) SOMENTE com OK do dono. Após deploy, validar a UI do Brain (vault contacts renderiza) e então executar a rotação dos dois tokens (runbook) — também gated no OK do dono.

## Arquivos afetados

- `src/auth/tokens.ts` (novo — util de comparação constante + allowlist canônica)
- `src/index.ts` (`requireAuth`, ~linhas 69-78)
- `src/web/handler.ts` (`proxyTokenOk`, ~linhas 42-53)
- `src/env.ts` (só comentário do `CONTACTS_PROXY_TOKEN`, apontando pra allowlist)
- `docs/rotacao-tokens.md` (novo — runbook de rotação)

## Riscos e reversão

- **Risco principal:** o Brain (ou outro consumidor não mapeado) chamar com o proxy token um path GET fora da allowlist → 401 e feature quebrada na UI do Brain. Mitigação: grep prévio no repo do Brain; correção é adicionar o path à allowlist (1 linha em `src/auth/tokens.ts`) e redeploy.
- **Risco menor:** regressão no `requireAuth` bloqueando o `OWNER_TOKEN` — coberto pela matriz de curl acima antes do deploy.
- **Reversão:** mudança é código puro, sem migration e sem alteração de dados. Rollback = `git revert` do commit + `npm run deploy` (ou `wrangler rollback` pro deployment anterior). Se a rotação já tiver acontecido, os tokens NOVOS continuam válidos após o rollback (secrets independem do código) — nada a desfazer nos secrets.
