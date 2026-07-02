# @expertintegrado/create-expert-brain

Scaffolder oficial do [Expert Brain](https://github.com/Expert-Integrado/expert-brain) — um grafo de conhecimento pessoal pro Claude, rodando 100% no free tier da Cloudflare.

## Uso

```bash
npm create @expertintegrado/expert-brain@latest meu-vault
cd meu-vault
npx wrangler login    # uma vez por máquina
npm run setup         # 2 perguntas (email + senha), ~3min
```

Pronto. O `npm run setup` provisiona D1, Vectorize, dois namespaces KV, gera secrets, faz deploy do Worker e roda as migrations. No final imprime a URL do Worker e o comando MCP pra conectar no Claude.

## O que isso faz

Esse pacote npm copia o código-fonte do Expert Brain (Worker do Cloudflare + scaffolding) pra uma pasta nova e roda `npm install`. O provisionamento Cloudflare em si fica no `npm run setup` do template.

Versionamento explícito: `npm create @expertintegrado/expert-brain@1.0.0 meu-vault` pina uma versão específica.

## Requisitos

- Node 18+
- Conta Cloudflare gratuita ([cadastro](https://dash.cloudflare.com/sign-up), sem cartão)

## Documentação completa

Veja o [README do projeto](https://github.com/Expert-Integrado/expert-brain#readme) — método, arquitetura, custo real (tokens do Claude), FAQ.

## Licença

MIT
