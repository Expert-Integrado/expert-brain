#!/usr/bin/env node
// Seed determinístico de dados de DEV pro D1 LOCAL do Brain (este repo) e do
// Contacts (repo irmão C:/repos/expert-contacts) — spec 60-ux-reforma/61 (Onda 0).
//
// Objetivo: popular o console local com dados 100% FICTÍCIOS pra auditoria visual
// e e2e, cobrindo os 7 kinds de nota, o board de tasks (4 categorias), projetos,
// comentários, inbox, menções e o vault de contatos (entities/eventos/canais).
//
// REGRAS DURAS (não flexibilizar sem pedido explícito do dono):
//   - SOMENTE `--local` (nunca --remote, nunca produção).
//   - Todo id nasce com prefixo `seed-` — nenhum dado real é tocado.
//   - Nomes/telefones/e-mails são obviamente fictícios (Ana Almeida, Bruno Castro,
//     Empresa Exemplo Ltda, +55 11 90001-000X).
//
// Uso:
//   node scripts/seed-dev.mjs --local [--reset] [--force]
//     --local   OBRIGATÓRIO. Sem essa flag o script aborta (trava contra --remote).
//     --reset   Apaga ANTES tudo com id LIKE 'seed-%' (cascata cuida do resto).
//     --force   Segue mesmo se já existirem rows seed-% (sem --reset e sem --force,
//               o script aborta pra não duplicar).
//
// Efeito colateral não-óbvio: o D1 local do expert-contacts estava 3 migrations
// atrás do código atual (faltavam similar_edges/entity_channels/coluna private) —
// o script traz o schema local em dia ANTES de semear, usando os MESMOS statements
// aditivos de src/db/migrate.ts (ver ensureContactsSchemaCurrent). Isso é o caminho
// oficial (mesma DDL que rodaria via POST /setup/provision), só que aplicado direto
// no D1 local via wrangler.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

if (!has('--local')) {
  console.error('ABORT: falta a flag --local (obrigatória — este script NUNCA roda contra --remote).');
  console.error('Uso: node scripts/seed-dev.mjs --local [--reset] [--force]');
  process.exit(1);
}
const RESET = has('--reset');
const FORCE = has('--force');

const BRAIN_DIR = 'C:/repos/expert-brain';
const CONTACTS_DIR = 'C:/repos/expert-contacts';
const TMP_DIR = 'C:/tmp';
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const NOW = Date.now();
const DAY = 86400000;
const HOUR = 3600000;

// ─────────────────────────────── helpers SQL ───────────────────────────────

function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insertStmt(table, cols, rows) {
  if (rows.length === 0) return '';
  const values = rows.map((r) => `  (${cols.map((c) => sqlVal(r[c])).join(', ')})`).join(',\n');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES\n${values};`;
}

function sqliteDatetime(ms) {
  // Espelha o formato de datetime('now') do SQLite: 'YYYY-MM-DD HH:MM:SS' em UTC.
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function writeSqlFile(label, statements) {
  const file = path.join(TMP_DIR, `seed-dev-${label}-${Date.now()}.sql`);
  fs.writeFileSync(file, statements.filter(Boolean).join('\n\n') + '\n', 'utf8');
  return file;
}

// O dev local canônico é multi-worker a partir do repo do Brain (npm run dev:full)
// e nesse modo TODOS os bindings persistem no .wrangler/state do BRAIN. O d1 execute
// do contacts precisa apontar pra esse state compartilhado via --persist-to — sem
// isso o seed cai no sqlite do repo do contacts e o worker em dev enxerga banco vazio.
const CONTACTS_PERSIST = `--persist-to "${BRAIN_DIR}/.wrangler/state"`;
const d1Flags = (cwd) => (cwd === CONTACTS_DIR ? `--local ${CONTACTS_PERSIST}` : '--local');

function runD1File(cwd, file, label) {
  console.log(`\n[${label}] wrangler d1 execute DB ${d1Flags(cwd)} --file ${file} (cwd=${cwd})`);
  execSync(`npx wrangler d1 execute DB ${d1Flags(cwd)} --file "${file}"`, { cwd, stdio: 'inherit' });
}

// Statement ÚNICO mutante via --command — usado pros CREATE TRIGGER (corpo
// BEGIN...END tem ';' interno; o splitter de --file do wrangler 4.107 até lida,
// testado, mas rodar cada trigger como comando isolado blinda contra regressão
// de splitter em versões futuras). O statement não pode conter aspas duplas.
function runD1Command(cwd, sql, label) {
  console.log(`\n[${label}] wrangler d1 execute DB ${d1Flags(cwd)} --command <1 stmt> (cwd=${cwd})`);
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  execSync(`npx wrangler d1 execute DB ${d1Flags(cwd)} --command "${oneLine.replace(/"/g, '\\"')}"`, {
    cwd,
    stdio: 'inherit',
  });
}

function queryD1(cwd, command) {
  const out = execSync(`npx wrangler d1 execute DB ${d1Flags(cwd)} --command "${command.replace(/"/g, '\\"')}"`, {
    cwd,
    encoding: 'utf8',
  });
  const jsonStart = out.indexOf('[');
  if (jsonStart === -1) return [];
  const parsed = JSON.parse(out.slice(jsonStart));
  return parsed[0]?.results ?? [];
}

function countSeed(cwd, table, col = 'id') {
  const r = queryD1(cwd, `SELECT count(*) c FROM ${table} WHERE ${col} LIKE 'seed-%'`);
  return r[0]?.c ?? 0;
}

// ───────────────────────── 0. Brain: schema já está em dia ─────────────────────────
// (confirmado via _migrations: 16/16 migrations aplicadas no D1 local do Brain.)

