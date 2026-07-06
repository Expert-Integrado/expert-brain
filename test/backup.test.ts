import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations } from '../src/db/migrate.js';
import {
  buildSnapshot,
  runSnapshot,
  listDataTables,
  BACKUP_PREFIX,
  LAST_BACKUP_META_KEY,
} from '../src/backup/snapshot.js';
import { buildZip } from '../src/backup/zip.js';
import { unzip } from './util/mini-unzip.js';
// MESMA implementação de restore usada pelo CLI scripts/restore-from-snapshot.mjs —
// o round-trip aqui valida em CI a lógica que o runbook usa (docs/restore.md).
import { jsonlToInsertStatements, sortTablesForRestore } from '../scripts/lib/jsonl-to-sql.mjs';

const E = env as any;
const NOW = Date.parse('2026-07-06T05:00:00Z'); // segunda 05:00 UTC = 02:00 BRT

// Corpo com aspas simples, quebra de linha e acento — prova que o escaping do
// dump (JSONL) e do restore (SQL) preserva o conteúdo byte a byte.
const TRICKY_BODY = "linha 1 com 'aspas'\nlinha 2: função, ação; -- não é comentário";

async function wipeData(): Promise<void> {
  // filho → pai por causa das FKs (o CASCADE de notes também limparia, mas a
  // ordem explícita documenta a dependência). kanban_columns e task_projects vêm
  // DEPOIS de notes (notes.column_id → kanban_columns spec 51; notes.project_id →
  // task_projects spec 58).
  for (const t of ['note_media', 'similar_edges', 'edges', 'tags', 'notes', 'api_keys', 'meta', 'kanban_columns', 'task_projects']) {
    await E.DB.exec(`DELETE FROM ${t}`);
  }
}

