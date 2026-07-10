# Handshake: cap no personalization prompt · CI: retries + test:client

> **Status:** draft · **Prioridade:** P2 · **Esforço:** XS+XS (carona de qualquer deploy) · **Repo:** expert-brain
> Origem: diagnóstico pós-ship do grupo 70 (10/07/2026). Sem gatilho de dor — pegar carona no próximo deploy que tocar meta.ts ou o CI.

## Problema

1. **Handshake sem cap no personalization prompt**: `owner_instructions` tem cap de 4KB, mas o `personalization_prompt` (`src/db/meta.ts` read path) NÃO tem — um prompt gigante colado em /app/config infla o handshake MCP de TODO agente conectado, silenciosamente.
2. **CI**: sem retries (flake ocasional do pool-workers derruba PR verde) e os jobs `test:client` (jsdom) e e2e não rodam no CI — regressão de client só aparece localmente.

## Design

1. Mesmo sanitize+cap do `sanitizeOwnerInstructions` aplicado ao read path do personalization prompt (4KB, strip de controle). Aditivo: prompt hoje dentro do cap passa intacto.
2. CI: `retries: 1` no vitest do CI (só CI — local continua 0, flake local é sinal) + job `test:client`.

## Verificação

- Teste unitário: prompt de 10KB gravado → handshake carrega no máximo 4KB sanitizados.
- CI verde rodando os dois pools (worker + client) no PR desta própria spec.