// ─────────────────── 0b. Contacts: trazer o schema local em dia ───────────────────
// Transcrição FIEL da cadeia de migrations de C:/repos/expert-contacts/src/db/migrate.ts
// (fonte de verdade do schema — migrations/*.sql lá é referência histórica). Necessária
// porque no dev multi-worker (npx wrangler dev -c wrangler.toml -c ../expert-contacts/
// wrangler.toml, rodado do repo do Brain) o D1 local do contacts persiste no
// .wrangler/state do BRAIN e nasce 100% VAZIO (só _cf_METADATA) — o worker nunca rodou
// POST /setup/provision ali. Cada CREATE TRIGGER é 1 statement (BEGIN...END com ';'
// interno) e roda via --command isolado (ver runD1Command).
const CONTACTS_MIGRATIONS = [
  { id: '0001_initial_schema', stmts: [
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
     );`,
    `CREATE INDEX IF NOT EXISTS idx_people_phone ON people(phone) WHERE phone IS NOT NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_people_email ON people(email) WHERE email IS NOT NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_people_company ON people(company) WHERE company IS NOT NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_people_source ON people(source);`,
    `CREATE INDEX IF NOT EXISTS idx_people_last_contacted ON people(last_contacted DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_people_birthday_md ON people(SUBSTR(birthday, 6, 5));`,
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
     );`,
    `CREATE INDEX IF NOT EXISTS idx_conn_person_a ON connections(person_a);`,
    `CREATE INDEX IF NOT EXISTS idx_conn_person_b ON connections(person_b);`,
    `CREATE INDEX IF NOT EXISTS idx_conn_type ON connections(type);`,
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
     );`,
    `CREATE INDEX IF NOT EXISTS idx_events_person_ts ON events(person_id, ts DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);`,
    `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);`,
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
     );`,
    `CREATE INDEX IF NOT EXISTS idx_media_person ON media(person_id);`,
    `CREATE INDEX IF NOT EXISTS idx_media_hash ON media(content_hash);`,
    `CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);`,
    `CREATE TRIGGER IF NOT EXISTS people_set_updated AFTER UPDATE ON people FOR EACH ROW BEGIN UPDATE people SET updated_at = datetime('now') WHERE id = NEW.id; END`,
  ] },
  // 0002 é DESTRUTIVA por construção (RENAME + DROP) — aqui SÓ roda em banco novo
  // (o gate em ensureContactsSchemaCurrent exige que `entities` NÃO exista), então
  // a sequência people→entities é determinística e não há dado pra perder.
  { id: '0002_entities', stmts: [
    `ALTER TABLE people ADD COLUMN kind TEXT NOT NULL DEFAULT 'person';`,
    `ALTER TABLE people ADD COLUMN website TEXT;`,
    `ALTER TABLE people ADD COLUMN sector TEXT;`,
    `ALTER TABLE people ADD COLUMN attributes TEXT;`,
    `DROP TRIGGER IF EXISTS people_set_updated;`,
    `ALTER TABLE people RENAME TO entities;`,
    `CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);`,
    `CREATE TABLE IF NOT EXISTS connections_v2 (
       id          TEXT PRIMARY KEY,
       a_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
       b_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
       type        TEXT NOT NULL,
       strength    REAL NOT NULL CHECK(strength BETWEEN 0 AND 1),
       why         TEXT NOT NULL CHECK(length(why) >= 20),
       created_at  TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(a_id, b_id, type)
     );`,
    `INSERT INTO connections_v2 (id, a_id, b_id, type, strength, why, created_at)
       SELECT id, person_a, person_b, type, strength, why, created_at FROM connections;`,
    `DROP TABLE connections;`,
    `ALTER TABLE connections_v2 RENAME TO connections;`,
    `CREATE INDEX IF NOT EXISTS idx_conn_a ON connections(a_id);`,
    `CREATE INDEX IF NOT EXISTS idx_conn_b ON connections(b_id);`,
    `CREATE INDEX IF NOT EXISTS idx_conn_type ON connections(type);`,
    `CREATE TABLE IF NOT EXISTS events_v2 (
       id          TEXT PRIMARY KEY,
       entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
       kind        TEXT NOT NULL,
       ts          TEXT NOT NULL DEFAULT (datetime('now')),
       context     TEXT,
       source      TEXT NOT NULL DEFAULT 'manual'
     );`,
    `INSERT INTO events_v2 (id, entity_id, kind, ts, context, source)
       SELECT id, person_id, kind, ts, context, source FROM events;`,
    `DROP TABLE events;`,
    `ALTER TABLE events_v2 RENAME TO events;`,
    `CREATE INDEX IF NOT EXISTS idx_events_entity_ts ON events(entity_id, ts DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);`,
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
     );`,
    `INSERT INTO media_v2 (id, entity_id, kind, r2_key, content_hash, mime_type, byte_size, caption, created_at)
       SELECT id, person_id, kind, r2_key, content_hash, mime_type, byte_size, caption, created_at FROM media;`,
    `DROP TABLE media;`,
    `ALTER TABLE media_v2 RENAME TO media;`,
    `CREATE INDEX IF NOT EXISTS idx_media_entity ON media(entity_id);`,
    `CREATE INDEX IF NOT EXISTS idx_media_hash ON media(content_hash);`,
    `CREATE TRIGGER IF NOT EXISTS entities_set_updated AFTER UPDATE ON entities FOR EACH ROW BEGIN UPDATE entities SET updated_at = datetime('now') WHERE id = NEW.id; END`,
  ] },
  { id: '0003_category', stmts: [
    `ALTER TABLE entities ADD COLUMN category TEXT;`,
    `CREATE INDEX IF NOT EXISTS idx_entities_category ON entities(category);`,
  ] },
  { id: '0004_media_dedup_index', stmts: [
    `CREATE INDEX IF NOT EXISTS idx_media_entity_hash ON media(entity_id, content_hash);`,
  ] },
  { id: '0005_similar_edges', stmts: [
    `CREATE TABLE IF NOT EXISTS similar_edges (
       from_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
       to_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
       score    REAL NOT NULL,
       PRIMARY KEY (from_id, to_id)
     );`,
    `CREATE INDEX IF NOT EXISTS idx_similar_from ON similar_edges(from_id);`,
    `CREATE INDEX IF NOT EXISTS idx_similar_to ON similar_edges(to_id);`,
  ] },
  { id: '0006_entity_channels', stmts: [
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
     );`,
    `CREATE INDEX IF NOT EXISTS idx_channels_entity ON entity_channels (entity_id);`,
    `CREATE INDEX IF NOT EXISTS idx_channels_kind_value ON entity_channels (kind, value);`,
    `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
       SELECT lower(hex(randomblob(16))), id, 'email', email, 1, 0 FROM entities WHERE email IS NOT NULL AND trim(email) != '';`,
    `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
       SELECT lower(hex(randomblob(16))), id, 'phone', phone, 1, 0 FROM entities WHERE phone IS NOT NULL AND trim(phone) != '';`,
    `INSERT OR IGNORE INTO entity_channels (id, entity_id, kind, value, is_primary, position)
       SELECT lower(hex(randomblob(16))), id, 'site', website, 1, 0 FROM entities WHERE kind = 'company' AND website IS NOT NULL AND trim(website) != '';`,
  ] },
  { id: '0007_privacy', stmts: [
    `ALTER TABLE entities ADD COLUMN private INTEGER NOT NULL DEFAULT 0;`,
    `ALTER TABLE events ADD COLUMN private INTEGER NOT NULL DEFAULT 0;`,
    `CREATE INDEX IF NOT EXISTS idx_entities_private ON entities(private) WHERE private = 1;`,
    `CREATE INDEX IF NOT EXISTS idx_events_private ON events(private) WHERE private = 1;`,
  ] },
];

