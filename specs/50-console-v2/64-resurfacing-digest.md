# Resurfacing: digest que devolve conhecimento sem ser perguntado

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain (+1 leitura proxy no contacts)
> **Depende de:** suave: `63` (contagem de inbox no digest), `57` (last_contacted confiável pra "negligenciados"). Coordena com `65` (a home consome este payload).
> **Agente sugerido:** Opus (queries + cron existente) · **Esforço de execução:** padrão

## Contexto

- Tese registrada pelo próprio dono no vault (nota `37jurd2b810v`): o valor do second brain vem do HÁBITO DE CONSULTA, não do armazenamento — sistema que só responde quando perguntado depende 100% da disciplina do dono.
- Já existe cron diário no Brain: `wrangler.toml:26-27` (`crons = ["0 11 * * *"]`, 8h BRT) → `scheduled()` em `src/index.ts:46` → `src/notify.ts` monta e envia um digest de TASKS (idempotente por cadência). **A infraestrutura de "falar sozinho" existe; só fala de tarefas.**
- O que o sistema SABE e nunca conta: `kind = 'question'` é um dos 7 kinds canônicos (perguntas abertas ficam registradas e nunca são cobradas); edges dão grau de centralidade por nota; `contacts.last_contacted` marca a última interação de cada contato (via proxy read-only `CONTACTS`).
- Não existe rastreio de visualização de nota (nenhuma coluna `last_viewed`) — e NÃO vamos criar (write em todo GET é custo/ruído).

## Problema / Motivação

- Conhecimento parado é museu: decisões antigas centrais, perguntas abertas há meses e contatos importantes esfriando não aparecem pra ninguém — o recall exige saber O QUE perguntar.
- O cron de notificação já abre um canal diário com o dono; desperdiçá-lo só com tasks é subusar o melhor slot de atenção.

## Design proposto

### 1. Módulo `src/digest/resurface.ts` — computa o payload (SQL puro, zero Vectorize/AI)

`buildResurfaceDigest(env): Promise<ResurfaceDigest>` com 4 seções, cada uma capada e barata:

1. **Perguntas abertas** — notas `kind='question'` não deletadas, `updated_at > 30 dias`, ordenadas por idade (cap 3). "Você perguntou isso há 47 dias e nunca respondeu."
2. **Nota central esquecida** — nota de conhecimento com maior grau (COUNT de edges, JOIN em `edges`) cujo `updated_at > 90 dias` (cap 2, sorteio determinístico por semana entre o top-10 — variedade sem aleatoriedade real: `hash(note_id + isoWeek) % N`).
3. **Contatos esfriando** — via proxy `CONTACTS` (rota GET existente de listagem/graph meta): entidades com `category` preenchida e `last_contacted > 60 dias` (cap 3, mais antigos primeiro). Respeita privacidade da `61` (o digest é superfície do DONO → header include-private).
4. **Inbox acumulando** — contagem de `inbox_items` pendentes há >7 dias (se a `63` já rodou; senão, seção omitida).

Payload versionado `{ version: 1, generated_at, sections: [...] }`, cacheado na tabela `meta` (chave `resurface_digest`, TTL 20h) — computa 1x/dia no cron, a home (`65`) lê o cache.

### 2. Entrega em 3 superfícies

- **Cron diário existente**: `src/notify.ts` anexa ao digest de tasks um bloco "Do seu cérebro" com as seções não-vazias (formato curto, links pro console). Mesmo canal, mesma idempotência — NENHUM cron novo.
- **Console**: seção na home (`65`) lendo o cache; fallback: se a 65 ainda não rodou, card no topo de `/app/notes`.
- **MCP**: tool nova `digest` (read-only) retornando o payload — qualquer sessão de agente pode abrir com "o que meu cérebro quer me lembrar hoje?". Gate de escopo: leitura, mas conteúdo pessoal → registrar como tool visível só pra `full` (mesma decisão do inbox na `63`).

### 3. Ação embutida (fechar o loop)

Cada item do digest carrega ação de 1 clique no console: pergunta aberta → abrir nota (responder ou arquivar via edição normal); contato esfriando → link direto "Registrar interação" (form da `57`) ou wa.me (canal primário da `55`); nota central → abrir nota. Digest sem ação vira notificação ignorada.

