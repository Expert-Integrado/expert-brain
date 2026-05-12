# CLAUDE.md — Runbook de setup do agente Expert Brain

Esse arquivo é a fonte única da verdade pra configurar o Expert Brain ponta a ponta a partir de uma IDE agêntica (Claude Code, Cursor, etc). Se o usuário pedir pra "configurar o Expert Brain", "instalar o Expert Brain", ou algo do gênero, segue esse runbook passo a passo. Não improvisa.

## O que o Expert Brain precisa

Um único Cloudflare Worker com cinco recursos vinculados a ele:

| Recurso | Tipo | Nome do binding |
|---|---|---|
| Banco D1 | SQL (SQLite) | `DB` |
| Índice Vectorize | 1024-dim cosine | `VECTORIZE` (nome `expert-brain-embeddings`) |
| Namespace KV | Tokens OAuth | `OAUTH_KV` |
| Namespace KV | Cache do layout do grafo | `GRAPH_CACHE` |
| Workers AI | Embeddings multilíngues (`@cf/baai/bge-m3`) | `AI` |

E três secrets do Worker:

| Secret | Propósito |
|---|---|
| `OWNER_EMAIL` | Email de login pro dashboard web e pro OAuth do MCP |
| `OWNER_PASSWORD_HASH` | Hash PBKDF2-SHA256 (100k iter) da passphrase do usuário |
| `SESSION_SECRET` | String hex aleatória de 32 bytes — chave HMAC dos cookies de sessão do dashboard web |

Tudo roda no free tier da Cloudflare. Não precisa de cartão de crédito.

## Preflight (uma vez por máquina)

Antes de rodar o runbook pela primeira vez, confirma que o host tem a CLI `wrangler` autenticada na Cloudflare:

```bash
npx wrangler whoami
```

Se falhar, pede pro usuário rodar `npx wrangler login` no terminal dele (abre um browser). Não tenta autenticar no lugar dele.

**Atalho:** se o usuário tem Node 20+ e quer pular o runbook manual, ele pode rodar `npm run setup` que automatiza os 9 passos abaixo. Use esse atalho a menos que o usuário peça explicitamente pra você executar passo a passo.

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

Roda esses quatro comandos e captura os IDs do output:

```bash
npx wrangler d1 create expert-brain
npx wrangler vectorize create expert-brain-embeddings --dimensions=1024 --metric=cosine
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create GRAPH_CACHE
```

Cada comando imprime um ID. Faz o parse do output e extrai:

- `database_id` do `wrangler d1 create`
- dois valores de `id` das duas rodadas de `kv namespace create` (o output do comando labela qual é qual)

O Vectorize não retorna ID — ele é referenciado pelo nome no `wrangler.toml`.

### 3. Atualiza o `wrangler.toml`

Abre o `wrangler.toml` e troca os três placeholders `REPLACE_ME_*` pelos IDs do passo 2:

- `database_id = "REPLACE_ME_D1_ID"` → o ID do D1
- O bloco `[[kv_namespaces]]` com `binding = "OAUTH_KV"` — define `id` como o ID do OAUTH_KV
- O bloco `[[kv_namespaces]]` com `binding = "GRAPH_CACHE"` — define `id` como o ID do GRAPH_CACHE

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

### 9. Entrega pro usuário

Imprime um resumo curto com:

- A URL do Worker
- O endpoint MCP: `<worker-url>/mcp`
- O comando de instalação do Claude Code: `claude mcp add --transport http expert-brain <worker-url>/mcp`
- Um lembrete pra abrir `<worker-url>/app/config` depois de logar pra copiar o bloco de personalização pra Claude → Settings → Personalization
- Um lembrete de que o custo de token de conectar o MCP é ~2.400 tokens por requisição (veja a seção "O custo real: tokens do Claude" no README pra impacto por plano)

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