// Aplica uma lista de migrations preservando a ORDEM dos statements: os não-trigger
// consecutivos vão agrupados num .sql (1 chamada wrangler por lote); cada CREATE
// TRIGGER interrompe o lote e roda isolado via --command (BEGIN...END com ';' interno
// não pode depender do splitter de --file). Registro em _migrations vai por último,
// num lote só — se qualquer statement falhar, o execSync lança e NADA é registrado
// (re-rodar recomeça a cadeia; tudo é IF NOT EXISTS exceto ALTER/RENAME, que só
// existem no caminho de banco 100% vazio).
function applyContactsMigrations(migrations) {
  for (const m of migrations) {
    let batch = [];
    let part = 0;
    const flush = () => {
      if (batch.length === 0) return;
      part += 1;
      runD1File(CONTACTS_DIR, writeSqlFile(`contacts-${m.id}-p${part}`, batch), `contacts:${m.id} (${batch.length} stmts)`);
      batch = [];
    };
    for (const stmt of m.stmts) {
      if (/^\s*CREATE TRIGGER/i.test(stmt)) {
        flush();
        runD1Command(CONTACTS_DIR, stmt, `contacts:${m.id}:trigger`);
      } else {
        batch.push(stmt);
      }
    }
    flush();
  }
  const reg = [`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`];
  for (const m of migrations) {
    reg.push(`INSERT OR IGNORE INTO _migrations (id, applied_at) VALUES ('${m.id}', ${Date.now()});`);
  }
  runD1File(CONTACTS_DIR, writeSqlFile('contacts-migrations-register', reg), 'contacts:_migrations');
}

// Três estados possíveis do D1 local do contacts:
//   1. VAZIO (só _cf_METADATA) — caso do state compartilhado do dev multi-worker,
//      que nunca passou por /setup/provision: aplica a cadeia COMPLETA 0001..0007.
//   2. Parcial (entities existe, faltam 0005/0006/0007) — caso do state antigo do
//      repo do contacts: aplica só as que faltam (todas aditivas).
//   3. Em dia: no-op.
function ensureContactsSchemaCurrent() {
  const tables = queryD1(CONTACTS_DIR, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);

  if (!tables.includes('entities')) {
    if (tables.includes('people')) {
      // Meio da 0002 (people ainda não renomeada): estado inconsistente que este
      // script não fabrica — não tentar adivinhar o ponto de retomada.
      console.error('ABORT: banco do contacts tem `people` mas não `entities` (migração 0002 pela metade). Resolver manualmente.');
      process.exit(1);
    }
    console.log('[contacts] banco VAZIO no state compartilhado — provisionando a cadeia completa 0001..0007 (mesmos statements de src/db/migrate.ts)...');
    applyContactsMigrations(CONTACTS_MIGRATIONS);
    return;
  }

  const cols = queryD1(CONTACTS_DIR, 'PRAGMA table_info(entities)').map((r) => r.name);
  const hasPrivate = cols.includes('private');
  const hasChannels = tables.includes('entity_channels');
  const hasSimilar = tables.includes('similar_edges');

  if (hasPrivate && hasChannels && hasSimilar) {
    console.log('[contacts] schema já em dia (0001..0007) — pulando bring-up.');
    return;
  }

  console.log('[contacts] schema parcial — aplicando só as migrations que faltam (aditivas)...');
  const pending = CONTACTS_MIGRATIONS.filter((m) =>
    (m.id === '0005_similar_edges' && !hasSimilar) ||
    (m.id === '0006_entity_channels' && !hasChannels) ||
    (m.id === '0007_privacy' && !hasPrivate)
  );
  applyContactsMigrations(pending);
}

// ───────────────────────────── 1. Reset (opcional) ─────────────────────────────

function resetBrain() {
  console.log('[brain] --reset: apagando rows seed-% (cascade cuida de tags/edges/comments/mentions)...');
  const stmts = [
    `DELETE FROM notes WHERE id LIKE 'seed-%';`,
    `DELETE FROM edges WHERE id LIKE 'seed-%' OR from_id LIKE 'seed-%' OR to_id LIKE 'seed-%';`,
    `DELETE FROM tags WHERE note_id LIKE 'seed-%';`,
    `DELETE FROM task_comments WHERE id LIKE 'seed-%' OR task_id LIKE 'seed-%';`,
    `DELETE FROM mentions WHERE id LIKE 'seed-%' OR note_id LIKE 'seed-%' OR entity_id LIKE 'seed-%';`,
    `DELETE FROM similar_edges WHERE from_id LIKE 'seed-%' OR to_id LIKE 'seed-%';`,
    `DELETE FROM inbox_items WHERE id LIKE 'seed-%';`,
    `DELETE FROM task_projects WHERE id LIKE 'seed-%';`,
  ];
  runD1File(BRAIN_DIR, writeSqlFile('brain-reset', stmts), 'brain:reset');
}

function resetContacts() {
  console.log('[contacts] --reset: apagando rows seed-% (cascade cuida de channels/events/connections)...');
  const stmts = [
    `DELETE FROM entities WHERE id LIKE 'seed-%';`,
    `DELETE FROM entity_channels WHERE id LIKE 'seed-%' OR entity_id LIKE 'seed-%';`,
    `DELETE FROM events WHERE id LIKE 'seed-%' OR entity_id LIKE 'seed-%';`,
    `DELETE FROM connections WHERE id LIKE 'seed-%' OR a_id LIKE 'seed-%' OR b_id LIKE 'seed-%';`,
    `DELETE FROM media WHERE id LIKE 'seed-%' OR entity_id LIKE 'seed-%';`,
    `DELETE FROM similar_edges WHERE from_id LIKE 'seed-%' OR to_id LIKE 'seed-%';`,
  ];
  runD1File(CONTACTS_DIR, writeSqlFile('contacts-reset', stmts), 'contacts:reset');
}

