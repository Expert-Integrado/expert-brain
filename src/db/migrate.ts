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

// 0009 — KANBAN COLUMNS. Colunas/estágios customizáveis do board /app/tasks,
// persistidos no banco (antes eram fixos em código). `notes.status` continua a
// fonte canônica de ESTADO (4 categorias, CHECK imutável da 0006); cada coluna
// AMARRA-se a uma dessas 4 via `category` e `notes.column_id` é o estágio VISUAL.
// ADD COLUMN column_id é seguro (não recria a tabela notes, que cascatearia
// edges/tags): nasce NULL pra todas as notas e é preenchido no backfill só pras
// tasks. Índice PARCIAL (WHERE kind='task') não indexa as notas de conhecimento.
// Seeds espelham o board fixo atual (INSERT OR IGNORE = idempotente); col_cancelado
// nasce ARQUIVADO (o board sempre escondeu canceladas — o dono desarquiva se quiser
// vê-las). Backfill mapeia os 4 status pros 4 seeds. Tudo aditivo. Ver spec 51.
const MIGRATION_0009_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS kanban_columns (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    color       TEXT,
    position    INTEGER NOT NULL,
    category    TEXT NOT NULL CHECK (category IN ('open','in_progress','done','canceled')),
    archived_at INTEGER
  )`,
  `ALTER TABLE notes ADD COLUMN column_id TEXT REFERENCES kanban_columns(id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_column ON notes (column_id) WHERE kind = 'task'`,
  `INSERT OR IGNORE INTO kanban_columns (id, label, color, position, category, archived_at)
     VALUES ('col_aberto', 'A fazer', NULL, 1, 'open', NULL)`,
  `INSERT OR IGNORE INTO kanban_columns (id, label, color, position, category, archived_at)
     VALUES ('col_progresso', 'Em progresso', NULL, 2, 'in_progress', NULL)`,
  `INSERT OR IGNORE INTO kanban_columns (id, label, color, position, category, archived_at)
     VALUES ('col_concluido', 'Concluído', NULL, 3, 'done', NULL)`,
  `INSERT OR IGNORE INTO kanban_columns (id, label, color, position, category, archived_at)
     VALUES ('col_cancelado', 'Cancelado', NULL, 4, 'canceled', strftime('%s','now')*1000)`,
  `UPDATE notes SET column_id = 'col_' || CASE status
       WHEN 'open' THEN 'aberto'
       WHEN 'in_progress' THEN 'progresso'
       WHEN 'done' THEN 'concluido'
       WHEN 'canceled' THEN 'cancelado'
     END
     WHERE kind = 'task' AND status IS NOT NULL AND column_id IS NULL`,
];

// 0010 — TASK COMMENTS. Thread de discussão por task com 3 autores possíveis: o
// dono (console), o agente (MCP) e o convidado (página pública /s/<token>). Tabela
// PRÓPRIA (não é nota) — comentário não vira nota de conhecimento, não embeda, não
// entra no grafo/recall. ON DELETE CASCADE limpa os comentários quando a task é
// HARD-deletada; o soft-delete (deleted_at) NÃO cascateia, então todos os read paths
// de comentário filtram a task viva (JOIN notes deleted_at IS NULL) pra que comentário
// de task na lixeira não vaze em nenhuma superfície. author_name é obrigatório (em
// código) quando author='guest' (≤60 chars); body 1..4000 (o público limita a 2000
// em código). created_at em unix ms (Date.now()), igual às demais tabelas. Aditiva:
// tabela nova + índice, não toca nenhuma linha existente. Ver spec 50-console-v2/53.
const MIGRATION_0010_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS task_comments (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    author      TEXT NOT NULL CHECK (author IN ('owner','guest','agent')),
    author_name TEXT,
    body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
    created_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments (task_id, created_at)`,
];

