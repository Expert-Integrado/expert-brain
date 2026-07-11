-- Espelho de referência da migration runtime '0024_project_shares' (src/db/migrate.ts).
-- Spec 80-frota-agentes/85: share do board de UM projeto (/p/<token>) com permissão
-- por token ('read' | 'comment'). token_hash: o plaintext só existe no flash da
-- criação, nunca no banco. Task privada NUNCA entra no recorte (filtro na leitura).
CREATE TABLE IF NOT EXISTS project_shares (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read','comment')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_project_shares_project ON project_shares(project_id, revoked_at);