// ───────────────────────────── 2. Dados — Brain ─────────────────────────────

// 20 notas de conhecimento cobrindo os 7 kinds. Conteúdo 100% fictício, PT-BR.
const domainsJson = (arr) => JSON.stringify(arr);

const KNOWLEDGE_NOTES = [
  { id: 'seed-note-01', kind: 'concept', domains: ['ai-applied'], title: 'Latticework de conhecimento', tldr: 'Rede de conceitos conectados por edges com mecanismo explícito, não só palavra-chave em comum.', body: 'Um latticework junta conceitos de domínios diferentes por analogia estrutural. O valor não é achar a nota parecida, é achar a nota que explica o MESMO mecanismo com outra roupagem.' },
  { id: 'seed-note-02', kind: 'concept', domains: ['music'], title: 'Escala pentatônica como atalho de improviso', tldr: 'Cinco notas que soam bem sobre quase qualquer acorde do mesmo campo harmônico.', body: 'A pentatônica remove as notas que mais colidem com o acorde de base, então quem está começando erra menos e ganha confiança pra improvisar cedo.' },
  { id: 'seed-note-03', kind: 'concept', domains: ['cognitive-science'], title: 'Carga cognitiva extrínseca', tldr: 'Esforço mental gasto com o formato da informação, não com o conteúdo em si.', body: 'Formato ruim (texto denso, sem hierarquia visual) rouba capacidade mental que deveria ir pro raciocínio. Reduzir carga extrínseca libera atenção pro que importa.' },
  { id: 'seed-note-04', kind: 'decision', domains: ['product'], title: 'Adotar Kanban customizável no console (exemplo fictício)', tldr: 'Colunas configuráveis substituem status fixo porque times fictícios têm fluxos diferentes.', body: 'Decisão de exemplo: status fixo (4 categorias) virou insuficiente pra representar o fluxo real de um time de exemplo. A saída foi separar "categoria" (estado) de "coluna" (estágio visual).' },
  { id: 'seed-note-05', kind: 'decision', domains: ['sales'], title: 'Fechar diagnóstico antes de proposta (cenário fictício)', tldr: 'Diagnóstico pago filtra lead sem orçamento antes de gastar hora de proposta.', body: 'Em um cenário fictício de vendas, propostas gratuitas geravam muito trabalho pra lead que nunca fechava. Cobrar um diagnóstico inicial filtrou quem realmente tinha orçamento.' },
  { id: 'seed-note-06', kind: 'decision', domains: ['operations'], title: 'Mover onboarding pra squad dedicado (exemplo fictício)', tldr: 'Squad único de onboarding reduz tempo de ativação do cliente novo.', body: 'Cenário fictício: onboarding espalhado entre vários times gerava perda de contexto. Um squad dedicado, do pagamento ao go-live, cortou o tempo de ativação pela metade nos dados de exemplo.' },
  { id: 'seed-note-07', kind: 'insight', domains: ['marketing'], title: 'Prova social vence argumento técnico', tldr: 'Case com número converte mais que explicação de como a ferramenta funciona.', body: 'Em testes fictícios de página, a seção de case com número concreto teve mais engajamento que a seção explicando a arquitetura técnica do produto.' },
  { id: 'seed-note-08', kind: 'insight', domains: ['leadership'], title: 'Reunião 1:1 sem pauta vira desabafo', tldr: 'Sem pauta prévia, 1:1 tende a virar queixa solta em vez de plano de ação.', body: 'Observação de cenário fictício: 1:1 sem pauta enviada com antecedência consistentemente derivava pra desabafo sem produzir um próximo passo concreto.' },
  { id: 'seed-note-09', kind: 'insight', domains: ['entrepreneurship'], title: 'Caixa baixo muda o critério de decisão', tldr: 'Com caixa curto, decisão de preço pesa mais o fluxo imediato que o LTV.', body: 'Em cenário fictício de caixa apertado, decisões que deveriam ser guiadas por LTV de longo prazo passaram a ser guiadas por "isso entra em caixa este mês".' },
  { id: 'seed-note-10', kind: 'fact', domains: ['education'], title: 'Turma de mentoria fictícia bateu recorde de presença', tldr: 'Turma-exemplo de julho teve 92% de presença média nas aulas ao vivo.', body: 'Dado fictício de exemplo: turma de julho registrou 92% de presença média, o maior número entre as 6 turmas simuladas do ano.' },
  { id: 'seed-note-11', kind: 'fact', domains: ['sales'], title: 'Ciclo médio de venda educacional fictício', tldr: 'Ciclo médio simulado do produto educacional fica em 21 dias entre contato e fechamento.', body: 'Dado fictício: no funil de exemplo, o tempo médio entre primeiro contato e fechamento caiu de 34 para 21 dias depois da mudança no processo comercial simulado.' },
  { id: 'seed-note-12', kind: 'fact', domains: ['ai-applied'], title: 'Custo de token caiu em cenário fictício', tldr: 'Nos dados de exemplo, custo por 1M de tokens caiu pela metade em 6 meses simulados.', body: 'Cenário fictício de custo de IA: o custo por milhão de tokens do modelo usado no exemplo caiu 50% em 6 meses simulados, o que mudou a conta de viabilidade de features antes descartadas por custo.' },
  { id: 'seed-note-13', kind: 'pattern', domains: ['management'], title: 'Pedido de prazo maior antecede pedido de aumento', tldr: 'Colaborador fictício que pede mais prazo repetidamente costuma pedir revisão salarial na sequência.', body: 'Padrão observado em cenário fictício de gestão: pedidos recorrentes de prazo maior, sem mudança de escopo, precederam pedido de revisão salarial em 3 de 4 casos simulados.' },
  { id: 'seed-note-14', kind: 'pattern', domains: ['product'], title: 'Feature pedida por 1 cliente grande vira dívida', tldr: 'Feature sob medida pra 1 conta específica tende a virar manutenção cara sem uso geral.', body: 'Padrão fictício: toda vez que uma feature nasceu pra atender só 1 conta grande, ela virou item de manutenção recorrente sem adoção pelo resto da base simulada.' },
  { id: 'seed-note-15', kind: 'pattern', domains: ['personal-development'], title: 'Procrastinação em tarefa vaga', tldr: 'Tarefa sem critério de pronto claro é a que mais fica parada na lista.', body: 'Padrão de exemplo: tarefas com título vago ("melhorar processo X") ficaram em média 3x mais tempo abertas que tarefas com critério de pronto explícito, no board fictício analisado.' },
  { id: 'seed-note-16', kind: 'principle', domains: ['operations'], title: 'Documentar decisão com alternativa descartada', tldr: 'Registrar por que a alternativa PERDEU evita reabrir o mesmo debate depois.', body: 'Princípio: toda decisão registrada deve trazer a alternativa descartada e o motivo. Sem isso, o mesmo debate reabre meses depois com quem não estava na sala.' },
  { id: 'seed-note-17', kind: 'principle', domains: ['leadership'], title: 'Feedback de erro no mesmo dia', tldr: 'Correção de rota dada no mesmo dia do erro custa menos que corrigir na avaliação trimestral.', body: 'Princípio: feedback corretivo perde força exponencialmente com o tempo. Dar no mesmo dia custa uma conversa curta; guardar pra avaliação trimestral vira lista de mágoas.' },
  { id: 'seed-note-18', kind: 'principle', domains: ['ai-applied'], title: 'Verificar fonte antes de afirmar', tldr: 'Toda afirmação de fato sensível exige checagem na fonte antes de virar resposta final.', body: 'Princípio: nome, valor, data ou desfecho só entra em resposta depois de checado na fonte na mesma interação. Na dúvida, marca como hipótese ou pergunta — nunca afirma.' },
  { id: 'seed-note-19', kind: 'question', domains: ['entrepreneurship'], title: 'Vale abrir categoria de produto nova em cenário apertado (fictício)', tldr: 'Em aberto: lançar linha de produto nova agora ou esperar caixa respirar mais dois trimestres.', body: 'Pergunta em aberto do cenário fictício: o caixa simulado aguenta lançar uma linha nova agora, ou o risco de dispersão de foco supera o ganho de diversificação nesse momento?' },
  { id: 'seed-note-20', kind: 'question', domains: ['music', 'education'], title: 'Curso gravado ou ao vivo pra iniciante (fictício)', tldr: 'Em aberto: aula de música pra iniciante performa melhor gravada ou em turma ao vivo.', body: 'Pergunta em aberto de exemplo: o formato gravado permite repetir o trecho difícil, mas a turma ao vivo cria compromisso social que sustenta a prática. Qual pesa mais pro iniciante?' },
];