// 0011 — TASK PROJECTS (pastas). Eixo de agrupamento de tasks estilo pasta/lista do
// ClickUp, ORTOGONAL a domains (área de conhecimento) e a tags (rótulo transversal
// multi). Projeto é SINGLE-valorado: `notes.project_id` NULL = "Sem projeto" (estado
// default, válido pra sempre). Tabela PRÓPRIA (não é nota) — projeto não embeda, não
// entra no grafo/recall. ADD COLUMN project_id é seguro (não recria a tabela notes,
// que cascatearia edges/tags): nasce NULL pra TODAS as notas/tasks existentes (nenhuma
// linha é tocada). Índice PARCIAL (WHERE kind='task') não indexa as notas de
// conhecimento. archived_at: projeto arquivado some dos selects/filtros default, mas o
// project_id das tasks FICA (chip esmaecido) — arquivar não realoca nada. Cap de 64
// projetos é validado em código (criar via UI e auto-create do MCP). Sem seeds:
// nenhum projeto nasce criado. created_at/archived_at em unix ms. Ver spec
// 50-console-v2/58.
const MIGRATION_0011_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS task_projects (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    color       TEXT,
    position    INTEGER NOT NULL,
    archived_at INTEGER,
    created_at  INTEGER NOT NULL
  )`,
  `ALTER TABLE notes ADD COLUMN project_id TEXT REFERENCES task_projects(id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_project ON notes (project_id) WHERE kind = 'task'`,
];

// 0012 — ESCOPO DE PAT + AUTORIA DE ESCRITA (spec 10-backend/17). ADD COLUMN é
// seguro (não recria as tabelas api_keys/notes, que cascateariam edges/tags via FK).
// scopes DEFAULT 'full' preserva o comportamento de TODAS as chaves existentes ('full'
// = CRUD completo do vault); o único outro valor é 'read' (somente leitura). string
// simples — se um dia virar lista, migra pra CSV/JSON sem quebrar. created_by/updated_by
// guardam o id da api key (api_keys.id) ou 'oauth:<email>' pra sessões OAuth — nullable,
// notas antigas ficam NULL (zero linha tocada). Fundação de auditoria: aqui SÓ grava,
// sem UI/relatório. Tudo aditivo. Ver spec 10-backend/17.
const MIGRATION_0012_STMTS: string[] = [
  `ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT 'full'`,
  `ALTER TABLE notes ADD COLUMN created_by TEXT`,
  `ALTER TABLE notes ADD COLUMN updated_by TEXT`,
];

// 0013 — SELO DE PRIVACIDADE (spec 30-features/31). ADD COLUMN é seguro (não recria
// a tabela notes, que cascatearia edges/tags via FK). DEFAULT 0 = TODAS as notas
// existentes continuam PÚBLICAS: zero mudança de comportamento até o dono marcar uma
// nota. O índice é PARCIAL (WHERE private = 1): custo zero pras notas públicas (a
// maioria), rápido pra contar/localizar as privadas. NOTA: o trigger notes_au reinsere
// a linha no FTS em qualquer UPDATE — a nota privada CONTINUA no notes_fts (igual ao
// soft-delete). O gate é 100% nos read paths (recall/get_note/expand/stats/FTS filtram
// `private = 0` pra credencial sem escopo). O número 0009 citado na spec era indicativo
// — o trilho já ia até 0012_api_key_scopes, então usou-se o próximo livre: 0013 (ver
// regra transversal em specs/90-roadmap.md). Tudo aditivo. Ver spec 30-features/31.
const MIGRATION_0013_STMTS: string[] = [
  `ALTER TABLE notes ADD COLUMN private INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_notes_private ON notes(private) WHERE private = 1`,
];

// 0014 — INBOX DE CAPTURA (spec 50-console-v2/63). Alvo de baixa fricção pra
// captura instantânea (GTD inbox): TUDO entra cru numa tabela PRÓPRIA e é triado
// depois, em lote. Decisão de design (spec §Contexto): tabela SEPARADA de `notes` —
// um rascunho NÃO é nota, logo NÃO vaza em NENHUM read path de conhecimento
// (recall/FTS/grafo/stats) por CONSTRUÇÃO, sem precisar filtrar cada superfície
// (mesma classe de risco que o soft-delete evitou). `body` cru ≤4000 chars (validado
// em código). `source` é string livre informativa (mcp|console|telegram|whatsapp).
// triaged_at NULL = pendente; triage_action + result_id registram o desfecho da
// triagem (auditoria — o item descartado FICA na tabela). O índice é PARCIAL (WHERE
// triaged_at IS NULL): custo desprezível, indexa só a fila pendente (o que o badge/
// list_inbox contam). O número 0013 citado na spec era indicativo — o trilho já ia
// até 0013_private_notes, então usou-se o próximo livre: 0014 (regra transversal em
// specs/90-roadmap.md). Tudo aditivo: tabela nova + índice, não toca nenhuma linha
// existente e zero acoplamento com `notes`.
const MIGRATION_0014_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS inbox_items (
    id             TEXT PRIMARY KEY,
    body           TEXT NOT NULL,
    source         TEXT NOT NULL DEFAULT 'mcp',
    created_at     INTEGER NOT NULL,
    triaged_at     INTEGER,
    triage_action  TEXT,
    result_id      TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inbox_pending ON inbox_items (created_at) WHERE triaged_at IS NULL`,
];

