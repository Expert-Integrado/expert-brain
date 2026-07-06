import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerSaveTask } from '../../src/mcp/tools/save-task.js';

const E = env as any;
const AUTH = { email: 'test@example.com', loggedInAt: 0 };

function reg() {
  const r: any = {};
  registerSaveTask({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, AUTH);
  return r;
}

describe('save_task', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('creates a task with kind=task and default open status + operations domain', async () => {
    const res = await reg().save_task({ title: 'Ligar pro cliente PSP' });
    const p = JSON.parse(res.content[0].text);
    expect(p.status).toBe('open');
    const row = await E.DB.prepare(`SELECT kind, status, domains, due_at, priority FROM notes WHERE id = ?`).bind(p.id).first();
    expect(row.kind).toBe('task');
    expect(row.status).toBe('open');
    expect(JSON.parse(row.domains)).toEqual(['operations']);
    expect(row.due_at).toBeNull();
    expect(row.priority).toBeNull();
  });

  it('parses a BRT due string into unix ms (UTC-3)', async () => {
    const res = await reg().save_task({ title: 'Reunião', due: '2026-06-22T14:00' });
    const p = JSON.parse(res.content[0].text);
    // 14:00 BRT == 17:00 UTC
    expect(new Date(p.due_at).toISOString()).toBe('2026-06-22T17:00:00.000Z');
    expect(p.due_brt).toBe('22/06/2026 14:00');
  });

  it('stores priority and details body', async () => {
    const res = await reg().save_task({ title: 'Pagar fornecedor', details: 'Boleto vence sexta', priority: 1 });
    const p = JSON.parse(res.content[0].text);
    const row = await E.DB.prepare(`SELECT body, priority FROM notes WHERE id = ?`).bind(p.id).first();
    expect(row.priority).toBe(1);
    expect(row.body).toBe('Boleto vence sexta');
  });

  it('persists tags into the tags table (normalized to lowercase)', async () => {
    const res = await reg().save_task({ title: 'Falar com PSP', tags: ['PSP', 'Advogados'] });
    const p = JSON.parse(res.content[0].text);
    const rows = await E.DB.prepare(`SELECT tag FROM tags WHERE note_id = ? ORDER BY tag`).bind(p.id).all();
    // Tags são normalizadas pra lowercase na escrita (spec 15 item 7).
    expect(rows.results.map((r: any) => r.tag)).toEqual(['advogados', 'psp']);
  });

  it('rejects an invalid due string', async () => {
    const res = await reg().save_task({ title: 'X', due: 'amanhã às tantas' });
    expect(res.isError).toBe(true);
  });

  it('rejects due AND due_at passed together', async () => {
    const res = await reg().save_task({ title: 'X', due: '2026-06-22 14:00', due_at: 1_800_000_000_000 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not both');
  });

  it('dedupe_key returns the existing active task instead of duplicating', async () => {
    const a = JSON.parse((await reg().save_task({ title: 'Enviar proposta', dedupe_key: 'card-77' })).content[0].text);
    const b = JSON.parse((await reg().save_task({ title: 'Enviar proposta', dedupe_key: 'card-77' })).content[0].text);
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
    const c = await E.DB.prepare(`SELECT count(*) c FROM notes WHERE kind='task'`).first();
    expect(c.c).toBe(1);
  });

  it('does not write a vector (task stays out of recall)', async () => {
    // A simple proxy: the handler never calls env.VECTORIZE — if it did, the test
    // env would need an AI binding. Creating succeeds without any AI mock.
    const res = await reg().save_task({ title: 'Sem embed' });
    expect(res.isError).toBeUndefined();
  });

  it('creates a task whose title has FTS5-significant punctuation without erroring (regression: prod 500 on save_task)', async () => {
    // Título com ':' '(' ')' '—' — findSimilarActiveTasksByTitle antes montava
    // um `title LIKE '%...%'` cru (sujeito ao teto de comprimento/complexidade
    // de LIKE do D1: "LIKE or GLOB pattern too complex"). Agora usa FTS5 MATCH
    // sanitizado (mesmo helper do ftsSearch), sem esse teto.
    const res = await reg().save_task({ title: 'Foo: bar (baz) — qux!' });
    expect(res.isError).toBeUndefined();
    const p = JSON.parse(res.content[0].text);
    expect(p.title).toBe('Foo: bar (baz) — qux!');
  });

  it('still surfaces possible_duplicates when a punctuated title matches an existing active task', async () => {
    const title = 'PRD: edição inline na UI do Brain — notas, tasks (não implementar)';
    const a = JSON.parse((await reg().save_task({ title })).content[0].text);
    const b = JSON.parse((await reg().save_task({ title })).content[0].text);
    expect(b.isError).toBeUndefined();
    expect(b.possible_duplicates?.some((d: any) => d.id === a.id)).toBe(true);
  });

  it('never fails save_task even if the duplicate-title lookup throws (non-fatal by design)', async () => {
    const queries = await import('../../src/db/queries.js');
    const spy = vi.spyOn(queries, 'findSimilarActiveTasksByTitle').mockRejectedValue(
      new Error('D1_ERROR: simulated failure')
    );
    const res = await reg().save_task({ title: 'Deve salvar mesmo com o lookup quebrado' });
    expect(res.isError).toBeUndefined();
    const p = JSON.parse(res.content[0].text);
    expect(p.id).toBeTruthy();
    expect(p.possible_duplicates).toBeUndefined();
    spy.mockRestore();
  });
});