async function wipeBucket(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await E.MEDIA.list({ prefix: BACKUP_PREFIX, cursor });
    if (page.objects.length) await E.MEDIA.delete(page.objects.map((o: { key: string }) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function seedFixture(): Promise<void> {
  const run = (sql: string, ...binds: unknown[]) => E.DB.prepare(sql).bind(...binds).run();
  await run(
    `INSERT INTO notes (id, title, body, tldr, domains, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    'bkp-n1', 'Nota um', TRICKY_BODY, 'tldr um', '["sales"]', 'insight', 1000, 1000
  );
  await run(
    `INSERT INTO notes (id, title, body, tldr, domains, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    'bkp-n2', 'Nota dois', 'corpo dois', 'tldr dois', '["ai-applied"]', 'concept', 2000, 2000
  );
  await run(
    `INSERT INTO notes (id, title, body, tldr, domains, kind, created_at, updated_at, status, due_at, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'bkp-t1', 'Task um', 'corpo task', 'tldr task', '["operations"]', 'task', 3000, 3000, 'open', NOW + 86400_000, 2
  );
  await run(`INSERT INTO tags (note_id, tag) VALUES ('bkp-n1', 'ia'), ('bkp-n1', 'vendas')`);
  await run(
    `INSERT INTO edges (id, from_id, to_id, relation_type, why, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    'bkp-e1', 'bkp-n1', 'bkp-n2', 'analogous_to', 'mesmo mecanismo de reforço em loop nos dois domínios', 4000
  );
  await run(`INSERT INTO similar_edges (from_id, to_id, score) VALUES ('bkp-n1', 'bkp-n2', 0.87)`);
  await run(
    `INSERT INTO note_media (id, note_id, kind, r2_key, content_hash, mime_type, size_bytes, original_filename, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'bkp-m1', 'bkp-n1', 'image', 'sha256/feedface.jpg', 'feedface', 'image/jpeg', 123, 'foto.jpg', 5000
  );
  await run(
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    'bkp-k1', 'owner@example.com', 'chave-teste', 'eb_pat_abc', 'hash-fixo-de-teste', 6000
  );
  await run(`INSERT INTO meta (key, value) VALUES ('personalization_prompt', 'oi, sou o dono da instância')`);
  // Colunas do Kanban (spec 51): wipeData limpou; re-semeia os 4 seeds canônicos
  // pra a suíte ser hermética (storage é compartilhado entre arquivos no singleWorker).
  await run(`INSERT INTO kanban_columns (id, label, color, position, category, archived_at) VALUES ('col_aberto', 'A fazer', NULL, 1, 'open', NULL)`);
  await run(`INSERT INTO kanban_columns (id, label, color, position, category, archived_at) VALUES ('col_progresso', 'Em progresso', NULL, 2, 'in_progress', NULL)`);
  await run(`INSERT INTO kanban_columns (id, label, color, position, category, archived_at) VALUES ('col_concluido', 'Concluído', NULL, 3, 'done', NULL)`);
  await run(`INSERT INTO kanban_columns (id, label, color, position, category, archived_at) VALUES ('col_cancelado', 'Cancelado', NULL, 4, 'canceled', 1)`);
}

const FIXTURE_COUNTS: Record<string, number> = {
  notes: 3,
  tags: 2,
  edges: 1,
  similar_edges: 1,
  note_media: 1,
  api_keys: 1,
  meta: 1,
  kanban_columns: 4,
  task_projects: 0,
  inbox_items: 0,
  mentions: 0,
  _migrations: 15,
};

beforeAll(async () => {
  await runMigrations(E);
});

beforeEach(async () => {
  await wipeData();
  await seedFixture();
  await wipeBucket();
});

describe('snapshot — dump e manifest (spec 67)', () => {
  it('lista só tabelas de dados: sem FTS/shadow, com _migrations e meta', async () => {
    const names = await listDataTables(E);
    for (const t of Object.keys(FIXTURE_COUNTS)) expect(names).toContain(t);
    expect(names.some((n) => /_fts(_|$)/.test(n))).toBe(false);
    expect(names).not.toContain('notes_fts');
  });

  it('gera 1 JSONL por tabela com contagens batendo no manifest', async () => {
    const { tables, manifest } = await buildSnapshot(E, NOW);
    for (const [t, c] of Object.entries(FIXTURE_COUNTS)) {
      expect(manifest.tables[t], `contagem de ${t}`).toBe(c);
      const dump = tables.find((d) => d.name === t)!;
      expect(dump, `dump de ${t}`).toBeTruthy();
      const lines = dump.jsonl.split('\n').filter((l) => l.trim() !== '');
      expect(lines.length, `linhas de ${t}.jsonl`).toBe(c);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    }
    // Versão do schema = último id de _migrations; mídia só REFERENCIADA (keys).
    expect(manifest.schema_version).toBe('0015_mentions');
    expect(manifest.media_r2_keys).toEqual(['sha256/feedface.jpg']);
    expect(manifest.created_at).toBe(NOW);
  });

  it('round-trip: restore num banco limpo bate as contagens do manifest', async () => {
    const { tables, manifest } = await buildSnapshot(E, NOW);
    await wipeData();

    // _migrations fica de fora do import (no runbook, o provision já a populou).
    const order = sortTablesForRestore(tables.map((t) => t.name).filter((n) => n !== '_migrations'));
    for (const name of order) {
      const dump = tables.find((d) => d.name === name)!;
      for (const stmt of jsonlToInsertStatements(name, dump.jsonl)) {
        await E.DB.prepare(stmt).run();
      }
    }

    for (const [t, c] of Object.entries(manifest.tables)) {
      const row = await E.DB.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).first();
      expect(row.n, `contagem restaurada de ${t}`).toBe(c);
    }
    // Conteúdo com aspas/quebra de linha/acento sobrevive byte a byte.
    const n1 = await E.DB.prepare(`SELECT body FROM notes WHERE id = 'bkp-n1'`).first();
    expect(n1.body).toBe(TRICKY_BODY);
    // O FTS foi regenerado pelos triggers no re-INSERT (não é dumpado).
    const fts = await E.DB.prepare(`SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'aspas'`).first();
    expect(fts.n).toBe(1);
  });
});

describe('runSnapshot — R2, meta e retenção (spec 67)', () => {
  it('grava JSONL + manifest no prefixo backups/<data>/ e registra last_backup ok', async () => {
    const r = await runSnapshot(E, NOW);
    expect(r.ok).toBe(true);
    expect(r.prefix).toBe('backups/2026-07-06/');
    expect(r.total_rows).toBe(Object.values(FIXTURE_COUNTS).reduce((a, b) => a + b, 0));

    const manifestObj = await E.MEDIA.get('backups/2026-07-06/manifest.json');
    expect(manifestObj).not.toBeNull();
    const manifest = JSON.parse(await manifestObj.text());
    expect(manifest.tables.notes).toBe(3);
    const notesObj = await E.MEDIA.get('backups/2026-07-06/notes.jsonl');
    expect(notesObj).not.toBeNull();

    const metaRow = await E.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(LAST_BACKUP_META_KEY).first();
    const saved = JSON.parse(metaRow.value);
    expect(saved.ok).toBe(true);
    expect(saved.date).toBe('2026-07-06');
  });

  it('retenção: com 8 snapshots, o novo (9º) apaga SÓ o mais antigo', async () => {
    for (let d = 1; d <= 8; d++) {
      const date = `2026-06-0${d}`;
      await E.MEDIA.put(`backups/${date}/manifest.json`, '{}');
      await E.MEDIA.put(`backups/${date}/notes.jsonl`, '');
    }
    const r = await runSnapshot(E, NOW);
    expect(r.ok).toBe(true);
    expect(r.deleted_prefixes).toEqual(['backups/2026-06-01/']);

    const page = await E.MEDIA.list({ prefix: BACKUP_PREFIX, delimiter: '/' });
    expect(page.delimitedPrefixes).toHaveLength(8);
    expect(page.delimitedPrefixes).not.toContain('backups/2026-06-01/');
    expect(page.delimitedPrefixes).toContain('backups/2026-06-02/');
    expect(page.delimitedPrefixes).toContain('backups/2026-07-06/');
    expect(await E.MEDIA.get('backups/2026-06-01/manifest.json')).toBeNull();
    expect(await E.MEDIA.get('backups/2026-06-01/notes.jsonl')).toBeNull();
  });

  it('snapshot FALHO não apaga nenhum snapshot existente', async () => {
    for (let d = 1; d <= 8; d++) {
      await E.MEDIA.put(`backups/2026-06-0${d}/manifest.json`, '{}');
    }
    const brokenEnv = {
      ...E,
      MEDIA: {
        put: async () => {
          throw new Error('r2 fora do ar (teste)');
        },
      },
    };
    const r = await runSnapshot(brokenEnv, NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('r2 fora do ar');
    expect(r.deleted_prefixes).toEqual([]);

    // Os 8 antigos seguem intactos (inclusive o mais antigo).
    const page = await E.MEDIA.list({ prefix: BACKUP_PREFIX, delimiter: '/' });
    expect(page.delimitedPrefixes).toHaveLength(8);
    expect(page.delimitedPrefixes).toContain('backups/2026-06-01/');

    // A falha fica registrada pra UI de /app/config.
    const metaRow = await E.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(LAST_BACKUP_META_KEY).first();
    expect(JSON.parse(metaRow.value).ok).toBe(false);
  });

  it('sem binding MEDIA: falha limpa com erro explicativo, sem lançar', async () => {
    const r = await runSnapshot({ ...E, MEDIA: undefined }, NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/MEDIA/);
  });
});

describe('zip — escritor próprio validado por leitor independente', () => {
  it('round-trip com texto compressível, binário incompressível e arquivo vazio', async () => {
    const enc = new TextEncoder();
    const random = new Uint8Array(256);
    crypto.getRandomValues(random);
    const entries = [
      { name: 'texto.jsonl', data: enc.encode('{"a":1}\n'.repeat(500)) }, // deflate
      { name: 'aleatorio.bin', data: random }, // provável STORE (incompressível)
      { name: 'vazio.txt', data: new Uint8Array(0) },
    ];
    const zip = await buildZip(entries, new Date(NOW));
    const files = await unzip(zip); // valida CRC + tamanhos por dentro
    expect([...files.keys()].sort()).toEqual(['aleatorio.bin', 'texto.jsonl', 'vazio.txt']);
    expect(files.get('texto.jsonl')).toEqual(entries[0].data);
    expect(files.get('aleatorio.bin')).toEqual(random);
    expect(files.get('vazio.txt')).toHaveLength(0);
  });
});