// 0015 — MENÇÕES (tecido conectivo nota↔task↔contato, spec 50-console-v2/62). Vínculo
// FIRST-CLASS entre uma nota/task do Brain e uma entidade do vault de contatos
// (expert-contacts, D1 SEPARADO — por isso `entity_id` NÃO tem FK cross-DB). NÃO é
// edge do grafo (edges de/para task são rejeitadas por design; menção é outra relação,
// outra tabela). `note_id` referencia `notes(id)` (nota OU task — mesma tabela) com
// ON DELETE CASCADE: apagar a nota HARD limpa as menções (o soft-delete não cascateia,
// mas os read paths de menção já filtram nota viva). `entity_label` é CACHE de exibição
// (o nome canônico continua no contacts; refresh no render quando divergir é aceitável —
// não sincronizamos ativamente). UNIQUE(note_id, entity_id) garante 1 menção por par →
// dedupe → 1 evento `mentioned_in_brain` na timeline do contato por par. A coluna
// `origin_note_id` (só TASKS usam) registra a nota que ORIGINOU a task ("Criar task desta
// nota") pra auditar "por que essa task existe". ADD COLUMN é seguro (não recria `notes`,
// que cascatearia edges/tags via FK): nasce NULL pra TODAS as linhas existentes. O número
// 0012 citado na spec era indicativo — o trilho já ia até 0014_inbox, então usou-se o
// próximo livre: 0015 (regra transversal em specs/90-roadmap.md). Tudo aditivo.
const MIGRATION_0015_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS mentions (
    id           TEXT PRIMARY KEY,
    note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    entity_id    TEXT NOT NULL,
    entity_label TEXT,
    created_at   INTEGER NOT NULL,
    UNIQUE (note_id, entity_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions (entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mentions_note ON mentions (note_id)`,
  `ALTER TABLE notes ADD COLUMN origin_note_id TEXT REFERENCES notes(id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_origin ON notes (origin_note_id) WHERE kind = 'task'`,
];

export const MIGRATIONS: Array<{ id: string; stmts: string[] }> = [
  { id: '0001_init', stmts: MIGRATION_0001_STMTS },
  { id: '0002_domains_json_valid', stmts: MIGRATION_0002_STMTS },
  { id: '0003_api_keys', stmts: MIGRATION_0003_STMTS },
  { id: '0004_soft_delete', stmts: MIGRATION_0004_STMTS },
  { id: '0005_similar_edges', stmts: MIGRATION_0005_STMTS },
  { id: '0006_task_fields', stmts: MIGRATION_0006_STMTS },
  { id: '0007_note_media', stmts: MIGRATION_0007_STMTS },
  { id: '0008_share_task', stmts: MIGRATION_0008_STMTS },
  { id: '0009_kanban_columns', stmts: MIGRATION_0009_STMTS },
  { id: '0010_task_comments', stmts: MIGRATION_0010_STMTS },
  { id: '0011_task_projects', stmts: MIGRATION_0011_STMTS },
  { id: '0012_api_key_scopes', stmts: MIGRATION_0012_STMTS },
  { id: '0013_private_notes', stmts: MIGRATION_0013_STMTS },
  { id: '0014_inbox', stmts: MIGRATION_0014_STMTS },
  { id: '0015_mentions', stmts: MIGRATION_0015_STMTS },
];

// SQLite não tem ADD COLUMN IF NOT EXISTS. Se uma versão antiga do executor
// (pré-batch) morreu no meio de uma migration, colunas podem já existir sem a
// migration constar em _migrations. Filtra os ALTER ... ADD COLUMN cuja coluna
// já está na tabela, pra que o re-run complete em vez de explodir com
// "duplicate column name". Pré-check via PRAGMA (e não try/catch) porque um
// erro dentro do batch aborta o batch inteiro — não dá pra pular só um statement.
const ADD_COLUMN_RE = /^ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i;

async function filterAlreadyAppliedAlters(env: Env, stmts: string[]): Promise<string[]> {
  const out: string[] = [];
  const colsByTable = new Map<string, Set<string>>();
  for (const stmt of stmts) {
    const m = ADD_COLUMN_RE.exec(stmt.trim());
    if (!m) {
      out.push(stmt);
      continue;
    }
    const [, table, column] = m;
    if (!colsByTable.has(table)) {
      // Nome da tabela vem dos NOSSOS arrays de migration, não de input externo.
      const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      colsByTable.set(table, new Set((info.results ?? []).map((r) => r.name)));
    }
    if (!colsByTable.get(table)!.has(column)) out.push(stmt);
  }
  return out;
}

export async function runMigrations(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
  ).run();
  const applied = await env.DB.prepare(`SELECT id FROM _migrations`).all<{ id: string }>();
  const appliedIds = new Set((applied.results ?? []).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (appliedIds.has(m.id)) continue;
    const stmts = await filterAlreadyAppliedAlters(env, m.stmts);
    // batch é autocommit transacional no D1: ou a migration inteira aplica E
    // registra em _migrations, ou nada aplica — nunca fica "meio aplicada".
    await env.DB.batch([
      ...stmts.map((s) => env.DB.prepare(s)),
      env.DB.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`).bind(m.id, Date.now()),
    ]);
  }
}
