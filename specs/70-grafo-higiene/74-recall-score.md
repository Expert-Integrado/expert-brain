# recall expõe o score de similaridade

> **Status:** shipped (09/07/2026 — deploy ce412aab com OK do dono; verificado em produção: recall real devolvendo score 0.65/0.58/0.57 do índice vivo) · **Prioridade:** P3 · **Esforço:** XS · **Repo:** expert-brain
> **Depende de:** nada — carona de qualquer deploy do grupo. PR 4 do grupo 70.

## Contexto

O `recall` (src/mcp/tools/recall.ts) ordena por relevância mas devolve só
`{id, title, domain, kind, tldr, url}` — o agente não sabe se o primeiro hit é um match
forte (0.85) ou o menos-pior de um pool fraco (0.55). Com o gate soft da spec 71 educando
os agentes sobre as bandas de score, o recall precisa falar a mesma língua.

## Problema / Motivação

Sem o score, o agente trata hit fraco como resposta confiável ("já existe nota sobre X")
e hit forte como mero candidato — as duas direções erram. O score também é o insumo pro
fluxo recomendado "recall antes de save_note": >= 0.80 = provável duplicata, pare e leia.

## Design

Aditivo, um campo:

- Cada item de `results` ganha `score: number | null`:
  - id veio do pool do VETOR: score do match do Vectorize (cosseno bge-m3). Se o mesmo id
    aparecer mais de uma vez no top-30, vale o maior.
  - id veio SÓ do FTS ou do retrieval por domínio (domains_filter): `score: null` — rank
    do FTS5 e recência não são comparáveis a cosseno; null honesto > número inventado.
- DESCRIPTION ganha o parágrafo: score é similaridade de cosseno NÃO calibrada (não é
  probabilidade); bandas de referência: >= 0.80 quase-duplicata, 0.60-0.79 relacionada,
  < 0.60 fraca; `null` = match por palavra-chave/domínio, sem métrica vetorial.

Sem mudança de ordenação, balanceamento, filtros ou privacidade.

## Arquivos afetados

- `src/mcp/tools/recall.ts` — mapa id->score dos vectorMatches, campo no shape final,
  DESCRIPTION.
- `test/tools/recall-score.test.ts` — novo (TDD, escrito antes da implementação).

## Critérios de aceite

- [x] Hit vindo do vetor traz `score` numérico igual ao do Vectorize.
- [x] Hit vindo só do FTS traz `score: null`.
- [x] Hit injetado por domains_filter (sem match semântico/keyword) traz `score: null`.
- [x] DESCRIPTION explica banda e não-calibração.
- [x] Suite completa verde + typecheck.

## Validação

`npx vitest run test/tools/recall-score.test.ts` + suite. Pós-deploy: um recall real e
conferir o campo.
