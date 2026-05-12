# Custo em tokens no Claude

Expert Brain roda no free tier da Cloudflare ([veja o README](../README.md#-custo-r-0--roda-inteiro-no-free-tier-da-cloudflare)), então a infra é grátis. Mas conectar o servidor MCP ao Claude *adiciona* tokens em toda conversa. Essa página é o breakdown honesto pra você decidir se a troca vale pro seu uso.

> Os números abaixo são estimados a partir dos arquivos-fonte em `~4 chars/token`. Tokenização real varia ±15%. Metodologia no final.

## TL;DR

| Custo | Tokens | Quando você paga |
|---|---|---|
| Overhead sempre-ligado do MCP | **~2.400** | Toda requisição com MCP conectado (cacheável, TTL de 5 min) |
| Resposta do `recall` | 100–300 | Por chamada (retorna só os tldrs, nunca o corpo) |
| Resposta do `get_note` | 500–2.000 | Por chamada (corpo completo) |

Numa sessão típica de Claude Code que mexe no vault algumas vezes, espera **~2–3k tokens extras por cold start** e **custo marginal perto de zero enquanto o cache de prompt tiver quente**.

## O que entra no system prompt

Quando você conecta o MCP, o Claude carrega em toda requisição:

1. **Instruções do servidor** ([`src/mcp/instructions.ts`](../src/mcp/instructions.ts)) — ~240 tokens. O preâmbulo "quando usar / fluxo recomendado".
2. **Descrições das tools** das 9 tools — ~1.250 tokens no total. `save_note` e `recall` são propositalmente verbosas porque codificam a disciplina (atomizar, varrer cross-domain, regras do `why` do edge, ressalva de latência de indexação). As outras (`expand`, `get_note`, `link`, `update_note`, `delete_note`, `stats`, `reembed`) são curtas.
3. **Schemas JSON de input** das 9 tools — ~900 tokens no total.

Total: **~2.400 tokens adicionados ao system prompt** enquanto o MCP estiver conectado, *quer você use ou não* o vault naquela conversa.

## O que carrega sob demanda

- **Respostas de tool** — pay-as-you-go. `recall` é intencionalmente barato (só tldrs, ~80 chars por hit, capado em ~15 hits). `get_note` é o pesado — lê corpos só quando realmente precisar.

## Impacto por plano do Claude

A Anthropic não publica quotas exatas pros planos de consumidor, mas medições da comunidade dão um retrato utilizável. Todos os planos pagos usam uma **janela rolling de 5h** (não reset diário — mensagens caem 5h depois do envio), e Pro/Max têm **limites semanais** introduzidos em agosto/2025. Em dias de semana entre 5–11h PT / 13–19h GMT (horário de pico), o limite de 5h aperta ainda mais.

| Plano | Orçamento de 5h observado | Overhead MCP como % da janela | Veredito |
|---|---|---|---|
| Free | ~9k tok efetivos | ~27% | **Pula.** O Expert Brain come muito da janela. |
| Pro (US$ 20/mês) | ~44k tok | ~5,5% por requisição fria | Conecta seletivamente. Desconecta pra trabalho fora do vault. |
| Max 5x (US$ 100/mês) | ~220k tok | ~1,1% | Deixa ligado. |
| Max 20x (US$ 200/mês) | ~880k tok | ~0,3% | Deixa ligado. |
| API / Claude Code | sem janela | cobrado por token | Disciplina de cache é a tua alavanca. |

Preço concreto da API pro Opus 4.6 (~US$ 15/Mtok input, ~US$ 1,50 cacheado): o overhead do MCP sai por cerca de **US$ 0,036 por turno frio** ou **US$ 0,0036 com cache quente**. Uma sessão com 20 turnos numa janela de 5 minutos é um cold start + 19 cacheados = ~US$ 0,10 no total pro overhead.

Confere seu uso ao vivo com `/usage` no Claude Code ou em `claude.ai/settings/usage`.

## O cache de prompt muda a matemática

O cache de prompt do Claude tem **TTL de 5 minutos** e o overhead do MCP fica no prefixo cacheável do system prompt. Consequências práticas:

- **Sessão ativa** (você tá num vai-e-vem de mensagens): você paga os 2.400 tokens *uma vez*, aí fica ~10× mais barato em cada turno subsequente dentro dos 5 minutos.
- **One-shots frios** (você pinga o Claude, sai, volta uma hora depois): cada cold start repaga os 2.400 tokens inteiros. Se você faz isso dezenas de vezes por dia com o MCP conectado mas raramente usa o vault, o overhead foi desperdiçado.
- **Desconectar o MCP** quando você não precisa elimina o custo inteiro. O vault continua funcionando — só não fica alcançável daquela sessão.

## Prós

- **Overhead fixo, não por chamada.** ~2.400 tokens é ~1,2% de um contexto de 200k. Pra maioria dos fluxos isso é desprezível.
- **`recall` é desenhado pra ser barato no output.** Retorna só tldrs, com teto e balanceado por domínio, então um único recall raramente passa de 300 tokens independente do tamanho do vault.
- **As descrições verbosas de tool se pagam.** Elas previnem o modo de falha mais caro: Claude salvando notas relaxadas que poluem recalls futuros. Disciplina no nível do schema é mais barato do que refazer conversa.
- **Compõe com o uso.** Cada nota salva aumenta o valor de todo recall futuro, enquanto o custo de token fica plano.

## Contras

- **Sempre-ligado, mesmo ocioso.** O overhead do MCP é pago em toda requisição com ele conectado, incluindo conversas que nunca tocam no vault.
- **Penalidade de cold start.** Conversas esparsas e curtas (com mais de 5 minutos entre uma e outra) perdem o benefício do cache e pagam cheio toda vez.
- **`get_note` pode sair caro em nota longa.** Uma nota de 2k tokens lida 5 vezes na sessão são 10k tokens. Prefere `recall` + varredura de tldr quando você não precisa do corpo de verdade.

## Como manter o custo baixo

1. **Desconecta o MCP de sessões que não precisam dele.** A alavanca mais forte. Se você vai passar uma hora em UI, o vault não precisa ficar carregado.
2. **Prefere `recall` a `get_note`.** Lê corpo só quando o tldr não der conta.
3. **Agrupa interações com o vault numa mesma sessão.** O cache fica quente por até 5 minutos — cinco recalls seguidos saem quase de graça; cinco recalls espalhados pelo dia pagam cold start cada um.
4. **Resiste a salvar demais.** O custo de token compõe com a quantidade de notas só no lado do *output* (mais notas → mais hits no recall). O overhead do system prompt fica plano, mas um vault barulhento faz recall retornar tldrs menos relevantes e tenta mais chamadas de `get_note`.

## Metodologia

Esses números vêm de `wc -c` nos arquivos-fonte dividido por 4. Especificamente:

- `src/mcp/instructions.ts` — ~1.000 chars
- Bloco DESCRIPTION de `src/mcp/tools/save-note.ts` — ~1.900 chars
- Bloco DESCRIPTION de `src/mcp/tools/recall.ts` — ~1.500 chars
- Os outros 7 arquivos de tool têm descrições mais curtas + input schemas

A tokenização real depende do tokenizer. Prosa em inglês dá em torno de 4 chars/token; schemas JSON e código são mais densos. Trata a tabela acima como ±15%, não exata. Se você quer números exatos pra sua conta, roda uma única requisição com o MCP conectado e inspeciona o campo `usage` na resposta da API.
