# Recall: cobertura vetorial (topK 30→60) e balanceador proporcional ao limit

> **Status:** draft · **Prioridade:** P2 (executar quando a dor aparecer) · **Esforço:** M — TDD forte, é o coração da busca · **Repo:** expert-brain
> Origem: diagnóstico pós-ship do grupo 70 (10/07/2026). Gatilho de execução: reclamação real de "recall não achou nota que existe".

## Problema

Com 6,5k+ notas, o recall tem dois tetos que não escalam:

1. **top-30 vetorial é a única porta semântica** (`recall.ts` ~69): nota relevante fora do top-30 e sem match de keyword é INALCANÇÁVEL, não importa o `limit` pedido.
2. **Balanceador capado em ~15 sem filtro** (3/domínio x 5 domínios; `offset>=15` volta vazio) — `limit=30` devolve no máximo 15 e pagina pro nada.

## Design

1. topK vetorial 30 → 60 (1 query, custo marginal no Vectorize).
2. Balanceador escala com o `limit` pedido: caps 3/domínio e 5 domínios viram proporcionais quando `limit > 15` (ex.: `ceil(limit/5)` por domínio). Shape da resposta ADITIVO — contratos atuais (limit default) byte-idênticos.
3. Testes de regressão dos contratos atuais ANTES de mexer (limit default, filtros por domínio, paginação) — o risco é regressão silenciosa em quem consome o recall hoje (26 contas conectadas).

## Fora de escopo

- Metadata filter nativo do Vectorize (domains em CSV não filtra nativo — exigiria campo domain0 separado; avaliar em spec própria, ganho incerto).
- Mudar o ranking (score/kind/recência) — só COBERTURA.

## Verificação

- Nota semeada na posição ~40 do ranking vetorial passa a voltar com limit alto.
- Suite de regressão dos contratos atuais 100% verde sem mudança de shape no caminho default.
