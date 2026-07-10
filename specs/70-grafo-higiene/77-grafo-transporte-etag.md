# Grafo: ETag no payload + enforcement runtime do budget

> **Status:** draft · **Prioridade:** P2 (executar quando a dor aparecer) · **Esforço:** S · **Repo:** expert-brain
> Origem: diagnóstico pós-ship do grupo 70 (10/07/2026). Gatilho de execução: reclamação de grafo lento OU payload passando de ~3MB.

## Problema

1. `/app/graph/data` serve TODOS os nós+edges (~1,5-3MB) com `cache-control: no-store` — o browser re-baixa o payload inteiro a CADA visita, mesmo sem mudança nenhuma no grafo. O cache existe só no KV do server.
2. O budget de 5MB do payload é um gate de TESTE — não há enforcement em runtime. O grafo cresce linear com o vault; quando estourar, estoura em produção primeiro.

## Design

1. **ETag = sourceHash.** O `sourceHash` já é computado e guardado no cache KV. Responder com header `ETag: "<sourceHash>"`; request com `If-None-Match` igual → `304` sem corpo. Segunda visita ao grafo passa a custar ~0 bytes.
2. **Downsample runtime.** Se o payload serializado passar do budget, derrubar similar edges da faixa mais baixa de score até caber (as explícitas nunca caem). Logar `console.warn` com quantas caíram — sem corte silencioso.

## Fora de escopo

- Mudanças no client do grafo (o fetch nativo já entende 304).
- Paginação/virtualização de nós (spec própria se um dia precisar).

## Verificação

- DevTools na segunda visita: status 304, zero bytes de payload.
- Teste: payload sintético acima do budget → similar edges de score baixo caem, explícitas ficam, warn logado.
