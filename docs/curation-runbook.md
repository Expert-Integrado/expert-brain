# Runbook: curadoria exaustiva do vault

Como auditar e limpar o Brain de ponta a ponta, sem depender de `recall`.

## Por que não usar `recall` pra curar

`recall` é busca vetorial: acha o que é semanticamente próximo de uma query, mas **não enumera a cauda**. Numa varredura por queries, os domínios grandes ficam subcobertos (uma rodada real parou em ~7% de um domínio com 500+ notas). Logo, `recall` serve pra spot-check temático — não pra auditoria exaustiva.

## A abordagem que cobre 100%

1. **Enumerar lendo o D1 direto** (read-only). Precisa de um token Cloudflare com permissão de D1 no ambiente (`CLOUDFLARE_API_TOKEN`):

   ```bash
   wrangler d1 execute <DB> --remote --json \
     --command "SELECT id,title,domains,kind,tldr,created_at,updated_at \
                FROM notes WHERE deleted_at IS NULL AND (kind IS NULL OR kind<>'task') \
                ORDER BY created_at" > notes-dump.json
   ```

2. **Auditoria estrutural** com `scripts/curate-audit.sql` (kind ausente, domínio fora do canon, títulos idênticos, tldr curto, histograma de criação pra achar *bursts* de geração automática).

3. **Duplicatas semânticas** (título diferente, mesmo sentido) com o scan local — zero chamada de API:

   ```bash
   node scripts/curate-dupscan.mjs notes-dump.json 0.6
   ```

4. **Verificar candidatos**: pra cada par/cluster, ler o corpo da nota e decidir manter o de mais edges / melhor formado, ou destilar num único.

## Regras de execução

- **Deletar SEMPRE via a API oficial (`delete_note`)**, nunca `UPDATE deleted_at` direto no D1: o delete oficial remove o vetor do índice; um UPDATE cru deixaria o vetor órfão e o `recall` continuaria retornando a nota. O soft-delete é recuperável (`restore_note`).
- **Re-datar em vez de deletar** quando o conteúdo tem valor histórico: troque presente por passado e ancore a data, em vez de afirmar estado mutável "hoje".
- **Estado mutável não vira nota permanente**: contagem (quantidade de X), status de deploy/URL, pendência operacional envelhecem e contradizem o `recall` — vão pro board de tasks ou pra um arquivo operacional, não pro grafo de conhecimento.

## Antipadrão que isso limpa

Um agente em loop (cron) com mandato vago + modelo leve tende a **alucinar notas-snapshot a cada ciclo** (alertas transitórios, "X monitoring", métricas instantâneas), poluindo o grafo com duplicatas quase idênticas. Prevenção: o agente deve dar **upsert numa nota fixa**, nunca `save_note` novo a cada ciclo.

## Limite conhecido

Duplicatas **totalmente reescritas** (palavras diferentes, mesmo sentido) escapam do match por string — só caem numa comparação por embedding. O resíduo costuma ser pequeno.
