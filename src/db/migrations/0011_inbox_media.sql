-- Espelho de referência da migration runtime '0025_inbox_media' (src/db/migrate.ts).
-- Spec 50-console-v2/68 (Web Share Target nível 2): imagem compartilhada pelo share
-- sheet do SO vira item do inbox COM anexo. Espelho enxuto de note_media referenciando
-- inbox_items; blob no MESMO bucket R2 (key sha256/<hash>.<ext>, dedup cross-tabela).
CREATE TABLE IF NOT EXISTS inbox_media (
  id                TEXT PRIMARY KEY,
  item_id           TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('image','video','document','audio')),
  r2_key            TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  original_filename TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_media_item ON inbox_media(item_id);
CREATE INDEX IF NOT EXISTS idx_inbox_media_hash ON inbox_media(content_hash);
