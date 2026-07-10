import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrations, MIGRATIONS } from '../src/db/migrate.js';

const E = env as any;

// Derruba TODO o schema pra simular um D1 limpo (a suíte roda com
// isolatedStorage: false, então o banco é compartilhado entre arquivos).
// Loop com retry resolve a ordem de dependência das FKs sem hardcodar nomes.
async function nukeDb(): Promise<void> {
  const trg = await E.DB.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all();
  for (const t of trg.results ?? []) {
    await E.DB.prepare(`DROP TRIGGER IF EXISTS "${t.name}"`).run();
  }
  for (let round = 0; round < 10; round++) {
    const tabs = await E.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
       AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf%' ESCAPE '\\'`
    ).all();
    const names = (tabs.results ?? [])
      .map((r: { name: string }) => r.name)
      // Shadow tables do FTS5 caem junto com o DROP da virtual table notes_fts.
      .filter((n: string) => !/^notes_fts_/.test(n));
    if (names.length === 0) return;
    for (const n of names) {
      try {
        await E.DB.prepare(`DROP TABLE IF EXISTS "${n}"`).run();
      } catch {
        // FK ainda referenciada — a próxima rodada pega.
      }
    }
  }
  throw new Error('nukeDb não convergiu em 10 rodadas');
}

// Aplica migrations manualmente (SEM batch, como o executor antigo) até a
// migration `uptoExclusive`, registrando em _migrations — reproduz o estado de
// uma instalação antiga parada num ponto do histórico.
async function applyBefore(uptoExclusive: string): Promise<void> {
  await E.DB.prepare(
    `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
  ).run();
  for (const m of MIGRATIONS) {
    if (m.id === uptoExclusive) return;
    for (const stmt of m.stmts) await E.DB.prepare(stmt).run();
    await E.DB.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`)
      .bind(m.id, Date.now())
      .run();
  }
}

async function appliedIds(): Promise<string[]> {
  const r = await E.DB.prepare(`SELECT id FROM _migrations ORDER BY id`).all();
  return (r.results ?? []).map((x: { id: string }) => x.id);
}

async function notesColumns(): Promise<Set<string>> {
  const info = await E.DB.prepare(`PRAGMA table_info(notes)`).all();
  return new Set((info.results ?? []).map((r: { name: string }) => r.name));
}

describe('runMigrations — transacional e idempotente (spec 10-backend/13)', () => {
  beforeEach(async () => {
    await nukeDb();
  });

  it('D1 limpo: roda 2x sem erro e registra todas as migrations', async () => {
    await runMigrations(E);
    await runMigrations(E);
    const ids = await appliedIds();
    expect(ids.length).toBe(MIGRATIONS.length);
    expect(ids).toContain('0001_init');
    expect(ids).toContain(MIGRATIONS[MIGRATIONS.length - 1].id);
    // Sanidade: schema funcional (FTS + trigger criados via batch).
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
       VALUES ('mg1','T','b','um tldr suficiente','["operations"]','concept',0,0)`
    ).run();
    const hit = await E.DB.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'tldr'`).first();
    expect(hit).not.toBeNull();
  });

  it('falha parcial na 0006 (status/due_at já existem, sem registro): re-run completa e registra', async () => {
    await applyBefore('0006_task_fields');
    // Executor antigo morreu no meio da 0006: 2 das 4 colunas aplicadas.
    await E.DB.prepare(
      `ALTER TABLE notes ADD COLUMN status TEXT CHECK (status IS NULL OR status IN ('open','in_progress','done','canceled'))`
    ).run();
    await E.DB.prepare(`ALTER TABLE notes ADD COLUMN due_at INTEGER`).run();

    await runMigrations(E);

    const cols = await notesColumns();
    for (const c of ['status', 'due_at', 'priority', 'completed_at']) expect(cols.has(c)).toBe(true);
    const idx = await E.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_notes_task_open','idx_notes_task_due')`
    ).all();
    expect((idx.results ?? []).length).toBe(2);
    const ids = await appliedIds();
    expect(ids).toContain('0006_task_fields');
    expect(ids.length).toBe(MIGRATIONS.length);
  });

  it('falha parcial na 0004 (deleted_at já existe, sem registro): re-run completa e registra', async () => {
    await applyBefore('0004_soft_delete');
    await E.DB.prepare(`ALTER TABLE notes ADD COLUMN deleted_at INTEGER`).run();

    await runMigrations(E);

    const cols = await notesColumns();
    expect(cols.has('deleted_at')).toBe(true);
    const ids = await appliedIds();
    expect(ids).toContain('0004_soft_delete');
    expect(ids.length).toBe(MIGRATIONS.length);
  });

  it('0018: provision novo cria idx_similar_edges_score (spec 70-grafo-higiene/76)', async () => {
    await runMigrations(E);
    const idx = await E.DB.prepare(
      `SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name = 'idx_similar_edges_score'`
    ).first();
    expect(idx).not.toBeNull();
    expect((idx as any).tbl_name).toBe('similar_edges');
    const ids = await appliedIds();
    expect(ids).toContain('0018_similar_edges_score_idx');
  });
});
