# Expert Brain

**Um grafo de conhecimento pessoal (latticework) que roda 100% na sua conta Cloudflare e conversa com o Claude via MCP.**

[![CI](https://github.com/Expert-Integrado/expert-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/Expert-Integrado/expert-brain/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40expertintegrado%2Fcreate-expert-brain)](https://www.npmjs.com/package/@expertintegrado/create-expert-brain)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[→ Como funciona o Expert Brain](https://expert-integrado.github.io/expert-brain/)** — a página do projeto, com o sistema explicado visualmente.

Você conversa com o Claude sobre uma ideia. Ele chama `recall`, varre o vault atrás de analogias em outros domínios, e só então oferece salvar a nota — atomizada, com `tldr` de uma frase e edges que nomeiam o *mecanismo* compartilhado com o que você já tinha guardado. Não é um app de notas: é uma disciplina de pensamento cross-domain embrulhada num servidor MCP, com um dashboard web por cima.

## O que é

Single-user, self-hosted, sem terceiros: seus dados vivem no D1/Vectorize/R2 da sua própria conta Cloudflare, não numa API de alguém.

- **~32 tools MCP** — conhecimento (`save_note`, `recall`, `expand`, `link`, `get_note`, `update_note`, `delete_note`/`restore_note`, `reembed`, `stats`), tasks em kanban (`save_task`, `list_tasks`, `list_tasks_due_today`, `update_task`, `complete_task`, `comment_task`, `share_task`/`unshare_task`), captura rápida (`capture`, `list_inbox`, `resolve_inbox`), digest de resurfacing, mídia em notas (opcional, via R2) e leitura de um vault de contatos separado (opcional, via service binding).
- **Console web (`/app`)** — home, busca global Ctrl+K, grafo interativo 2D (Sigma.js + d3-force em Web Worker) e 3D, kanban de tasks com colunas e projetos customizáveis, journal, notas com comentários, contatos com dossiê/timeline, página de configuração (domínios, instruções do dono, API keys com escopo, backup manual).
- **Grafo com 9 tipos de edge** (`analogous_to`, `same_mechanism_as`, `causes`, `contradicts`, `refines`, …) e **7 kinds de nota** (`concept`, `decision`, `insight`, `fact`, `pattern`, `principle`, `question`) — `task` mora na mesma tabela mas fica fora do grafo e do recall.
- **Recall híbrido balanceado por domínio**: embedding (`bge-m3` via Workers AI, multilíngue) + FTS5, no máximo 3 notas por domínio até 5 domínios distintos — o objetivo é trazer a conexão inesperada, não só o hit mais óbvio.
- **Privacidade por nota/task** (`mark_private`) e **PATs com escopo** (`full` / `read` / `+private`) — uma credencial com escopo `read` nem enxerga as tools de escrita no `tools/list`.
- **Share público read-only** de nota ou task por link (`/s/<token>`), com expiração e revogação.
- **Backup automático**: snapshot semanal D1 → R2 via cron (segunda-feira), mais backup manual pelo console.
- **PWA**: manifest + share target — dá pra instalar o console e mandar conteúdo pra ele direto de outro app.
- **12 domínios canônicos** trancados por validação (`management`, `sales`, `marketing`, `education`, `ai-applied`, `leadership`, `product`, `operations`, `personal-development`, `entrepreneurship`, `music`, `cognitive-science`), com escape hatch (`allow_new_domain`) e domínios customizados via `/app/config`.

## Arquitetura

```
                    ┌──────────────────────────┐
   Claude Code /    │                          │
   Desktop / Web  ─▶│   /mcp   (OAuth 2.1 ou   │
   (cliente MCP)    │           PAT eb_pat_*)  │
                    │                          │
   Browser        ─▶│   /app/*  (sessão por    │      Cloudflare Worker
   (console web)     │           cookie)        │      (endpoint único)
                    │                          │
                    │   /s/<token>  (share      │
                    │    público read-only)     │
                    └────────────┬─────────────┘
                                 │
              ┌──────────────────┼──────────────────┬───────────────┐
              ▼                  ▼                  ▼               ▼
        ┌──────────┐      ┌────────────┐     ┌────────────┐  ┌──────────┐
        │    D1     │      │ Vectorize  │     │ Workers AI │  │    R2    │
        │ (SQLite)  │      │ 1024-dim   │     │  bge-m3    │  │  mídia + │
        │ notas +   │      │  cosine    │     │ embeddings │  │  backup  │
        │ edges+FTS5│      │            │     │            │  │(opcional)│
        └──────────┘      └────────────┘     └────────────┘  └──────────┘
                                 │
                          ┌────────────┐
                          │     KV     │
                          │ OAuth +    │
                          │ cache do   │
                          │   grafo    │
                          └────────────┘
```

Um único Worker (`src/index.ts`) serve as três superfícies acima na mesma URL. Bindings (declarados em `wrangler.toml`, gerados pelo setup):

| Binding | Serviço | Função |
|---|---|---|
| `DB` | D1 | Notas, edges, tags, tasks, FTS5 |
| `VECTORIZE` | Vectorize | Índice 1024-dim cosine, um vetor por nota |
| `AI` | Workers AI | Embeddings multilíngues (`@cf/baai/bge-m3`) |
| `OAUTH_KV` | KV | Grants/tokens/registros de cliente OAuth |
| `GRAPH_CACHE` | KV | Layout pré-computado do grafo, cacheado |
| `MEDIA` *(opcional)* | R2 | Anexos de nota — exige billing habilitado; sem ele o Brain sobe sem mídia |
| `CONTACTS` *(opcional)* | Service binding | Leitura de um Worker de contatos separado — sem ele, as tools de contato continuam listadas mas respondem com um erro explicando que o vault de contatos não está configurado |
| `MCP_OBJECT` | Durable Object | Estado da sessão MCP (`ExpertBrainMCP`) |

Dois crons (`[triggers]` no `wrangler.toml`): digest diário de tasks vencendo/atrasadas (dormente até você configurar `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`) e snapshot semanal de backup pro R2.

## Instalação

**Pré-requisitos:**
- Node.js 18+ (recomendado 20+) ([nodejs.org](https://nodejs.org))
- Conta Cloudflare gratuita, sem cartão ([cadastro](https://dash.cloudflare.com/sign-up))

### 1. Criar o projeto

```bash
npm create @expertintegrado/expert-brain@latest expert-brain
cd expert-brain
```

O scaffolder (`@expertintegrado/create-expert-brain`) copia o template — código-fonte, scripts, `wrangler.example.toml`, `CLAUDE.md` — pra pasta nova. O repo carrega um `.npmrc` com `legacy-peer-deps=true`: é intencional, porque `agents@0.17.x` declara peers opcionais (`ai`/`chat`/`x402`) que o resolver do npm não fecha sozinho e o runtime usa só `agents/mcp`. Sem essa flag, `npm install` cai em `ERESOLVE`.

```bash
npm install
```

### 2. Autenticar na Cloudflare

```bash
npx wrangler login    # abre o browser, clica "Allow"
```

### 3. Setup automático

```bash
npm run setup
```

Isso roda `scripts/setup.mjs`, que faz em um comando o que seria um runbook de 11 passos: verifica a autenticação, copia `wrangler.example.toml` → `wrangler.toml`, pergunta e-mail + senha de dono (12+ caracteres), **cria os recursos na sua conta Cloudflare** (D1, Vectorize, os 2 namespaces KV — pula o que já existir, é idempotente), grava os IDs reais no `wrangler.toml`, gera o hash PBKDF2 da senha + `SESSION_SECRET`, sobe os secrets (`wrangler secret put`), faz `wrangler deploy`, chama `POST /setup/provision` pra rodar as migrations no D1, e instala os hooks de captura automática do Claude Code (se preferir rodar depois: `node scripts/install-claude-hooks.mjs <url>`). Ao final imprime a URL do Worker, o comando MCP e o link do dashboard.

> Sem billing habilitado na Cloudflare (R2 exige, mesmo dentro do free tier)? O setup detecta e sobe **sem mídia** — todo o resto funciona normal.

Pra reprovisionar do zero (trocar senha, recriar recursos): `npm run setup -- --reinstall`.

### 4. Primeiro acesso

Abra a URL impressa pelo setup (`https://<seu-worker>.workers.dev/app/login`) e entre com o e-mail e a senha que você definiu.

### 5. Conectar ao Claude

```bash
claude mcp add --transport http expert-brain https://<seu-worker>.workers.dev/mcp
```

A primeira conexão abre o fluxo OAuth 2.1 no browser. Depois, abra `/app/config` no console e cole o bloco de instruções do dono em *Claude → Settings → Personalization → Custom instructions* — ele entra no handshake de todo agente conectado.

### Atualizando

Cada instalação roda no **seu próprio** Worker — atualizar é buscar o código novo e redeployar; dados e login continuam intactos (vivem no D1/Vectorize, não no código). Dois cenários:

- **Instalou pelo scaffolder** (`npm create`): a pasta não é um clone git. Baixe o código novo por cima ([zip do repo](https://github.com/Expert-Integrado/expert-brain/archive/refs/heads/main.zip)) preservando o seu `wrangler.toml`, ou clone o repo numa pasta nova e copie o `wrangler.toml` provisionado pra ela.
- **Clonou o repo**: `git pull` direto.

Nos dois casos, depois:

```bash
npm install
npm run setup        # idempotente — redescobre os recursos existentes por nome, redeploya sem pedir e-mail/senha de novo
```

## Uso rápido

**Salvar uma ideia** (o Claude decide chamar `save_note` depois de um `recall`):

> "Acabei de sacar que tech debt se comporta como juros compostos — quanto mais você ignora, pior fica a taxa."

**Buscar no vault:**

> "O que eu já pensei sobre feedback loops?" → o Claude chama `recall("feedback loops")`, lê os domínios retornados e traz o que for relevante.

**Criar e consultar uma task:**

> "Cria uma task pra revisar o contrato até sexta." → `save_task`.
> "O que vence hoje?" → `list_tasks_due_today`.

**Ver o grafo:** abra `https://<seu-worker>.workers.dev/app/graph` — grafo 2D navegável; `?mode=3d` pra visualização 3D.

**Editar ou remover:** `update_note`/`update_task` mudam campos existentes; `delete_note` é soft-delete (recuperável a qualquer momento via `restore_note`, sem prazo).

## Documentação e novidades

- [`CHANGELOG.md`](CHANGELOG.md) — release notes por versão (o que mudou em cada release).
- [Expert Brain — como funciona](https://expert-integrado.github.io/expert-brain/) — página pública explicando o sistema (GitHub Pages).
- [`RELEASING.md`](RELEASING.md) — runbook de publicação do pacote npm; a versão atual e o histórico de releases ficam em [GitHub Releases](https://github.com/Expert-Integrado/expert-brain/releases).
- [`docs/token-cost.md`](docs/token-cost.md) — breakdown de custo em tokens do overhead do MCP por plano do Claude.
- [`docs/observability.md`](docs/observability.md), [`docs/restore.md`](docs/restore.md), [`docs/curation-runbook.md`](docs/curation-runbook.md) — runbooks operacionais.
- `/app/novidades` no seu próprio console — changelog voltado pro dono da instância.

## Desenvolvimento

```bash
npm install
npm run dev            # wrangler dev (Miniflare local)
npm test                # vitest run + vitest run --config vitest.auth.config.ts
npm run typecheck       # tsc --noEmit na raiz + em src/web/client/tsconfig.json
npm run build:bundles   # empacota src/web/client → assets/*.bundle.js
npm run deploy          # build:bundles + wrangler deploy + POST /setup/provision (scripts/deploy.mjs)
```

Os testes rodam em dois pools: o principal (`vitest.config.ts`, D1 + tools MCP com Vectorize/Workers AI mockados) e um pool node separado (`vitest.auth.config.ts`) pro módulo de hash de senha, isolado das restrições do runtime dos Workers.

O desenvolvimento é **spec-driven**: toda mudança relevante nasce como uma spec em [`specs/`](specs/README.md), pensada pra um agente de IA executar sem contexto externo. Antes de contribuir, leia `specs/README.md` (o protocolo) e `specs/90-roadmap.md` (a sequência de fases e gates).

---

Feito pela [Expert Integrado](https://expertintegrado.com.br).
