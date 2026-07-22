import type { Env } from '../env';

// ─────────────────────────────────────────────────────────────────────────────
// Migrations rastreadas em código (padrão portado do expert-brain
// `src/db/migrate.ts`). Fonte de VERDADE do schema — a pasta `migrations/*.sql`
// é referência histórica APENAS (ver migrations/README.md).
//
// Cada migration é um array de statements SQL atômicos: NUNCA splitar por ';',
// porque o corpo dos TRIGGERs (BEGIN..END) tem ';' interno e um splitter ingênuo
// quebraria o statement no meio.
//
// REGRA PERMANENTE PRA DDL FUTURA: migrations sempre ADITIVAS
// (`ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
// Qualquer DDL destrutiva (DROP, RENAME, rebuild) SÓ atrás de guard explícito que
// checa existência/estado antes (`SELECT ... FROM sqlite_master` ou
// `PRAGMA table_info`), com justificativa no comentário da migration.
// ─────────────────────────────────────────────────────────────────────────────

// migrations/0001_initial_schema.sql (transcrição fiel; cada trigger é 1 statement).
const MIGRATION_0001_STMTS: string[] = [
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

// migrations/0002_entities.sql — DESTRUTIVA por construção (RENAME + DROP TABLE).
// Em produção NUNCA executa (baseline marca como aplicada). Num banco NOVO roda
// logo após a 0001, então a sequência people→entities é determinística. Guards de
// idempotência onde o SQLite permite (DROP ... IF EXISTS, CREATE ... IF NOT EXISTS).
const MIGRATION_0002_STMTS: string[] = [
  `ALTER TABLE people ADD COLUMN kind TEXT NOT NULL DEFAULT 'person'`,
  `ALTER TABLE people ADD COLUMN website TEXT`,
  `ALTER TABLE people ADD COLUMN sector TEXT`,
  `ALTER TABLE people ADD COLUMN attributes TEXT`,
  `DROP TRIGGER IF EXISTS people_set_updated`,
  `ALTER TABLE people RENAME TO entities`,
  `CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind)`,
  `CREATE TABLE IF NOT EXISTS connections_v2 (
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
  `CREATE INDEX IF NOT EXISTS idx_conn_a ON connections(a_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conn_b ON connections(b_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conn_type ON connections(type)`,
  `CREATE TABLE IF NOT EXISTS events_v2 (
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
  `CREATE INDEX IF NOT EXISTS idx_events_entity_ts ON events(entity_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)`,
  `CREATE TABLE IF NOT EXISTS media_v2 (
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
  `CREATE INDEX IF NOT EXISTS idx_media_entity ON media(entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_media_hash ON media(content_hash)`,
  // TRIGGER: statement ÚNICO (corpo BEGIN..END tem ';' interno).
  `CREATE TRIGGER IF NOT EXISTS entities_set_updated AFTER UPDATE ON entities FOR EACH ROW BEGIN UPDATE entities SET updated_at = datetime('now') WHERE id = NEW.id; END`,
];

// migrations/0003_category.sql — aditiva.
const MIGRATION_0003_STMTS: string[] = [
  `ALTER TABLE entities ADD COLUMN category TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_entities_category ON entities(category)`,
];

// migrations/0004_media_dedup_index.sql — índice aditivo pra dedup de mídia por
// (entity_id, content_hash). Habilita o dedup na app (handleAttachMedia) sem
// UNIQUE constraint (checagem em código). Ver spec 10-backend/19 item 7.
const MIGRATION_0004_STMTS: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_media_entity_hash ON media(entity_id, content_hash)`,
];

// migrations/0005_similar_edges.sql — similar edges PRÉ-COMPUTADAS (porta da
// 0005_similar_edges do Expert Brain). O grafo do Console deixava de carregar acima
// de ~900 nós conectados porque computava similaridade AO VIVO (1 query Vectorize por
// nó no loop de src/web/similarity.ts) e estourava o cap de subrequests do Cloudflare.
// Agora cada entidade grava seus top-k vizinhos no write path e o grafo só LÊ desta
// tabela. Aditiva: nasce vazia; sem linhas = grafo sem arestas de similaridade até o
// backfill rodar (nunca erro). ON DELETE CASCADE limpa arestas de entidade removida.
// Ver spec 10-backend/21.
const MIGRATION_0005_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS similar_edges (
     from_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     to_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     score    REAL NOT NULL,
     PRIMARY KEY (from_id, to_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_similar_from ON similar_edges(from_id)`,
  `CREATE INDEX IF NOT EXISTS idx_similar_to   ON similar_edges(to_id)`,
];

// migrations/0006_entity_channels — cartela de canais (spec 50-console-v2/55).
// ADITIVA: nova tabela + backfill dos canais primários a partir das colunas atuais
// (email/phone singulares e website de empresa). As colunas entities.email/phone
// PERMANECEM como espelho do canal primário (compat com dedupe/lookup por telefone).
// O UNIQUE(entity_id, kind, value) + INSERT OR IGNORE tornam o backfill idempotente.
// ids gerados via hex(randomblob(16)) (SQLite não tem uuid()).
const MIGRATION_0006_STMTS: string[] = [
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
  // backfill: email primário
  `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
     SELECT lower(hex(randomblob(16))), id, 'email', email, 1, 0
       FROM entities WHERE email IS NOT NULL AND trim(email) != ''`,
  // backfill: phone primário
  `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
     SELECT lower(hex(randomblob(16))), id, 'phone', phone, 1, 0
       FROM entities WHERE phone IS NOT NULL AND trim(phone) != ''`,
  // backfill: site primário (só empresas)
  `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
     SELECT lower(hex(randomblob(16))), id, 'site', website, 1, 0
       FROM entities WHERE kind = 'company' AND website IS NOT NULL AND trim(website) != ''`,
];

// migrations/0007_privacy — selo de privacidade (spec 50-console-v2/61). ADITIVA:
// coluna `private` (0/1) em entities e events + índices PARCIAIS (custo zero pras
// linhas públicas, a maioria). DEFAULT 0 = tudo continua público; zero mudança de
// comportamento até o dono marcar. O gate de visibilidade é 100% nos read paths GET
// (helper callerSeesPrivate, src/web/privacy.ts) — a coluna nunca é DROPada.
const MIGRATION_0007_STMTS: string[] = [
  `ALTER TABLE entities ADD COLUMN private INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE events   ADD COLUMN private INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_entities_private ON entities(private) WHERE private = 1`,
  `CREATE INDEX IF NOT EXISTS idx_events_private   ON events(private)   WHERE private = 1`,
];

// migrations/0008_google_links — vínculo Google Contacts ↔ entidade (specs/
// google-contacts-sync.md). ADITIVA: tabela de link 1:1 por resource_name do
// People API. `etag` permite pular pessoa não mudada; deletar a LINHA desfaz o
// vínculo sem tocar na entidade (deleção no Google NUNCA deleta entidade aqui).
const MIGRATION_0008_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS google_links (
     resource_name TEXT PRIMARY KEY,
     entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     etag          TEXT,
     synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_google_links_entity ON google_links(entity_id)`,
];

// migrations/0009_whatsapp_links — vínculo grupo do WhatsApp ↔ entidade kind='group'
// (specs/whatsapp-groups-sync.md). ADITIVA: mesmo desenho da google_links (0008),
// chaveada pelo chat_id da Z-API. Deletar a LINHA desfaz o vínculo sem tocar na
// entidade do grupo nem nas connections.
const MIGRATION_0009_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS whatsapp_links (
     chat_id   TEXT PRIMARY KEY,
     entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     synced_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_whatsapp_links_entity ON whatsapp_links(entity_id)`,
];

// migrations/0010_instagram_links — vínculo conversa do Instagram ↔ entidade
// (specs/instagram-contacts-sync.md). ADITIVA: mesmo desenho da whatsapp_links
// (0009), chaveada pelo igsid (Instagram-scoped ID do interlocutor).
const MIGRATION_0010_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS instagram_links (
     igsid     TEXT PRIMARY KEY,
     entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
     synced_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_instagram_links_entity ON instagram_links(entity_id)`,
];

// migrations/0011_google_push_queue — fila do write-back vault→Google (specs/
// google-contacts-sync.md, seção write-back). ADITIVA: PK em entity_id deduplica
// edições em rajada (re-enfileirar reseta a linha via ON CONFLICT no código);
// CASCADE limpa a fila quando a entidade morre (delete/perdedor de merge).
const MIGRATION_0011_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS google_push_queue (
     entity_id  TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
     queued_at  TEXT NOT NULL DEFAULT (datetime('now')),
     attempts   INTEGER NOT NULL DEFAULT 0,
     last_error TEXT
   )`,
];

// ids das migrations HISTÓRICAS (já aplicadas em produção pré-tracking). O baseline
// marca EXATAMENTE estas como aplicadas sem executar DDL. Migrations novas (0004+)
// NÃO entram aqui — elas rodam normalmente, inclusive em produção.
const LEGACY_APPLIED_IDS = ['0001_initial_schema', '0002_entities', '0003_category'] as const;

const MIGRATIONS: Array<{ id: string; stmts: string[] }> = [
  { id: '0001_initial_schema', stmts: MIGRATION_0001_STMTS },
  { id: '0002_entities', stmts: MIGRATION_0002_STMTS },
  { id: '0003_category', stmts: MIGRATION_0003_STMTS },
  { id: '0004_media_dedup_index', stmts: MIGRATION_0004_STMTS },
  { id: '0005_similar_edges', stmts: MIGRATION_0005_STMTS },
  { id: '0006_entity_channels', stmts: MIGRATION_0006_STMTS },
  { id: '0007_privacy', stmts: MIGRATION_0007_STMTS },
  { id: '0008_google_links', stmts: MIGRATION_0008_STMTS },
  { id: '0009_whatsapp_links', stmts: MIGRATION_0009_STMTS },
  { id: '0010_instagram_links', stmts: MIGRATION_0010_STMTS },
  { id: '0011_google_push_queue', stmts: MIGRATION_0011_STMTS },
];

// Idempotente: pula ids já registrados, registra cada id após aplicar.
export async function runMigrations(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
  ).run();

  // BASELINE: se o schema v0.4 já existe (tabela `entities` presente) e a
  // _migrations está vazia, é o banco de produção pré-tracking. Marca as 3
  // migrations históricas como aplicadas SEM executar nada (a 0002 tem DROP
  // TABLE — re-executar seria perda de dados).
  const hasEntities = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='entities'`
  ).first();
  const applied = await env.DB.prepare(`SELECT id FROM _migrations`).all<{ id: string }>();
  const appliedIds = new Set((applied.results ?? []).map((r) => r.id));
  if (hasEntities && appliedIds.size === 0) {
    for (const legacy of LEGACY_APPLIED_IDS) {
      await env.DB.prepare(`INSERT OR IGNORE INTO _migrations (id, applied_at) VALUES (?, ?)`)
        .bind(legacy, Date.now()).run();
      appliedIds.add(legacy);
    }
  }

  for (const m of MIGRATIONS) {
    if (appliedIds.has(m.id)) continue;
    for (const stmt of m.stmts) {
      try {
        await env.DB.prepare(stmt).run();
      } catch (e: any) {
        // ADD COLUMN é ADITIVA porém NÃO idempotente em SQLite (não há
        // "ADD COLUMN IF NOT EXISTS"). Num banco que já tem a coluna (ex.: schema
        // provisionado por outra via, sem registro em _migrations), re-aplicar dá
        // "duplicate column name" — que aqui é um NO-OP seguro: a coluna já existe,
        // o efeito desejado (aditivo) já está presente. Tolerar SÓ esse erro mantém
        // a garantia de "migrations sempre aditivas/re-runnable"; qualquer outro erro
        // sobe normalmente.
        if (/duplicate column name/i.test(String(e?.message || e))) continue;
        throw e;
      }
    }
    await env.DB.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`)
      .bind(m.id, Date.now()).run();
    appliedIds.add(m.id);
  }
}
