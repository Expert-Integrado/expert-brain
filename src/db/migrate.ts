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

const MIGRATIONS: Array<{ id: string; stmts: string[] }> = [
  { id: '0001_init', stmts: MIGRATION_0001_STMTS },
  { id: '0002_domains_json_valid', stmts: MIGRATION_0002_STMTS },
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
