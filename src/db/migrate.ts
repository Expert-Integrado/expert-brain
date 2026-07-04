import type { Env } from '../env.js';

// Each entry is a single executable SQL statement.
// Splitting via ;\s*\n can break trigger bodies (inner semicolons).
// Keeping them as individual statements sidesteps that entirely.
const MIGRATION_0001_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  tldr        TEXT NOT NULL,
  domains     TEXT NOT NULL,
  kind        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, tldr, body,
  content='notes', content_rowid='rowid',
  tokenize='unicode61'
)`,
  `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, tldr, body)
  VALUES (new.rowid, new.title, new.tldr, new.body);
END`,
  `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, tldr, body)
  VALUES('delete', old.rowid, old.title, old.tldr, old.body);
END`,
  `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, tldr, body)
  VALUES('delete', old.rowid, old.title, old.tldr, old.body);
  INSERT INTO notes_fts(rowid, title, tldr, body)
  VALUES (new.rowid, new.title, new.tldr, new.body);
END`,
  `CREATE TABLE IF NOT EXISTS tags (
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
)`,
  `CREATE TABLE IF NOT EXISTS edges (
  id             TEXT PRIMARY KEY,
  from_id        TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_id          TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  relation_type  TEXT NOT NULL CHECK (relation_type IN (
    'analogous_to','same_mechanism_as','instance_of','generalizes',
    'causes','depends_on','contradicts','evidence_for','refines'
  )),
  why            TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE(from_id, to_id, relation_type)
)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_rel  ON edges(relation_type)`,
  `CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
)`,
];

// Guard against corrupt domains JSON. stats uses json_each(notes.domains) —
// if any row has a malformed value, the whole query fails. Enforcing validity
// at write time via triggers catches bugs at the source and keeps
// stats/graph queries safe. Can't add CHECK to an existing table without
// rebuilding it (which would cascade-delete edges/tags via foreign keys).
const MIGRATION_0002_STMTS: string[] = [
  `CREATE TRIGGER IF NOT EXISTS notes_domains_valid_insert
   BEFORE INSERT ON notes
   WHEN NOT json_valid(NEW.domains)
   BEGIN
     SELECT RAISE(ABORT, 'domains must be valid JSON');
   END`,
  `CREATE TRIGGER IF NOT EXISTS notes_domains_valid_update
   BEFORE UPDATE ON notes
   WHEN NOT json_valid(NEW.domains)
   BEGIN
     SELECT RAISE(ABORT, 'domains must be valid JSON');
   END`,
];

// 0003 — tabela api_keys (PATs com hash sha256). Match com migrations/0002_api_keys.sql.
const MIGRATION_0003_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS api_keys (
    id            TEXT PRIMARY KEY,
    owner_email   TEXT NOT NULL,
    name          TEXT NOT NULL,
    prefix        TEXT NOT NULL,
    key_hash      TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    revoked_at    INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_email)`,
];

// 0004 — soft-delete. delete_note passa a marcar deleted_at em vez de DELETE,
// pra que uma nota apagada (por engano, ou por um agente) seja recuperavel.
// ADD COLUMN e seguro: nao recria a tabela (rebuild cascatearia edges/tags).
// IMPORTANTE: o FTS e external-content e o trigger notes_au (AFTER UPDATE)
// reinsere a linha no indice — entao a nota soft-deletada CONTINUA no notes_fts.
// Por isso TODOS os read paths filtram `deleted_at IS NULL` (ver queries.ts etc).
const MIGRATION_0004_STMTS: string[] = [
  `ALTER TABLE notes ADD COLUMN deleted_at INTEGER`,
];

