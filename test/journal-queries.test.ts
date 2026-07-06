import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  listNoteCreatedActivity,
  listNoteUpdatedActivity,
  listTaskCreatedActivity,
  listTaskCompletedActivity,
} from '../src/db/queries.js';

// Fontes locais do journal (specs/50-console-v2/65-home-hoje-e-journal.md §3). Usa
// timestamps no ANO 2999 pra isolar as fixtures desta suíte do resto do banco
// compartilhado entre arquivos de teste (isolatedStorage:false — vitest.config.ts).

const E = env as any;
const NOTE_COLS = `(id,title,body,tldr,domains,kind,created_at,updated_at,private)`;
const TASK_COLS = `(id,title,body,tldr,domains,kind,status,created_at,updated_at,completed_at,private)`;

function futureTs(offsetMin: number): number {
  return Date.UTC(2999, 0, 1, 0, offsetMin, 0);
}

async function insertNoteRow(id: string, createdAt: number, updatedAt: number, priv = 0) {
  await E.DB.prepare(
    `INSERT INTO notes ${NOTE_COLS} VALUES (?,?,?,?,?,'insight',?,?,?)`
  ).bind(id, id, 'b', 't', '["operations"]', createdAt, updatedAt, priv).run();
}

async function insertTaskRow(id: string, createdAt: number, completedAt: number | null, status = 'open', priv = 0) {
  await E.DB.prepare(
    `INSERT INTO notes ${TASK_COLS} VALUES (?,?,?,?,?,'task',?,?,?,?,?)`
  ).bind(id, id, 'b', 't', '["operations"]', status, createdAt, createdAt, completedAt, priv).run();
}

beforeAll(async () => {
  await runMigrations(E);
});

describe('listNoteCreatedActivity (spec 65 §3)', () => {
  it('ordena created_at DESC e pagina por cursor (ts,id) sem duplicar/pular', async () => {
    const ids = ['jqnc1', 'jqnc2', 'jqnc3', 'jqnc4', 'jqnc5'];
    for (let i = 0; i < ids.length; i++) {
      await insertNoteRow(ids[i], futureTs(100 + i), futureTs(100 + i));
    }
    const page1 = await listNoteCreatedActivity(E, { limit: 3, includePrivate: true });
    expect(page1.map((r) => r.id)).toEqual(['jqnc5', 'jqnc4', 'jqnc3']);
    const last = page1[page1.length - 1];
    const page2 = await listNoteCreatedActivity(E, { before: { ts: last.ts, id: last.id }, limit: 3, includePrivate: true });
    const page2Ids = page2.map((r) => r.id).filter((id) => ids.includes(id));
    expect(page2Ids).toEqual(['jqnc2', 'jqnc1']);
  });

  it('includePrivate=false esconde nota privada', async () => {
    await insertNoteRow('jqncpriv', futureTs(200), futureTs(200), 1);
    const withPriv = await listNoteCreatedActivity(E, { limit: 50, includePrivate: true });
    const withoutPriv = await listNoteCreatedActivity(E, { limit: 50, includePrivate: false });
    expect(withPriv.map((r) => r.id)).toContain('jqncpriv');
    expect(withoutPriv.map((r) => r.id)).not.toContain('jqncpriv');
  });
});

describe('listNoteUpdatedActivity — dedupe por dia BRT (spec 65 §3)', () => {
  it('atualização no MESMO dia BRT da criação NÃO gera entrada', async () => {
    const created = futureTs(300);
    const updatedSameDay = created + 5 * 60_000; // 5min depois, mesmo dia
    await insertNoteRow('jqnu-same', created, updatedSameDay);
    const rows = await listNoteUpdatedActivity(E, { limit: 50, includePrivate: true });
    expect(rows.map((r) => r.id)).not.toContain('jqnu-same');
  });

  it('atualização num dia BRT DIFERENTE gera entrada com ts=updated_at', async () => {
    const created = Date.UTC(2999, 5, 1, 12, 0, 0); // 2999-06-01 12:00 UTC
    const updatedNextDay = Date.UTC(2999, 5, 3, 12, 0, 0); // 2 dias depois
    await insertNoteRow('jqnu-diff', created, updatedNextDay);
    const rows = await listNoteUpdatedActivity(E, { limit: 50, includePrivate: true });
    const row = rows.find((r) => r.id === 'jqnu-diff');
    expect(row).toBeTruthy();
    expect(row!.ts).toBe(updatedNextDay);
  });
});

describe('listTaskCreatedActivity / listTaskCompletedActivity (spec 65 §3)', () => {
  it('created: todas as tasks, independente do status', async () => {
    await insertTaskRow('jqtc-open', futureTs(400), null, 'open');
    await insertTaskRow('jqtc-done', futureTs(401), futureTs(401), 'done');
    const rows = await listTaskCreatedActivity(E, { limit: 50, includePrivate: true });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('jqtc-open');
    expect(ids).toContain('jqtc-done');
  });

  it('completed: só tasks com completed_at preenchido, ts=completed_at', async () => {
    await insertTaskRow('jqtcp-open', futureTs(410), null, 'open');
    await insertTaskRow('jqtcp-done', futureTs(411), futureTs(415), 'done');
    const rows = await listTaskCompletedActivity(E, { limit: 50, includePrivate: true });
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain('jqtcp-open');
    const done = rows.find((r) => r.id === 'jqtcp-done');
    expect(done).toBeTruthy();
    expect(done!.ts).toBe(futureTs(415));
  });

  it('includePrivate=false esconde task privada em ambos os streams', async () => {
    await insertTaskRow('jqtpriv', futureTs(420), futureTs(421), 'done', 1);
    const created = await listTaskCreatedActivity(E, { limit: 50, includePrivate: false });
    const completed = await listTaskCompletedActivity(E, { limit: 50, includePrivate: false });
    expect(created.map((r) => r.id)).not.toContain('jqtpriv');
    expect(completed.map((r) => r.id)).not.toContain('jqtpriv');
  });
});