const EDGES = [
  { id: 'seed-edge-01', from: 'seed-note-01', to: 'seed-note-03', type: 'same_mechanism_as', why: 'Ambos reduzem o custo de achar a informação certa na hora certa, um no grafo, outro na leitura.' },
  { id: 'seed-edge-02', from: 'seed-note-02', to: 'seed-note-15', type: 'analogous_to', why: 'Escala pronta e critério de pronto claro cumprem o mesmo papel: reduzir a decisão em cima da hora.' },
  { id: 'seed-edge-03', from: 'seed-note-04', to: 'seed-note-14', type: 'causes', why: 'O Kanban customizável nasceu justamente pra não empilhar coluna sob medida pra 1 time só.' },
  { id: 'seed-edge-04', from: 'seed-note-05', to: 'seed-note-11', type: 'evidence_for', why: 'O ciclo médio de 21 dias só ficou curto depois que o diagnóstico pago passou a filtrar antes.' },
  { id: 'seed-edge-05', from: 'seed-note-06', to: 'seed-note-09', type: 'depends_on', why: 'Squad dedicado de onboarding só se sustenta se o caixa fictício aguentar o custo fixo do time.' },
  { id: 'seed-edge-06', from: 'seed-note-07', to: 'seed-note-10', type: 'evidence_for', why: 'O recorde de presença da turma fictícia virou o case usado na prova social do funil de exemplo.' },
  { id: 'seed-edge-07', from: 'seed-note-08', to: 'seed-note-17', type: 'generalizes', why: 'O feedback dado no mesmo dia é a versão prática do princípio pra evitar a queixa acumulada no 1:1.' },
  { id: 'seed-edge-08', from: 'seed-note-13', to: 'seed-note-17', type: 'contradicts', why: 'Esperar o padrão se repetir pra agir contradiz a regra de corrigir no mesmo dia do sinal.' },
  { id: 'seed-edge-09', from: 'seed-note-16', to: 'seed-note-18', type: 'same_mechanism_as', why: 'Guardar a alternativa descartada e checar a fonte são a mesma disciplina: registrar antes de confiar na memória.' },
  { id: 'seed-edge-10', from: 'seed-note-12', to: 'seed-note-19', type: 'refines', why: 'Custo de token caindo muda a conta de viabilidade da pergunta em aberto sobre lançar categoria nova.' },
];

const PROJECTS = [
  { id: 'seed-proj-01', label: 'Lançamento Produto X', color: '#3b82f6' },
  { id: 'seed-proj-02', label: 'Casa Nova', color: '#22c55e' },
];