// 0005 — similar edges PRE-COMPUTADAS. O grafo deixava de carregar acima de
// ~950 notas porque buildPayload computava similaridade ao vivo: 1 query
// Vectorize POR NOTA (loop sequencial em similarity.ts) estourava o cap de
// subrequests do Cloudflare (50 free / 1000 paid). Agora cada nota grava seus
// top-k vizinhos no write path (save_note/update_note/reembed/backfill) e o
// grafo só LE desta tabela — zero Vectorize por load, escala pra qualquer N.
// from_id = a nota cujo vetor gerou a query; to_id = o vizinho. Pares simetricos
// e pares ja com edge explicita sao deduplicados no read (graph-data.ts).
const MIGRATION_0005_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS similar_edges (
    from_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    to_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    score    REAL NOT NULL,
    PRIMARY KEY (from_id, to_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_similar_from ON similar_edges(from_id)`,
  `CREATE INDEX IF NOT EXISTS idx_similar_to   ON similar_edges(to_id)`,
];

// 0006 — TASK FIELDS. Migração ClickUp → Brain native tasks. Uma task é uma nota
// com kind='task' + 4 colunas nullable. ADD COLUMN é seguro (não recria a tabela,
// que cascatearia edges/tags). As colunas ficam NULL pra TODAS as notas existentes
// (que são de conhecimento) — o CHECK passa em NULL (NULL não viola CHECK em SQLite),
// então a migração não toca nenhuma linha antiga. Índices PARCIAIS (WHERE kind='task')
// não indexam as ~1000 notas de conhecimento — custo zero pra elas, query rápida pro
// Kanban/lembretes. due_at e completed_at em unix ms (Date.now()), igual created_at.
const MIGRATION_0006_STMTS: string[] = [
  `ALTER TABLE notes ADD COLUMN status TEXT CHECK (status IS NULL OR status IN ('open','in_progress','done','canceled'))`,
  `ALTER TABLE notes ADD COLUMN due_at INTEGER`,
  `ALTER TABLE notes ADD COLUMN priority INTEGER CHECK (priority IS NULL OR (priority BETWEEN 1 AND 4))`,
  `ALTER TABLE notes ADD COLUMN completed_at INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_notes_task_open ON notes (status, due_at) WHERE kind = 'task' AND status = 'open'`,
  `CREATE INDEX IF NOT EXISTS idx_notes_task_due ON notes (due_at) WHERE kind = 'task' AND status IN ('open','in_progress')`,
];

// 0007 — NOTE MEDIA. Mídia (imagem/vídeo/documento/áudio) anexada a uma nota.
// O blob vive no R2 (bucket expert-brain-media), key = sha256/<hash>.<ext>. A
// tabela só guarda o ponteiro + metadados. content_hash habilita dedup: a MESMA
// foto anexada em N notas vira N linhas note_media apontando pro MESMO r2_key (1
// blob). ON DELETE CASCADE limpa as linhas quando a nota é HARD-deletada (o
// soft-delete não cascateia — a mídia sobrevive pra restauração). created_at em
// unix ms (gravado em código, igual notes.created_at).
const MIGRATION_0007_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS note_media (
    id                TEXT PRIMARY KEY,
    note_id           TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL CHECK (kind IN ('image','video','document','audio')),
    r2_key            TEXT NOT NULL,
    content_hash      TEXT NOT NULL,
    mime_type         TEXT NOT NULL,
    size_bytes        INTEGER NOT NULL,
    original_filename TEXT,
    created_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_note_media_note ON note_media(note_id)`,
  `CREATE INDEX IF NOT EXISTS idx_note_media_hash ON note_media(content_hash)`,
];

// 0008 — SHARE DE TASK (public read-only por token). Compartilhamento granular de
// UMA task via link /s/<token>, sem login e sem expor o vault. ADD COLUMN é seguro
// (não recria a tabela, que cascatearia edges/tags): as colunas nascem NULL pra
// TODAS as notas/tasks existentes (nenhuma linha é tocada). share_token guarda o
// HASH sha256 do token (NUNCA o plaintext — igual api_keys.key_hash): vazamento do
// D1 não vaza links válidos. O índice PARCIAL (WHERE share_token IS NOT NULL) só
// indexa as poucas tasks compartilhadas — custo zero pras ~1000 notas, e o UNIQUE
// garante que dois tokens nunca colidam no lookup da rota pública. share_expires_at
// em unix ms (Date.now()), igual due_at/created_at. Escopo: SÓ task (kind='task') —
// a criação valida; nota de conhecimento fica pra uma spec futura.
const MIGRATION_0008_STMTS: string[] = [
  `ALTER TABLE notes ADD COLUMN share_token TEXT`,
  `ALTER TABLE notes ADD COLUMN share_expires_at INTEGER`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_share_token ON notes (share_token) WHERE share_token IS NOT NULL`,
];

const MIGRATIONS: Array<{ id: string; stmts: string[] }> = [
  { id: '0001_init', stmts: MIGRATION_0001_STMTS },
  { id: '0002_domains_json_valid', stmts: MIGRATION_0002_STMTS },
  { id: '0003_api_keys', stmts: MIGRATION_0003_STMTS },
  { id: '0004_soft_delete', stmts: MIGRATION_0004_STMTS },
  { id: '0005_similar_edges', stmts: MIGRATION_0005_STMTS },
  { id: '0006_task_fields', stmts: MIGRATION_0006_STMTS },
  { id: '0007_note_media', stmts: MIGRATION_0007_STMTS },
  { id: '0008_share_task', stmts: MIGRATION_0008_STMTS },
];

export async function runMigrations(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
  ).run();
  const applied = await env.DB.prepare(`SELECT id FROM _migrations`).all<{ id: string }>();
  const appliedIds = new Set((applied.results ?? []).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (appliedIds.has(m.id)) continue;
    for (const stmt of m.stmts) {
      await env.DB.prepare(stmt).run();
    }
    await env.DB.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`)
      .bind(m.id, Date.now())
      .run();
  }
}
