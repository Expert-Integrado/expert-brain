-- Auditoria estrutural do vault, exaustiva (roda direto no D1, não via recall).
-- Uso: wrangler d1 execute <DB> --remote --command "<uma das queries abaixo>"
-- Todas read-only; nenhuma muta o banco.

-- 1) Distribuição por kind (saúde geral; detecta kind ausente / legado não curado)
SELECT kind, count(*) c FROM notes WHERE deleted_at IS NULL GROUP BY kind;

-- 2) Histograma de criação por mês (acha bursts de geração automática)
SELECT strftime('%Y-%m', created_at/1000, 'unixepoch') m, count(*) c
FROM notes WHERE deleted_at IS NULL GROUP BY m ORDER BY m;

-- 3) Títulos idênticos (duplicatas exatas)
SELECT count(*) c, group_concat(id) ids
FROM notes WHERE deleted_at IS NULL
GROUP BY lower(trim(title)) HAVING c > 1 ORDER BY c DESC;

-- 4) tldr ausente ou curto demais (nota não-pronta)
SELECT id, title FROM notes
WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task')
  AND (tldr IS NULL OR length(tldr) < 15);

-- 5) Snapshots de estado mutável salvos como nota permanente.
--    Ajuste as assinaturas LIKE ao ruído do seu vault (alertas, "monitoring",
--    métricas instantâneas, pendências operacionais).
SELECT id, kind, title, strftime('%Y-%m-%d', created_at/1000, 'unixepoch') d
FROM notes WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task')
  AND (title LIKE '%Monitoring%' OR title LIKE '%Alert%' OR title LIKE '%Risk Pattern%'
       OR tldr LIKE '%monitoring%')
ORDER BY created_at;

-- Detalhe + contagem de edges de um conjunto de candidatos (decidir qual manter no merge):
-- SELECT n.id, n.kind, n.title, substr(n.tldr, 1, 80) tldr,
--   (SELECT count(*) FROM edges e WHERE e.from_id = n.id)
--   + (SELECT count(*) FROM edges e WHERE e.to_id = n.id) AS edge_count
-- FROM notes n WHERE n.id IN ('id1', 'id2') ORDER BY lower(n.title);