// 14 tasks: 5 open / 3 in_progress / 4 done / 2 canceled.
const TASKS = [
  { id: 'seed-task-01', title: 'Follow-up com Empresa Exemplo Ltda sobre proposta', tldr: 'Retomar contato fictício antes que a proposta esfrie.', body: 'Ligar pra Ana Almeida (contato fictício) confirmando se a proposta comercial de exemplo já foi discutida internamente.', status: 'open', priority: 1, due: NOW - 2 * DAY, project: 'seed-proj-01', tags: ['cliente', 'urgente'], domains: ['sales'], createdAgo: 5 * DAY },
  { id: 'seed-task-02', title: 'Revisar contrato de fornecedor fictício', tldr: 'Conferir cláusula de reajuste antes de renovar.', body: 'Revisar o contrato fictício de fornecimento, com atenção na cláusula de reajuste anual.', status: 'open', priority: 2, due: NOW, project: null, tags: [], domains: ['operations'], createdAgo: 3 * DAY },
  { id: 'seed-task-03', title: 'Preparar pauta da reunião de equipe', tldr: 'Pauta com 3 itens pra reunião fictícia de segunda.', body: 'Montar pauta objetiva pra reunião fictícia de equipe: status do Produto X, bloqueios e próximos passos.', status: 'open', priority: 3, due: NOW + 1 * DAY, project: 'seed-proj-01', tags: [], domains: ['leadership'], createdAgo: 2 * DAY },
  { id: 'seed-task-04', title: 'Organizar mudança pra Casa Nova', tldr: 'Levantar orçamento de transporte fictício.', body: 'Pedir 3 orçamentos fictícios de transportadora pra mudança e comparar prazo de entrega.', status: 'open', priority: 2, due: NOW + 7 * DAY, project: 'seed-proj-02', tags: ['pessoal'], domains: ['personal-development'], createdAgo: 10 * DAY },
  { id: 'seed-task-05', title: 'Mapear concorrentes do Produto X', tldr: 'Levantamento fictício de 5 concorrentes diretos.', body: 'Listar 5 concorrentes fictícios do Produto X e comparar posicionamento de preço.', status: 'open', priority: 4, due: null, project: 'seed-proj-01', tags: [], domains: ['marketing'], createdAgo: 6 * DAY },
  { id: 'seed-task-06', title: 'Gravar aula piloto do curso novo', tldr: 'Piloto fictício de 20 minutos pra validar formato.', body: 'Gravar aula piloto fictícia de 20 minutos pra testar o formato antes de gravar o curso inteiro.', status: 'in_progress', priority: 1, due: NOW, project: null, tags: [], domains: ['education'], createdAgo: 4 * DAY,
    comment: { author: 'agent', author_name: 'Claude', body: 'Gravação piloto concluída, faltando revisar o áudio dos primeiros 5 minutos.' } },
  { id: 'seed-task-07', title: 'Negociar frete da mudança', tldr: 'Negociação fictícia de frete com 2 transportadoras.', body: 'Negociar valor de frete fictício com as 2 transportadoras que responderam o orçamento.', status: 'in_progress', priority: 3, due: NOW + 2 * DAY, project: 'seed-proj-02', tags: [], domains: ['personal-development'], createdAgo: 8 * DAY },
  { id: 'seed-task-08', title: 'Ajustar precificação do Produto X', tldr: 'Revisão fictícia de tabela de preço por volume.', body: 'Revisar a tabela fictícia de preço por volume do Produto X antes de fechar com Bruno Castro.', status: 'in_progress', priority: 2, due: null, project: 'seed-proj-01', tags: ['financeiro', 'cliente'], domains: ['sales'], createdAgo: 7 * DAY, private: 1,
    comment: { author: 'owner', author_name: 'Eric Luciano', body: 'Baixar no máximo 8% no plano anual antes de fechar, não abrir mais que isso.' } },
  { id: 'seed-task-09', title: 'Publicar release notes fictício v1', tldr: 'Nota de release fictícia da v1 do console.', body: 'Publicar as release notes fictícias da v1 do console pros usuários de teste.', status: 'done', priority: 2, due: NOW - 5 * DAY, completedAt: NOW - 4 * DAY, project: null, tags: [], domains: ['product'], createdAgo: 20 * DAY },
  { id: 'seed-task-10', title: 'Assinar contrato de aluguel da Casa Nova', tldr: 'Assinatura fictícia do contrato de aluguel.', body: 'Assinar o contrato fictício de aluguel da Casa Nova depois da revisão da cláusula de reajuste.', status: 'done', priority: 1, due: NOW - 10 * DAY, completedAt: NOW - 9 * DAY, project: null, tags: ['pessoal'], domains: ['personal-development'], createdAgo: 25 * DAY,
    comment: { author: 'guest', author_name: 'Bruno Castro', body: 'Consegui adiantar a vistoria pra sexta-feira, qualquer horário da tarde funciona pra mim.' } },
  { id: 'seed-task-11', title: 'Fechar diagnóstico com lead fictício Bruno Castro', tldr: 'Diagnóstico fictício fechado, aguardando contrato.', body: 'Diagnóstico comercial fictício concluído com Bruno Castro, aguardando geração do contrato.', status: 'done', priority: 1, due: NOW - 3 * DAY, completedAt: NOW - 2 * DAY, project: null, tags: ['cliente'], domains: ['sales'], createdAgo: 15 * DAY },
  { id: 'seed-task-12', title: 'Atualizar playbook de onboarding', tldr: 'Playbook fictício revisado com o novo fluxo de squad.', body: 'Atualizar o playbook fictício de onboarding com o fluxo novo do squad dedicado.', status: 'done', priority: 3, due: NOW - 15 * DAY, completedAt: NOW - 14 * DAY, project: null, tags: [], domains: ['operations'], createdAgo: 30 * DAY },
  { id: 'seed-task-13', title: 'Contratar fornecedor de mudança', tldr: 'Cancelada: mudança fictícia adiada.', body: 'Contratação fictícia de fornecedor de mudança cancelada porque a data da mudança foi adiada.', status: 'canceled', priority: 3, due: NOW - 4 * DAY, completedAt: NOW - 3 * DAY, project: 'seed-proj-02', tags: [], domains: ['personal-development'], createdAgo: 12 * DAY },
  { id: 'seed-task-14', title: 'Renovar parceria com fornecedor fictício antigo', tldr: 'Cancelada: parceria fictícia descontinuada.', body: 'Renovação fictícia descartada depois que o fornecedor antigo deixou de atender o volume necessário.', status: 'canceled', priority: 4, due: NOW - 8 * DAY, completedAt: NOW - 7 * DAY, project: null, tags: ['fornecedor'], domains: ['operations'], createdAgo: 20 * DAY },
];

const COLUMN_BY_STATUS = {
  open: 'col_aberto',
  in_progress: 'col_progresso',
  done: 'col_concluido',
  canceled: 'col_cancelado',
};

const INBOX_ITEMS = [
  { id: 'seed-inbox-01', body: 'Ideia: oferecer parcela extra pro cliente fictício Empresa Exemplo Ltda fechar ainda esse mês.', source: 'whatsapp', createdAgo: 2 * HOUR },
  { id: 'seed-inbox-02', body: 'Lembrar de confirmar presença na live fictícia de exemplo de quinta.', source: 'telegram', createdAgo: 1 * DAY },
  { id: 'seed-inbox-03', body: 'Rascunho de ideia: newsletter fictícia sobre precificação por volume.', source: 'console', createdAgo: 3 * DAY },
  { id: 'seed-inbox-04', body: 'Reunião fictícia marcada com fornecedor de mudança, confirmar endereço.', source: 'mcp', createdAgo: 6 * DAY, triagedAgo: 5 * DAY, triageAction: 'converted_to_task', resultId: 'seed-task-13' },
  { id: 'seed-inbox-05', body: 'Ideia descartada: campanha fictícia de desconto relâmpago.', source: 'console', createdAgo: 8 * DAY, triagedAgo: 7 * DAY, triageAction: 'discarded', resultId: null },
];

