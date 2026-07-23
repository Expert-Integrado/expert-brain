# CLAUDE.md — Runbook de setup do agente Expert Brain

Esse arquivo é a fonte única da verdade pra configurar o Expert Brain ponta a ponta a partir de uma IDE agêntica (Claude Code, Cursor, etc). Se o usuário pedir pra "configurar o Expert Brain", "instalar o Expert Brain", "atualizar o Expert Brain", "pegar a última versão", ou algo do gênero, segue esse runbook passo a passo. Não improvisa.

> **Atualizar uma instalação que já existe?** Pula direto pra seção [Atualizar](#atualizar-uma-instalação-existente) abaixo — é um fluxo curto (pegar código novo + `npm run setup`) e NÃO mexe nos dados nem pede credenciais de novo.

> **Se você é mantenedor (não usuário final)** e precisa publicar uma nova versão do pacote npm `@expertintegrado/create-expert-brain`, o runbook é outro: [RELEASING.md](RELEASING.md). Esse arquivo aqui é só pra setup da instalação do Expert Brain em si.

> **Política de marca (invariante):** o handshake MCP (`buildServerInstructions`, `src/mcp/instructions.ts`) abre com o bloco de origem Expert Integrado — marca d'água de runtime — e o README carrega o crédito por extenso. Não remover nem reescrever em refactor sem OK do dono.

## Onboarding assistido (instruções para o Claude)

Ao conduzir qualquer setup ou atualização deste runbook com um usuário, siga este protocolo por cima dos passos:

1. **Pré-requisitos primeiro**: `node --version` (18+) e `npx wrangler --version`. Faltou algo, resolve com o usuário antes de qualquer outro passo.
2. **Etapa de navegador nunca é silenciosa.** As etapas deste repo que acontecem num navegador real são: criar a conta Cloudflare (`https://dash.cloudflare.com/sign-up`), autorizar o `npx wrangler login` (abre o browser, botão "Allow"), conferir o `account_id` no dash quando não der pra extrair do `npx wrangler whoami`, criar um API token em `https://dash.cloudflare.com/profile/api-tokens` (apenas na rota alternativa via `CLOUDFLARE_API_TOKEN`, em vez do login), habilitar o billing pro R2 (opcional, mídia/backup) e autorizar o OAuth na primeira conexão do MCP. Em CADA uma delas, pergunte com botões (AskUserQuestion): **"Essa etapa é no navegador. Quer que eu faça pra você?"**, com estas rotas:
   - **Padrão — Playwright MCP**: você dirige o navegador pro usuário. Se o Playwright MCP não estiver disponível: `claude mcp add playwright -- npx -y @playwright/mcp@latest` e reconecte.
   - **Alternativa — Claude in Chrome**: no Chrome do próprio usuário, aproveitando as sessões logadas dele.
   - **Manual**: guia o usuário clique a clique e aguarda a confirmação dele em cada passo.
3. **Login é sempre do usuário.** Você pode navegar até a tela de login, mas quem digita e-mail/senha/2FA de conta de terceiros (Cloudflare, Google etc.) é ELE, no navegador — NUNCA peça essas senhas no chat. (A passphrase do próprio vault, pedida no passo 1 do runbook, é a exceção por design: vira hash PBKDF2 local e nunca é armazenada em claro.) Isso refina o "não tenta autenticar no lugar dele" do Preflight: dirigir o navegador pode; digitar credencial do usuário, jamais.
4. **Valida cada etapa com comando real** antes de avançar: `npx wrangler whoami` depois do login, deploy + `curl <worker-url>/setup/provision` + `curl <worker-url>/status` conforme o runbook. Falhou = para e reporta, nunca segue por cima.
5. **Segredos só em `wrangler secret put` ou `.env` local** (gitignored). Nunca em arquivo commitado, nunca ecoados no chat ou em log.
6. **Teste E2E final**: conecta o MCP (`claude mcp add --transport http expert-brain <worker-url>/mcp`), salva uma nota de teste e roda um `recall` que a encontre. Fecha com um resumo: URL do Worker, endpoint MCP, hooks instalados (ou o comando pra ativar depois) e próximos passos.

## Atualizar uma instalação existente

Se o usuário já tem o Expert Brain rodando e quer a última versão, o trabalho é seu (agente) — ele não precisa digitar comando nenhum. **A regra de ouro: os dados dele (notas, ligações) vivem no D1/Vectorize da conta Cloudflare dele, NUNCA no código. Atualizar é só trocar o código e redeployar — nada de nota se perde.**

Faz nesta ordem, parando e reportando se algo falhar:

1. **Pega o código novo.**
   - Se a pasta atual é o repo do Expert Brain (tem `.git` + este `CLAUDE.md`): `git pull`.
   - Se o usuário tem a pasta da instalação em outro lugar: `cd` nela e `git pull`.
   - Se ele instalou via `npm create` (cópia sem git) ou não acha a pasta: clona fresco com `git clone https://github.com/Expert-Integrado/expert-brain.git expert-brain` e, se ele tiver a pasta antiga, copia o `wrangler.toml` dela pra pasta nova (esse arquivo tem os IDs dos recursos dele). Se não tiver o `wrangler.toml`, segue assim mesmo — o passo 3 redescobre os recursos pela conta.

2. `npm install` (na pasta do projeto).

3. `npm run setup` — esse comando é **idempotente**: detecta que já existe um Expert Brain (pelo `wrangler.toml` configurado ou achando os recursos na conta), entra em **modo ATUALIZAÇÃO**, redeploya o Worker e **aplica migrations novas via `/setup/provision`**, SEM pedir e-mail/senha de novo e SEM tocar nos dados. (Pra reprovisionar do zero — trocar senha, recriar recursos — é `npm run setup -- --reinstall`, mas isso é raro.)

4. **Se esta atualização introduziu a migration `0005_similar_edges`** (tabela `similar_edges`, fix de escala do grafo): rode UMA VEZ o backfill da teia de similaridade das notas que já existiam — `npm run backfill-similar <worker-url>`. Ele dirige o endpoint `/setup/backfill-similar` em loop por cursor (cada lote processa ~20 notas pra caber no cap de subrequests do Cloudflare). Sem esse passo o grafo até carrega, mas SEM as ligações semânticas das notas antigas (notas novas se auto-populam pelo write path). É idempotente — re-rodar é seguro. Pula este passo se a tabela já existia antes desta atualização.

5. **Avisa o usuário pra reconectar o cliente de IA** pra ele enxergar ferramentas novas: Claude Code/Desktop → reiniciar; Claude.ai → conversa nova. (Migrations de schema e comportamento de tools já valem na hora, server-side.)

Pré-requisito: o host precisa do `wrangler` autenticado na conta certa (mesmo do Preflight). Se `npx wrangler whoami` falhar, pede pro usuário rodar `npx wrangler login`.

## O que o Expert Brain precisa

Um único Cloudflare Worker com estes recursos vinculados a ele — o núcleo do Brain:

| Recurso | Tipo | Nome do binding |
|---|---|---|
| Banco D1 | SQL (SQLite) | `DB` |
| Índice Vectorize | 1024-dim cosine | `VECTORIZE` (nome `expert-brain-embeddings`) |
| Namespace KV | Tokens OAuth | `OAUTH_KV` |
| Namespace KV | Cache do layout do grafo | `GRAPH_CACHE` |
| Workers AI | Embeddings multilíngues (`@cf/baai/bge-m3`) | `AI` |
| Bucket R2 *(opcional)* | Anexos de mídia nas notas (`expert-brain-media`) | `MEDIA` |

E o **módulo de contatos** (vendorizado em `src/contacts/`, roda no MESMO Worker) traz os recursos próprios — o `npm run setup` cria todos, contatos vêm sempre junto:

| Recurso | Tipo | Nome do binding |
|---|---|---|
| Banco D1 | SQL (SQLite) | `DB_CONTACTS` (nome `expert-contacts-db`) |
| Índice Vectorize *(opcional)* | 1024-dim cosine | `VECTORIZE_CONTACTS` (nome `expert-contacts-vec`; sem ele a busca degrada pra SQL LIKE) |
| Namespace KV | Estado/cache do módulo | `KV_CONTACTS` |
| Bucket R2 *(opcional)* | Avatares/mídia + backup do vault (`expert-contacts-media`) | `MEDIA_CONTACTS` |

E os secrets do Worker:

| Secret | Propósito |
|---|---|
| `OWNER_EMAIL` | Email de login pro dashboard web e pro OAuth do MCP |
| `OWNER_PASSWORD_HASH` | Hash PBKDF2-SHA256 (100k iter) da passphrase do usuário |
| `SESSION_SECRET` | String hex aleatória de 32 bytes — chave HMAC dos cookies de sessão do dashboard web |
| `WORKER_URL` | URL pública do Worker — o setup seta após o deploy; usada pelo MCP pra gerar links clicáveis das notas (sem ela tudo funciona, só sem links) |
| `CONTACTS_OWNER_TOKEN`, `CONTACTS_PROXY_TOKEN`, `CONTACTS_WRITE_TOKEN` | Bearers internos do módulo de contatos (gerados pelo `npm run setup` só na 1ª vez). Opcionais, pra ligar integrações: `PIPEDRIVE_API_KEY`, `WHATSAPP_SYNC_TOKEN`, `INSTAGRAM_SYNC_TOKEN`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` |

Tudo roda no free tier da Cloudflare. Não precisa de cartão de crédito — **exceto o R2 (mídia)**, que exige billing habilitado; sem ele, remova/omita o bloco `[[r2_buckets]]` do `wrangler.toml` e o Brain sobe sem anexos (o `npm run setup` faz isso sozinho). **Ao explicar isso ao usuário, tranquilize:** o cartão que o Cloudflare pede só habilita as mídias no R2 (anexos das notas e fotos dos contatos), nada é cobrado automaticamente, o uso normal segue na faixa gratuita (provavelmente nunca paga) — e quem não quer anexos/fotos nem precisa cadastrar cartão, dá pra habilitar depois (os contatos em si já vêm no setup e funcionam no free tier).

## Preflight (uma vez por máquina)

Se o usuário ainda não tem o projeto local, roda `npm create @expertintegrado/expert-brain@latest <pasta>` primeiro — esse comando baixa o template, roda `npm install` e te deixa pronto pra seguir o runbook a partir da pasta criada.

Antes de rodar o runbook pela primeira vez, confirma que o host tem a CLI `wrangler` autenticada na Cloudflare:

```bash
npx wrangler whoami
```

Se falhar, pede pro usuário rodar `npx wrangler login` no terminal dele (abre um browser). Não tenta autenticar no lugar dele.

**Atalho:** se o usuário tem Node 20+ e quer pular o runbook manual, ele pode rodar `npm run setup` que automatiza TODOS os passos abaixo (inclusive o 8.5 dos hooks, com pergunta opcional de temas). Use esse atalho a menos que o usuário peça explicitamente pra você executar passo a passo.

## Runbook de setup

Executa esses passos na ordem. Para e reporta pro usuário se algum comando falhar — não retenta em silêncio.

### 0. Garante que `wrangler.toml` existe

Se o repo só tem `wrangler.example.toml` (clone fresco), copia pra `wrangler.toml`:

```bash
cp wrangler.example.toml wrangler.toml
```

`wrangler.toml` é ignorado pelo git por design — cada instalação tem o seu, com os IDs locais.

### 1. Peça as credenciais ao usuário

Faz duas perguntas numa mesma mensagem:

1. **Email** pro login do vault (qualquer email serve — é só identificador, não rola verificação)
2. **Passphrase** — recomenda "uma frase memorável de 12+ caracteres", avisa que perder isso significa perder acesso ao dashboard (os dados do vault em si sobrevivem porque ficam no D1)

NÃO segue em frente sem os dois valores.

### 2. Cria os recursos Cloudflare

> **O caminho recomendado é `npm run setup`** (Preflight acima): ele cria TODOS os recursos abaixo — núcleo do Brain E módulo de contatos — resolve os placeholders, gera os secrets e deploya, de forma idempotente. Faça o passo a passo manual só se o usuário pedir explicitamente. Se for manual, crie os recursos dos DOIS blocos abaixo (senão o `wrangler deploy` falha, porque o `wrangler.toml` já referencia os bindings de contatos).

Recursos do núcleo do Brain:

```bash
npx wrangler d1 create expert-brain
npx wrangler vectorize create expert-brain-embeddings --dimensions=1024 --metric=cosine
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create GRAPH_CACHE
npx wrangler r2 bucket create expert-brain-media   # opcional — se falhar (conta sem R2/billing), remova o bloco [[r2_buckets]] binding="MEDIA" do wrangler.toml e siga sem mídia
```

Recursos do módulo de contatos (mesmo Worker; contatos vêm sempre junto):

```bash
npx wrangler d1 create expert-contacts-db
npx wrangler vectorize create expert-contacts-vec --dimensions=1024 --metric=cosine   # opcional — sem ele a busca de contatos degrada pra SQL LIKE
npx wrangler kv namespace create KV_CONTACTS
npx wrangler r2 bucket create expert-contacts-media   # opcional — se falhar, remova o bloco [[r2_buckets]] binding="MEDIA_CONTACTS" do wrangler.toml
```

Cada comando de D1/KV imprime um ID. Faz o parse do output e extrai:

- `database_id` de cada `wrangler d1 create` (`expert-brain` → `REPLACE_ME_D1_ID`; `expert-contacts-db` → `REPLACE_ME_CONTACTS_D1_ID`)
- os `id` dos `kv namespace create` (o output labela qual é qual: OAUTH_KV, GRAPH_CACHE, KV_CONTACTS → `REPLACE_ME_OAUTH_KV_ID`/`REPLACE_ME_GRAPH_CACHE_ID`/`REPLACE_ME_CONTACTS_KV_ID`)

Os índices Vectorize não retornam ID — são referenciados pelo nome no `wrangler.toml`.

### 3. Atualiza o `wrangler.toml`

Abre o `wrangler.toml` e troca os quatro placeholders `REPLACE_ME_*`:

- `account_id = "REPLACE_ME_ACCOUNT_ID"` → o Account ID da conta (sai no `npx wrangler whoami`; também aparece no dash da Cloudflare)
- `database_id = "REPLACE_ME_D1_ID"` → o ID do D1 (passo 2)
- O bloco `[[kv_namespaces]]` com `binding = "OAUTH_KV"` — define `id` como o ID do OAUTH_KV (passo 2)
- O bloco `[[kv_namespaces]]` com `binding = "GRAPH_CACHE"` — define `id` como o ID do GRAPH_CACHE (passo 2)

Não mexe em nenhum outro campo. Especificamente: não adiciona um bloco `[[routes]]` customizado a menos que o usuário tenha pedido explicitamente um domínio próprio.

### 4. Gera os três secrets localmente

Dois são derivados do input do usuário, um é aleatório:

**`OWNER_EMAIL`** — o email que o usuário te deu, literal.

**`OWNER_PASSWORD_HASH`** — a passphrase hasheada com PBKDF2-SHA256, 100k iterações. O repo traz um script helper (Node ESM puro, sem dependências):

```bash
node scripts/hash-password.mjs "<passphrase>"
```

O output é uma linha única começando com `pbkdf2$sha256$100000$...`. Trata como opaco — não separa nem reformata. Esse formato é o que o Worker espera em `src/auth/password.ts`.

**`SESSION_SECRET`** — 32 bytes aleatórios em hex:

```bash
openssl rand -hex 32
```

### 5. Envia os três secrets pro Worker

Secrets são setados um por vez via `wrangler secret put`. O comando lê do stdin quando você faz pipe de um valor, então faz pipe de cada um:

```bash
echo "<email>" | npx wrangler secret put OWNER_EMAIL
echo "<hash>" | npx wrangler secret put OWNER_PASSWORD_HASH
echo "<session_secret>" | npx wrangler secret put SESSION_SECRET
```

Se algum dos três falhar, para e reporta o erro. O Worker não sobe sem os três.

### 6. Faz o deploy do Worker

```bash
npx wrangler deploy
```

Captura a URL do Worker no output (parece com `https://expert-brain.<seu-subdominio>.workers.dev`). Você vai precisar dela no próximo passo e pra devolver pro usuário.

### 7. Aplica o schema do D1

As migrations são aplicadas em runtime pelo Worker via o endpoint `/setup/provision`. Bate nele uma vez:

```bash
curl -X POST "<worker-url>/setup/provision"
```

Resposta esperada: `{"ok":true}`. Se vier qualquer outra coisa, reporta.

### 8. Verifica que o vault tá de pé

```bash
curl "<worker-url>/status"
```

Esperado: `{"configured":true,"notes":0,"edges":0,...}`. Se `configured` vier `false`, tá faltando algum secret — revê o passo 5.

### 8.5. Instala a camada cliente (captura automática)

Sem este passo o Brain fica **reativo** (só salva quando o usuário pede). Instala os 6 hooks do Claude Code que fazem o salvar/lembrar proativo:

```bash
node scripts/install-claude-hooks.mjs "<worker-url>"
```

O instalador grava os hooks em `~/.claude/hooks/`, faz merge idempotente no `~/.claude/settings.json` (com backup antes) e nunca toca em outras configurações do usuário. Detalhes na seção "Instalação" do README (política de cobrança dos hooks).

### 9. Entrega pro usuário

Imprime um resumo curto com:

- A URL do Worker
- O endpoint MCP: `<worker-url>/mcp`
- O comando de instalação do Claude Code: `claude mcp add --transport http expert-brain <worker-url>/mcp`
- Um lembrete pra abrir `<worker-url>/app/config` depois de logar pra copiar o bloco de personalização pra Claude → Settings → Personalization
- A confirmação de que a captura automática (hooks) foi ativada — ou, se o passo 8.5 falhou, o comando pra ativar depois
- Um lembrete de que o custo de token de conectar o MCP é ~2.400 tokens por requisição (veja [docs/token-cost.md](docs/token-cost.md) pra impacto por plano)
- O último passo do onboarding: **ligar o preenchimento automático de memória** ([docs/prompt-onboarding-memoria.md](docs/prompt-onboarding-memoria.md)) — wizard que conecta as fontes (e-mails, reuniões, CRM, chat de equipe), migra a memória de outras IAs (ChatGPT/Claude.ai por conexão direta, Gemini/Manus por export) e cria a importação como as primeiras tasks do board. Modo padrão é automático (grava sozinho, desfazer é reversível). Se o usuário topar fazer agora, siga o próprio documento.

Não guia o usuário pela conexão do lado do Claude a menos que ele peça. Ele sabe colar uma URL.

## Modos de falha

- **`wrangler d1 create` diz "already exists"**: o usuário já tem um D1 `expert-brain`. Roda `npx wrangler d1 list` pra achar e pergunta pro usuário se quer reaproveitar (e usar o ID existente) ou escolher outro nome.
- **`wrangler deploy` falha no binding de KV**: o ID no `wrangler.toml` ainda é placeholder ou tá errado. Refaz o passo 2/3.
- **`curl /setup/provision` retorna 503**: os secrets não foram setados. Refaz o passo 5 e o deploy.
- **`curl /status` retorna `{"configured":false}`**: pelo menos um dos três secrets tá faltando. Confere se os três foram realmente setados rodando `npx wrangler secret list`.

## Não faz

- Não commita `wrangler.local.toml`, `.dev.vars`, nem nenhum arquivo contendo ID real de D1/KV, email, passphrase, hash ou session secret.
- Não modifica `src/db/migrate.ts` pra "simplificar" as migrations — elas foram escritas manualmente por um motivo (veja o comentário no arquivo sobre trigger bodies).
- Não adiciona domínio customizado `[[routes]]` a menos que o usuário peça.
