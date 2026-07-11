-- Espelho de referência da migration runtime '0023_api_key_meta' (src/db/migrate.ts).
-- Spec 80-frota-agentes/87: `system` agrupa as chaves por sistema na listagem do
-- /app/config (texto livre curto; NULL = sem sistema). last_used_at NÃO entra aqui:
-- existe desde a 0003 e o throttle de escrita (1x/h) vive no KV, sem schema.
ALTER TABLE api_keys ADD COLUMN system TEXT;
