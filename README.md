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

> **O caminho ideal: deixe o Claude Code instalar pra você.** Abra o [Claude Code](https://claude.com/claude-code) numa pasta vazia e cole o prompt abaixo. Ele confere os pré-requisitos, roda os comandos desta seção e, a cada etapa que acontece no navegador, pergunta se você quer que ele mesmo faça (dirigindo o browser) ou se prefere fazer à mão com ele guiando clique a clique. Os passos manuais desta seção continuam valendo pra quem prefere fazer tudo sozinho.

```text
Clone https://github.com/Expert-Integrado/expert-brain e faça a instalação guiada completa do Expert Brain na minha conta Cloudflare, seguindo este protocolo:

1. PRÉ-REQUISITOS: confira Node 18+ (node --version) e o wrangler (npx wrangler --version). Se faltar algo, resolva comigo antes de seguir.

2. ETAPAS DE NAVEGADOR: o setup tem etapas que acontecem num navegador real — criar a conta Cloudflare (https://dash.cloudflare.com/sign-up), autorizar o "npx wrangler login" (abre o browser pra clicar Allow), conferir o account_id no dash se não der pra extrair do "npx wrangler whoami", criar um API token em https://dash.cloudflare.com/profile/api-tokens (só na rota alternativa via CLOUDFLARE_API_TOKEN, em vez do login), habilitar o billing pro R2 (opcional, mídia/backup) e autorizar o OAuth na primeira conexão do MCP. Para CADA uma delas, me pergunte com botões (AskUserQuestion): "Essa etapa é no navegador. Quer que eu faça pra você?"
   - Rota padrão: você dirige o navegador via Playwright MCP. Se não estiver instalado: claude mcp add playwright -- npx -y @playwright/mcp@latest
   - Alternativa: Claude in Chrome, no meu Chrome com as minhas sessões.
   - Login e senha quem digita sou EU, no navegador — nunca me peça senha de conta no chat.
   - Se eu preferir manual, me guie passo a passo e aguarde eu confirmar cada clique.

3. VALIDAÇÃO: valide cada etapa com um comando real antes de ir pra próxima (npx wrangler whoami depois do login; deploy e curl <worker-url>/status depois do provision). Falhou, pare e me mostre o erro — não siga por cima.

4. SEGREDOS: valores sensíveis só via wrangler secret put ou .env local — nunca em arquivo commitado, nunca colados no chat.

5. TESTE FINAL: conecte o MCP (claude mcp add --transport http expert-brain <worker-url>/mcp), salve uma nota de teste e faça um recall que a encontre, provando o ciclo de ponta a ponta. Termine com um resumo: URL do Worker, endpoint MCP, o que ficou configurado e próximos passos.
```

O Expert Brain completo são **dois Workers** na sua conta Cloudflare, os dois dentro do free tier:

1. **`expert-brain`** (este repo) — notas, grafo, tasks, MCP e console. É o essencial; sozinho já entrega tudo menos contatos.
2. **`expert-contacts`** ([repo próprio](https://github.com/Expert-Integrado/expert-contacts)) — **opcional**: o vault de contatos (pessoas, empresas, timeline, menções `@` nas notas). Instale depois, quando quiser — o passo 6 abaixo explica.

**Pré-requisitos:**
- Node.js 18+ (recomendado 20+) ([nodejs.org](https://nodejs.org))
- Conta Cloudflare gratuita ([cadastro](https://dash.cloudflare.com/sign-up)) — **sem cartão**; a única exceção é a mídia/backup via R2, que exige habilitar billing (continua US$ 0 dentro do free tier)

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

**Como os hooks avisam de tarefas (política de cobrança).** Os 7 hooks instalados seguem uma regra única: **cobrança de tarefa vencida acontece só na abertura da sessão** — o agente abre a primeira resposta com "Antes de começarmos:" + as tasks do dia/atrasadas e só então responde o pedido. Na compactação o hook lembra de salvar aprendizados e de manter o ciclo de vida das tasks (criar/atualizar/concluir), **sem** relistar pendências. A única exceção é o `overdue-nudge`: sessão aberta há 5h+ ganha no máximo 1 lembrete a cada 2h, e só de task **vencida** (nunca "vence hoje"). Instalação antiga cobrando tasks no meio da sessão? Rode `node scripts/install-claude-hooks.mjs <url do worker>` de novo — ele regrava os hooks e o matcher corretos.

### 4. Primeiro acesso

Abra a URL impressa pelo setup (`https://<seu-worker>.workers.dev/app/login`) e entre com o e-mail e a senha que você definiu.

### 5. Conectar ao Claude

```bash
claude mcp add --transport http expert-brain https://<seu-worker>.workers.dev/mcp
```

A primeira conexão abre o fluxo OAuth 2.1 no browser. Depois, abra `/app/config` no console e cole o bloco de instruções do dono em *Claude → Settings → Personalization → Custom instructions* — ele entra no handshake de todo agente conectado.

### 6. (Opcional) O segundo Worker: vault de contatos

Contatos moram num Worker separado de propósito — banco próprio (D1 dele), privacidade própria, ciclo de deploy próprio. O Brain fala com ele por **service binding** (Worker-a-Worker, dentro da Cloudflare, sem token no browser). É o que liga: menções `@contato` em notas e tasks, a aba **Contatos** do console com dossiê e timeline, e os painéis de integração (WhatsApp, Instagram, Pipedrive) em `/app/config`.

Setup no [repo do expert-contacts](https://github.com/Expert-Integrado/expert-contacts) (mesma conta Cloudflare, mesmo free tier). Depois de deployá-lo, conecte os dois lados:

1. No `wrangler.toml` **deste** repo, descomente/adicione o service binding `CONTACTS` apontando pro Worker `expert-contacts`, e redeploye.
2. Crie dois tokens (strings aleatórias longas) e suba **o mesmo valor nos dois Workers**: `CONTACTS_PROXY_TOKEN` (leitura) e `CONTACTS_WRITE_TOKEN` (escrita escopada — só registra eventos de timeline). No lado do contacts eles são validados contra uma allowlist de rotas; qualquer outra rota responde 401.
3. (Opcional) `SSO_SECRET` igual nos dois pra abrir o console de contatos já logado a partir do Brain.

Sem esse passo, nada quebra: as tools de contato respondem com um erro explicando que o vault não está configurado, e o resto do Brain funciona normal.

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