const MENTIONS = [
  { id: 'seed-mention-01', noteId: 'seed-task-01', entityId: 'seed-ent-04', label: 'Empresa Exemplo Ltda' },
  { id: 'seed-mention-02', noteId: 'seed-task-11', entityId: 'seed-ent-02', label: 'Bruno Castro' },
];

function buildBrainSql() {
  const stmts = [];

  stmts.push(insertStmt('task_projects', ['id', 'label', 'color', 'position', 'created_at'],
    PROJECTS.map((p, i) => ({ id: p.id, label: p.label, color: p.color, position: i + 1, created_at: NOW }))));

  stmts.push(insertStmt('notes', ['id', 'title', 'body', 'tldr', 'domains', 'kind', 'created_at', 'updated_at'],
    KNOWLEDGE_NOTES.map((n, i) => {
      const createdAt = NOW - (KNOWLEDGE_NOTES.length - i) * DAY;
      return { id: n.id, title: n.title, body: n.body, tldr: n.tldr, domains: domainsJson(n.domains), kind: n.kind, created_at: createdAt, updated_at: createdAt };
    })));

  stmts.push(insertStmt(
    'notes',
    ['id', 'title', 'body', 'tldr', 'domains', 'kind', 'status', 'due_at', 'priority', 'completed_at', 'column_id', 'project_id', 'private', 'created_at', 'updated_at'],
    TASKS.map((t) => {
      const createdAt = NOW - t.createdAgo;
      const updatedAt = t.completedAt ?? NOW;
      return {
        id: t.id, title: t.title, body: t.body, tldr: t.tldr, domains: domainsJson(t.domains), kind: 'task',
        status: t.status, due_at: t.due, priority: t.priority, completed_at: t.completedAt ?? null,
        column_id: COLUMN_BY_STATUS[t.status], project_id: t.project, private: t.private ?? 0,
        created_at: createdAt, updated_at: updatedAt,
      };
    })
  ));

  const tagRows = [];
  for (const t of TASKS) for (const tag of t.tags ?? []) tagRows.push({ note_id: t.id, tag });
  stmts.push(insertStmt('tags', ['note_id', 'tag'], tagRows));

  stmts.push(insertStmt('edges', ['id', 'from_id', 'to_id', 'relation_type', 'why', 'created_at'],
    EDGES.map((e) => ({ id: e.id, from_id: e.from, to_id: e.to, relation_type: e.type, why: e.why, created_at: NOW }))));

  const commentRows = [];
  for (const t of TASKS) {
    if (!t.comment) continue;
    commentRows.push({
      id: `seed-comment-${t.id.replace('seed-task-', '')}`,
      task_id: t.id, author: t.comment.author, author_name: t.comment.author_name,
      body: t.comment.body, created_at: (t.completedAt ?? NOW) - HOUR,
    });
  }
  stmts.push(insertStmt('task_comments', ['id', 'task_id', 'author', 'author_name', 'body', 'created_at'], commentRows));

  stmts.push(insertStmt('inbox_items', ['id', 'body', 'source', 'created_at', 'triaged_at', 'triage_action', 'result_id'],
    INBOX_ITEMS.map((i) => ({
      id: i.id, body: i.body, source: i.source, created_at: NOW - i.createdAgo,
      triaged_at: i.triagedAgo !== undefined ? NOW - i.triagedAgo : null,
      triage_action: i.triageAction ?? null, result_id: i.resultId ?? null,
    }))));

  stmts.push(insertStmt('mentions', ['id', 'note_id', 'entity_id', 'entity_label', 'created_at'],
    MENTIONS.map((m) => ({ id: m.id, note_id: m.noteId, entity_id: m.entityId, entity_label: m.label, created_at: NOW }))));

  return stmts;
}

// ───────────────────────────── 3. Dados — Contacts ─────────────────────────────

const ENTITIES = [
  { id: 'seed-ent-01', kind: 'person', name: 'Ana Almeida', phone: '5511900010001', email: 'ana.almeida@exemploempresa.com.br', role: 'Gerente de Operações', company: 'Empresa Exemplo Ltda', category: 'cliente', source: 'manual', notes_text: 'Contato fictício de teste, ponto focal operacional da conta Empresa Exemplo Ltda.', birthday: '1988-04-10' },
  { id: 'seed-ent-02', kind: 'person', name: 'Bruno Castro', phone: '5511900010002', email: 'bruno.castro@comercialficticia.com.br', role: 'Diretor Comercial', company: 'Comercial Fictícia SA', category: 'lead', source: 'whatsapp', notes_text: 'Lead fictício em negociação, respondeu bem à demo do Produto X.' },
  { id: 'seed-ent-03', kind: 'person', name: 'Carla Souza', phone: '5511900010003', email: 'carla.souza@exemplo.com.br', role: 'Consultora Independente', company: null, category: 'network', source: 'manual', notes_text: 'Contato fictício de network, indicou 2 leads fictícios no passado.', birthday: '1979-11-02' },
  { id: 'seed-ent-04', kind: 'company', name: 'Empresa Exemplo Ltda', phone: null, email: 'contato@exemploempresa.com.br', role: null, company: null, website: 'https://www.exemploempresa.com.br', sector: 'Tecnologia', category: 'cliente', source: 'manual', notes_text: 'Empresa fictícia cliente ativa desde o teste de onboarding simulado.' },
];

const CONNECTIONS = [
  { id: 'seed-conn-01', a: 'seed-ent-01', b: 'seed-ent-04', type: 'works_at', strength: 0.9, why: 'Ana Almeida é o ponto de contato operacional dentro da Empresa Exemplo Ltda no dia a dia.' },
  { id: 'seed-conn-02', a: 'seed-ent-02', b: 'seed-ent-04', type: 'client_of', strength: 0.4, why: 'Bruno Castro está em negociação fictícia pra virar cliente da Empresa Exemplo Ltda.' },
];

