# Cron de re-pass das similar_edges (janela de 48h)

> **Status:** in-progress (implementado na branch `feat/70-grafo-higiene`, testes 7/7 verdes — aguardando deploy com OK do dono; toml + braço vão juntos) · **Prioridade:** P2 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** nada em código; em VALOR depende da 71 (é a rede de segurança dela). PR 2 do grupo 70.

## Contexto

As `similar_edges` de uma nota são computadas 1x no write path (save_note/update_note/
reembed, best-effort) e no backfill manual (`handleBackfillSimilar`, src/auth/setup.ts:105).
Dois buracos: (a) se a `queryVector` falhar no save, a nota fica sem vizinhos até alguém
editar; (b) nota salva ANTES das vizinhas dela (import em lote) consultou um índice que
ainda não tinha as irmãs — as edges nasceram desatualizadas. Consistência eventual do
Vectorize agrava: a consulta no momento do save enxerga o índice de ~1-2 min atrás.

## Problema / Motivação

Import de 4.449 notas em 3 dias: as primeiras notas de cada lote têm vizinhança computada
contra um índice quase vazio. O grafo mostra menos conexões do que existem — e o digest de
higiene (spec 73) reportaria "órfãs" que na verdade só não foram re-consultadas.

## Design

Novo módulo `src/graph/repass.ts`:

- `export const REPASS_CRON = '0 8 * * *'` (08:00 UTC = 05:00 BRT, antes do digest diário
  das 11:00 UTC).
- `export async function runSimilarRepass(env, nowMs, opts?: { limit?: number }):
  Promise<{ scanned: number; refreshed: number; no_vector: number; failed: number;
  completed: boolean }>`

Comportamento:

1. Seleciona notas de CONHECIMENTO (kind IS NULL OR kind != 'task', `deleted_at IS NULL`)
   com `updated_at >= janela`, onde `janela = max(nowMs - 48h, watermark)`. Ordenação:
   notas com ZERO linhas em `similar_edges` (from_id) PRIMEIRO, depois `updated_at` ASC.
2. Cap por invocação `limit` (default 40 — cada nota custa ~2 subrequests: 1 getByIds
   amortizado em lotes de 20 + 1 query + 1 batch D1; folga ampla no teto de 1000 do
   scheduled).
3. Vetores via `VECTORIZE.getByIds` em lotes de <= 20 (mesmo padrão e teto do backfill,
   setup.ts:105) — NUNCA re-embedar (Workers AI custa; o vetor já existe). Nota sem vetor
   no índice conta em `no_vector` e é pulada (o reembed manual resolve caso a caso).
4. Por nota: `refreshSimilarEdges(env, id, vector)` em try/catch individual — falha de uma
   conta em `failed` e NÃO trava as demais.
5. **Watermark** em KV (`GRAPH_CACHE`, chave `repass:watermark`): atualizada pra `nowMs`
   SÓ quando a janela foi processada inteira (`completed: true`). Cap atingido = watermark
   fica — a próxima invocação re-varre, e o zero-edges-primeiro garante progresso (quem já
   foi refeito tem linhas e vai pro fim da fila). Sem cursor frágil.

Dispatch em `src/scheduled.ts`: braço `if (cron === REPASS_CRON)` ANTES do fluxo diário
(mesmo desenho do `BACKUP_CRON`), com `ctx.waitUntil` próprio e log
`console.log('similar-repass', JSON.stringify(result))`.

**Regra de deploy (risco nº 2 do grupo):** a entrada nova em `[triggers].crons` do
`wrangler.toml` (e `wrangler.example.toml`) vai NO MESMO deploy do braço no dispatch — o
fail-safe do `runScheduled` manda expressão desconhecida pro fluxo diário, então toml sem
código = digest de tasks disparando 2x/dia.

## Arquivos afetados

- `src/graph/repass.ts` — novo (constante + runSimilarRepass).
- `src/scheduled.ts` — braço do REPASS_CRON antes do fluxo diário.
- `wrangler.toml` + `wrangler.example.toml` — terceira entrada em crons: `"0 8 * * *"`.
- `src/auth/setup.ts` — (opcional, se zerar duplicação sair barato) backfill reusa o core.
- `test/scheduled-repass.test.ts` — novo (TDD, escrito antes da implementação).

## Critérios de aceite

- [ ] `REPASS_CRON === '0 8 * * *'`, igual ao toml, diferente de BACKUP_CRON e do diário.
- [ ] `runScheduled(REPASS_CRON)` NÃO executa o fluxo diário (nem resurface digest, nem backup).
- [ ] Nota recente sem similar_edges é reprocessada e ganha linhas; `refreshed` conta.
- [ ] Task, nota deletada e nota fora da janela de 48h ficam de fora (`scanned` não as inclui).
- [ ] Sob cap, nota com zero edges tem prioridade sobre nota que já tem.
- [ ] Falha do Vectorize numa nota não impede as demais (`failed` conta, run segue).
- [ ] Watermark só avança com `completed: true`; cap atingido mantém a watermark.
- [ ] Suite completa verde + typecheck.

## Validação

`npx vitest run test/scheduled-repass.test.ts` + suite. Pós-deploy (OK do dono): conferir
no dia seguinte o log `similar-repass` via `wrangler tail` ou o contador de falhas do cron
zerado, e uma nota órfã conhecida ganhar vizinhos.
