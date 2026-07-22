import { env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Aplica as migrations reais do repo (migrations/0001..0003) no D1 in-memory de
// teste, EM ORDEM. Espelho FIEL dos .sql — se um .sql mudar, atualizar aqui.
//
// Por que não ler os .sql direto e dar split por ';'?
//   As migrations do contacts são aplicadas em produção "statement-by-statement"
//   via D1 HTTP API (scripts/apply-migration-0002.mjs), NÃO como um blob só. O
//   corpo do TRIGGER `entities_set_updated` (0002, última linha) e do
//   `people_set_updated` (0001) contém ';' interno dentro do bloco BEGIN..END —
//   um splitter ingênuo por ';' quebraria esses statements no meio. Os próprios
//   comentários dos .sql documentam isso ("NÃO rodar como um blob só").
//   Por isso mantemos aqui a LISTA de statements já particionada corretamente
//   (cada trigger é um único item), mirror 1:1 do conteúdo dos arquivos.
//
// As 3 migrations são CUMULATIVAS (people -> entities): 0001 cria `people`, 0002
// renomeia pra `entities` + rebuild de connections/events/media polimórficos,
// 0003 adiciona `category`. Rodadas em sequência num D1 vazio => schema final.
// ─────────────────────────────────────────────────────────────────────────────

// migrations/0001_initial_schema.sql
const MIGRATION_0001: string[] = [
  `CREATE TABLE IF NOT EXISTS people (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     phone         TEXT UNIQUE,
     email         TEXT,
     role          TEXT,
     company       TEXT,
     birthday      TEXT,
     last_contacted TEXT,
     source        TEXT NOT NULL DEFAULT 'manual',
     notes_text    TEXT,
     avatar_r2_key TEXT,
     created_at    TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_people_phone ON people(phone) WHERE phone IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_people_email ON people(email) WHERE email IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_people_company ON people(company) WHERE company IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_people_source ON people(source)`,
  `CREATE INDEX IF NOT EXISTS idx_people_last_contacted ON people(last_contacted DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_people_birthday_md ON people(SUBSTR(birthday, 6, 5))`,
  `CREATE TABLE IF NOT EXISTS connections (
     id          TEXT PRIMARY KEY,
     person_a    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     person_b    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     type        TEXT NOT NULL CHECK(type IN (
                   'family','friend','colleague','client','mentor','alum_g4',
                   'peer_tech','introduced_by','other'
                 )),
     strength    REAL NOT NULL CHECK(strength BETWEEN 0 AND 1),
     why         TEXT NOT NULL CHECK(length(why) >= 20),
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE(person_a, person_b, type)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_conn_person_a ON connections(person_a)`,
  `CREATE INDEX IF NOT EXISTS idx_conn_person_b ON connections(person_b)`,
  `CREATE INDEX IF NOT EXISTS idx_conn_type ON connections(type)`,
  `CREATE TABLE IF NOT EXISTS events (
     id          TEXT PRIMARY KEY,
     person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     kind        TEXT NOT NULL CHECK(kind IN (
                   'met','talked','saw_post','recommended','birthday_reminder',
                   'note','mentioned_in_brain'
                 )),
     ts          TEXT NOT NULL DEFAULT (datetime('now')),
     context     TEXT,
     source      TEXT NOT NULL DEFAULT 'manual'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_person_ts ON events(person_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC)`,
  `CREATE TABLE IF NOT EXISTS media (
     id            TEXT PRIMARY KEY,
     person_id     TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     kind          TEXT NOT NULL CHECK(kind IN ('avatar','document','screenshot','audio','other')),
     r2_key        TEXT NOT NULL,
     content_hash  TEXT NOT NULL,
     mime_type     TEXT NOT NULL,
     byte_size     INTEGER,
     caption       TEXT,
     created_at    TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_media_person ON media(person_id)`,
  `CREATE INDEX IF NOT EXISTS idx_media_hash ON media(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind)`,
  // TRIGGER: statement ÚNICO (corpo BEGIN..END tem ';' interno).
  `CREATE TRIGGER IF NOT EXISTS people_set_updated AFTER UPDATE ON people FOR EACH ROW BEGIN UPDATE people SET updated_at = datetime('now') WHERE id = NEW.id; END`,
];

// migrations/0002_entities.sql
const MIGRATION_0002: string[] = [
  `ALTER TABLE people ADD COLUMN kind TEXT NOT NULL DEFAULT 'person'`,
  `ALTER TABLE people ADD COLUMN website TEXT`,
  `ALTER TABLE people ADD COLUMN sector TEXT`,
  `ALTER TABLE people ADD COLUMN attributes TEXT`,
  `DROP TRIGGER IF EXISTS people_set_updated`,
  `ALTER TABLE people RENAME TO entities`,
  `CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind)`,
  `CREATE TABLE connections_v2 (
     id          TEXT PRIMARY KEY,
     a_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     b_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     type        TEXT NOT NULL,
     strength    REAL NOT NULL CHECK(strength BETWEEN 0 AND 1),
     why         TEXT NOT NULL CHECK(length(why) >= 20),
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE(a_id, b_id, type)
   )`,
  `INSERT INTO connections_v2 (id, a_id, b_id, type, strength, why, created_at)
     SELECT id, person_a, person_b, type, strength, why, created_at FROM connections`,
  `DROP TABLE connections`,
  `ALTER TABLE connections_v2 RENAME TO connections`,
  `CREATE INDEX idx_conn_a ON connections(a_id)`,
  `CREATE INDEX idx_conn_b ON connections(b_id)`,
  `CREATE INDEX idx_conn_type ON connections(type)`,
  `CREATE TABLE events_v2 (
     id          TEXT PRIMARY KEY,
     entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     kind        TEXT NOT NULL,
     ts          TEXT NOT NULL DEFAULT (datetime('now')),
     context     TEXT,
     source      TEXT NOT NULL DEFAULT 'manual'
   )`,
  `INSERT INTO events_v2 (id, entity_id, kind, ts, context, source)
     SELECT id, person_id, kind, ts, context, source FROM events`,
  `DROP TABLE events`,
  `ALTER TABLE events_v2 RENAME TO events`,
  `CREATE INDEX idx_events_entity_ts ON events(entity_id, ts DESC)`,
  `CREATE INDEX idx_events_kind ON events(kind)`,
  `CREATE TABLE media_v2 (
     id            TEXT PRIMARY KEY,
     entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     kind          TEXT NOT NULL CHECK(kind IN ('avatar','document','screenshot','audio','other')),
     r2_key        TEXT NOT NULL,
     content_hash  TEXT NOT NULL,
     mime_type     TEXT NOT NULL,
     byte_size     INTEGER,
     caption       TEXT,
     created_at    TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `INSERT INTO media_v2 (id, entity_id, kind, r2_key, content_hash, mime_type, byte_size, caption, created_at)
     SELECT id, person_id, kind, r2_key, content_hash, mime_type, byte_size, caption, created_at FROM media`,
  `DROP TABLE media`,
  `ALTER TABLE media_v2 RENAME TO media`,
  `CREATE INDEX idx_media_entity ON media(entity_id)`,
  `CREATE INDEX idx_media_hash ON media(content_hash)`,
  // TRIGGER: statement ÚNICO (corpo BEGIN..END tem ';' interno).
  `CREATE TRIGGER entities_set_updated AFTER UPDATE ON entities FOR EACH ROW BEGIN UPDATE entities SET updated_at = datetime('now') WHERE id = NEW.id; END`,
];

// migrations/0003_category.sql
const MIGRATION_0003: string[] = [
  `ALTER TABLE entities ADD COLUMN category TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_entities_category ON entities(category)`,
];

// migrations/0004_media_dedup_index.sql (spec 10-backend/19 §7)
const MIGRATION_0004: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_media_entity_hash ON media(entity_id, content_hash)`,
];

// migrations/0005_similar_edges.sql (spec 10-backend/21) — similar edges pré-computadas.
const MIGRATION_0005: string[] = [
  `CREATE TABLE IF NOT EXISTS similar_edges (
     from_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     to_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     score    REAL NOT NULL,
     PRIMARY KEY (from_id, to_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_similar_from ON similar_edges(from_id)`,
  `CREATE INDEX IF NOT EXISTS idx_similar_to   ON similar_edges(to_id)`,
];

// migrations/0006_entity_channels (spec 50-console-v2/55) — cartela de canais.
// Espelho FIEL de MIGRATION_0006_STMTS em src/db/migrate.ts.
const MIGRATION_0006: string[] = [
  `CREATE TABLE IF NOT EXISTS entity_channels (
     id         TEXT PRIMARY KEY,
     entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     kind       TEXT NOT NULL CHECK (kind IN ('email','phone','instagram','linkedin','crm','manychat','site','other')),
     value      TEXT NOT NULL,
     label      TEXT,
     is_primary INTEGER NOT NULL DEFAULT 0,
     position   INTEGER,
     created_at TEXT DEFAULT (datetime('now')),
     UNIQUE (entity_id, kind, value)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_channels_entity ON entity_channels (entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_channels_kind_value ON entity_channels (kind, value)`,
  `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
     SELECT lower(hex(randomblob(16))), id, 'email', email, 1, 0
       FROM entities WHERE email IS NOT NULL AND trim(email) != ''`,
  `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
     SELECT lower(hex(randomblob(16))), id, 'phone', phone, 1, 0
       FROM entities WHERE phone IS NOT NULL AND trim(phone) != ''`,
  `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
     SELECT lower(hex(randomblob(16))), id, 'site', website, 1, 0
       FROM entities WHERE kind = 'company' AND website IS NOT NULL AND trim(website) != ''`,
];

// migrations 0007_privacy (spec 50-console-v2/61) — coluna `private` em entities e
// events + índices parciais. Espelho FIEL de MIGRATION_0007_STMTS em src/db/migrate.ts.
const MIGRATION_0007: string[] = [
  `ALTER TABLE entities ADD COLUMN private INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE events   ADD COLUMN private INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_entities_private ON entities(private) WHERE private = 1`,
  `CREATE INDEX IF NOT EXISTS idx_events_private   ON events(private)   WHERE private = 1`,
];

const ALL_MIGRATIONS: Array<{ name: string; statements: string[] }> = [
  { name: '0001_initial_schema', statements: MIGRATION_0001 },
  { name: '0002_entities', statements: MIGRATION_0002 },
  { name: '0003_category', statements: MIGRATION_0003 },
  { name: '0004_media_dedup_index', statements: MIGRATION_0004 },
  { name: '0005_similar_edges', statements: MIGRATION_0005 },
  { name: '0006_entity_channels', statements: MIGRATION_0006 },
  { name: '0007_privacy', statements: MIGRATION_0007 },
];

// As 3 migrations são CUMULATIVAS/DESTRUTIVAS (RENAME/DROP) — rodar 2x quebra.
// Com `isolatedStorage: false` + `singleWorker: true`, o D1 é COMPARTILHADO entre
// os arquivos de teste, mas este setup file roda um beforeAll POR arquivo. Guarda:
// se o schema final já existe (tabela `entities` com coluna `category`), no-op.
async function schemaAlreadyApplied(db: D1Database): Promise<boolean> {
  try {
    const t = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'")
      .first<{ name: string }>();
    if (!t) return false;
    // confirma a coluna adicionada pela 0003 (schema final completo)
    const cols = await db.prepare('PRAGMA table_info(entities)').all<{ name: string }>();
    return (cols.results ?? []).some((c) => c.name === 'category');
  } catch {
    return false;
  }
}

// Aplica todas as migrations em ordem, statement por statement.
export async function applyMigrations(db: D1Database): Promise<void> {
  if (await schemaAlreadyApplied(db)) return; // já migrado (storage compartilhado)
  for (const migration of ALL_MIGRATIONS) {
    for (const stmt of migration.statements) {
      await db.prepare(stmt).run();
    }
  }
}

// Setup file: roda antes dos testes de cada arquivo; a guarda acima garante que a
// migração de verdade só acontece na primeira vez.
beforeAll(async () => {
  await applyMigrations(env.DB);
});