const EVENTS = [
  { id: 'seed-event-01', entity: 'seed-ent-01', kind: 'met', ago: 20 * DAY, context: 'Encontro fictício na feira de tecnologia de exemplo.', source: 'manual' },
  { id: 'seed-event-02', entity: 'seed-ent-01', kind: 'talked', ago: 5 * DAY, context: 'Call fictícia de alinhamento operacional.', source: 'manual' },
  { id: 'seed-event-03', entity: 'seed-ent-02', kind: 'message', ago: 3 * DAY, context: 'Trocou mensagem fictícia perguntando sobre desconto no plano anual.', source: 'whatsapp' },
  { id: 'seed-event-04', entity: 'seed-ent-02', kind: 'meeting', ago: 1 * DAY, context: 'Reunião fictícia de diagnóstico registrada no CRM de teste.', source: 'pipedrive' },
  { id: 'seed-event-05', entity: 'seed-ent-03', kind: 'recommended', ago: 10 * DAY, context: 'Indicou fictíciamente 2 leads pro funil de vendas.', source: 'manual' },
  { id: 'seed-event-06', entity: 'seed-ent-04', kind: 'note', ago: 2 * DAY, context: 'Nota fictícia: renovação de contrato prevista pro próximo trimestre.', source: 'manual' },
  { id: 'seed-event-07', entity: 'seed-ent-01', kind: 'mentioned_in_brain', ago: 1 * DAY, context: 'Mencionada na task fictícia de follow-up do Brain.', source: 'brain_bridge' },
];

function buildContactsSql() {
  const stmts = [];

  stmts.push(insertStmt(
    'entities',
    ['id', 'kind', 'name', 'phone', 'email', 'role', 'company', 'website', 'sector', 'birthday', 'source', 'notes_text', 'category'],
    ENTITIES.map((e) => ({
      id: e.id, kind: e.kind, name: e.name, phone: e.phone ?? null, email: e.email ?? null,
      role: e.role ?? null, company: e.company ?? null, website: e.website ?? null, sector: e.sector ?? null,
      birthday: e.birthday ?? null, source: e.source, notes_text: e.notes_text ?? null, category: e.category,
    }))
  ));

  const channelRows = [];
  for (const e of ENTITIES) {
    if (e.phone) channelRows.push({ id: `seed-chan-${e.id}-phone`, entity_id: e.id, kind: 'phone', value: e.phone, is_primary: 1, position: 0 });
    if (e.email) channelRows.push({ id: `seed-chan-${e.id}-email`, entity_id: e.id, kind: 'email', value: e.email, is_primary: 1, position: 1 });
    if (e.website) channelRows.push({ id: `seed-chan-${e.id}-site`, entity_id: e.id, kind: 'site', value: e.website, is_primary: 1, position: 2 });
  }
  stmts.push(insertStmt('entity_channels', ['id', 'entity_id', 'kind', 'value', 'is_primary', 'position'], channelRows));

  stmts.push(insertStmt('connections', ['id', 'a_id', 'b_id', 'type', 'strength', 'why'],
    CONNECTIONS.map((c) => ({ id: c.id, a_id: c.a, b_id: c.b, type: c.type, strength: c.strength, why: c.why }))));

  stmts.push(insertStmt('events', ['id', 'entity_id', 'kind', 'ts', 'context', 'source'],
    EVENTS.map((e) => ({ id: e.id, entity_id: e.entity, kind: e.kind, ts: sqliteDatetime(NOW - e.ago), context: e.context, source: e.source }))));

  return stmts;
}

// ─────────────────────────────────── main ───────────────────────────────────

function main() {
  ensureContactsSchemaCurrent();

  if (RESET) {
    resetBrain();
    resetContacts();
  }

  const existingBrainSeed = countSeed(BRAIN_DIR, 'notes') + countSeed(BRAIN_DIR, 'task_projects') + countSeed(BRAIN_DIR, 'inbox_items');
  const existingContactsSeed = countSeed(CONTACTS_DIR, 'entities');
  if ((existingBrainSeed > 0 || existingContactsSeed > 0) && !FORCE) {
    console.error(`\nABORT: já existem rows seed-% (brain=${existingBrainSeed}, contacts=${existingContactsSeed}).`);
    console.error('Rode de novo com --reset (limpa antes) ou --force (semeia por cima).');
    process.exit(1);
  }

  runD1File(BRAIN_DIR, writeSqlFile('brain-seed', buildBrainSql()), 'brain:seed');
  runD1File(CONTACTS_DIR, writeSqlFile('contacts-seed', buildContactsSql()), 'contacts:seed');

  // ─────────────────────────── resumo final ───────────────────────────
  console.log('\n=== RESUMO — expert-brain (D1 local) ===');
  for (const [table, col] of [
    ['notes', 'id'], ['edges', 'id'], ['tags', 'note_id'], ['task_projects', 'id'],
    ['task_comments', 'id'], ['inbox_items', 'id'], ['mentions', 'id'],
  ]) {
    console.log(`  ${table.padEnd(15)} seed-% = ${countSeed(BRAIN_DIR, table, col)}`);
  }
  const taskCount = queryD1(BRAIN_DIR, "SELECT count(*) c FROM notes WHERE kind='task' AND id LIKE 'seed-%'")[0]?.c ?? 0;
  console.log(`  (dos quais tasks)   = ${taskCount}`);

  console.log('\n=== RESUMO — expert-contacts (D1 local) ===');
  for (const [table, col] of [
    ['entities', 'id'], ['entity_channels', 'entity_id'], ['connections', 'id'], ['events', 'entity_id'],
  ]) {
    console.log(`  ${table.padEnd(15)} seed-% = ${countSeed(CONTACTS_DIR, table, col)}`);
  }

  console.log('\n=== Coerência do board (status x kanban_columns) ===');
  const board = queryD1(
    BRAIN_DIR,
    "SELECT n.status, n.column_id, k.category, count(*) c FROM notes n LEFT JOIN kanban_columns k ON k.id = n.column_id WHERE n.id LIKE 'seed-%' AND n.kind='task' GROUP BY n.status, n.column_id, k.category ORDER BY n.status"
  );
  for (const row of board) {
    const ok = row.status === row.category ? 'OK' : 'DIVERGENTE';
    console.log(`  status=${row.status} -> column_id=${row.column_id} (category=${row.category}) x${row.c} [${ok}]`);
  }

  console.log('\nSeed concluído.');
}

main();