## Fora de escopo

- Rastreio de visualização de nota (`last_viewed`) — sem write em GET.
- Spaced repetition formal (SM-2 etc.) — o sorteio semanal determinístico é o 80/20.
- Push/Telegram direto do Worker (a entrega externa é o canal do notify.ts existente).
- Personalização de cadência/pesos pela UI (valores fixos nesta fase: 30/60/90 dias, caps 3/2/3).
- Recall semântico "relacionado ao que você trabalhou hoje" (exigiria sinal de atividade que não existe).

## Critérios de aceite

- [x] `buildResurfaceDigest` retorna as 4 seções com fixtures cobrindo: pergunta velha aparece / recente não; nota de grau alto e fria aparece / quente não; contato com `last_contacted` antigo aparece; inbox >7d conta. Teste: `test/digest/resurface.test.ts`.
- [x] Sorteio semanal determinístico: mesma semana → mesma seleção; semana seguinte → pode variar (teste com semana forjada). Teste: `test/digest/resurface.test.ts` (`pickWeeklyCentralNotes`, hash FNV-1a — o hash polinomial ingênuo original preservava a ordem entre semanas, trocado).
- [x] Cron diário: notificação inclui o bloco "Do seu cérebro" quando há conteúdo; digest vazio → bloco omitido (sem notificação vazia). Teste: `test/notify.test.ts` (`buildResurfaceBlock`) + `test/scheduled.test.ts`.
- [x] Cache em `meta` com TTL: segunda chamada no mesmo dia não recomputa (spy nas queries). Teste: `test/digest/resurface.test.ts`.
- [x] Tool `digest` retorna o payload pro dono/PAT `full`; invisível pra PAT `read`. Teste: `test/tools/digest.test.ts`. Adicional (não pedido explicitamente, mas consistente com o selo de privacidade da spec 31): PAT `full` SEM o escopo `private` computa fresco e nunca lê/grava o cache do dono — nunca vê nota/contato privado.
- [x] Falha do proxy CONTACTS não derruba o digest (seção de contatos omitida com flag `degraded`). Teste: `test/digest/resurface.test.ts`.
- [x] Cada item rende link/ação válida no console. Cada item do payload carrega `url` (nota/contato) ou `inbox_url`; card fallback em `/app/notes` (`src/web/notes.ts`) e bloco do Telegram (`src/notify.ts`) usam esses links. Teste: `test/web/notes-digest-card.test.ts`.

**Limitação conhecida (documentada em `src/digest/resurface.ts`):** `GET /list_entities` do `expert-contacts` hoje não devolve `last_contacted` (só id/kind/name/phone/email/role/company/website/sector/source/category/avatar_r2_key) nem permite ordenar/filtrar por ele. O código do lado do Brain já lê esses campos de forma defensiva/opcional — o CONTRATO está testado com fixtures — mas em produção a seção "contatos esfriando" fica vazia (nunca quebra: `contacts_degraded` só liga em falha real do proxy) até uma extensão aditiva no `expert-contacts` incluir `last_contacted` na listagem. Fora do repo de trabalho designado para esta execução.

## Validação

- `npm run typecheck` + `npm test`; testes acima + snapshot do formato da notificação.
- Manual (`wrangler dev`): forçar o scheduled local (`wrangler dev --test-scheduled`), conferir bloco novo e cache.
- **Gate de deploy:** `wrangler deploy` só com OK explícito do dono.

## Arquivos afetados

- `src/digest/resurface.ts` (novo), `src/db/queries.ts` (queries das seções)
- `src/notify.ts` (bloco novo), `src/index.ts` (scheduled chama build + grava cache)
- `src/mcp/tools/digest.ts` (novo) + `src/mcp/registry.ts`
- `src/web/` (card fallback em notes OU integração com a home da 65), `test/`

## Riscos e reversão

- **Risco**: digest repetitivo vira ruído e o dono ignora (banner blindness). Mitigação: sorteio semanal + caps baixos + bloco omitido quando vazio; iteração futura ajusta pesos.
- **Risco**: query de grau (COUNT em edges) pesar com o vault grande. Mitigação: 1x/dia no cron, com cache — nunca no request path.
- **Reversão**: revert do código; chave `resurface_digest` na `meta` fica inerte. Nenhuma migration.
