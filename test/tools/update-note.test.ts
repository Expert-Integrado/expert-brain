import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerUpdateNote } from '../../src/mcp/tools/update-note.js';

const E = env as any;
const AUTH = { email: 'test@example.com', loggedInAt: 0 };

function fakeAI() {
  return { run: vi.fn(async () => ({ data: [Array(1024).fill(0.3)] })) };
}
function fakeVectorize() {
  return { upsert: vi.fn(async () => ({})), query: vi.fn() };
}

async function resetDb(): Promise<void> {
  await E.DB.prepare('DELETE FROM edges').run();
  await E.DB.prepare('DELETE FROM tags').run();
  await E.DB.prepare('DELETE FROM notes').run();
}

async function seed(id: string, tldr: string, domains: string, kind: string): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, 'Original Title', 'original body', tldr, domains, kind, 1000, 1000).run();
}

function reg() {
  const r: any = {};
  registerUpdateNote({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, AUTH);
  return r;
}

describe('update_note', () => {
  beforeEach(async () => {
    E.AI = fakeAI();
    E.VECTORIZE = fakeVectorize();
    await runMigrations(E);
    await resetDb();
  });

  it('updates title without reembedding', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc', title: 'New Title' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.fields_changed).toEqual(['title']);
    expect(parsed.reembedded).toBe(false);
    expect(E.AI.run).not.toHaveBeenCalled();
    const row = await E.DB.prepare('SELECT title FROM notes WHERE id = ?').bind('abc').first();
    expect(row.title).toBe('New Title');
  });

  it('reembeds when tldr changes', async () => {
    await seed('abc', 'old tldr long enough', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc', tldr: 'a brand new tldr long enough here ok' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.fields_changed).toContain('tldr');
    expect(parsed.reembedded).toBe(true);
    expect(E.AI.run).toHaveBeenCalledTimes(1);
    expect(E.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it('reembeds when domains change (metadata must follow)', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc', domains: ['product'] });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.fields_changed).toContain('domains');
    expect(parsed.reembedded).toBe(true);
  });

  it('reembeds when kind changes', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc', kind: 'principle' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.fields_changed).toContain('kind');
    expect(parsed.reembedded).toBe(true);
  });

  it('replaces tags without reembedding', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    await E.DB.prepare(`INSERT INTO tags (note_id, tag) VALUES (?, ?)`).bind('abc', 'old').run();
    const r = await reg().update_note({ id: 'abc', tags: ['new1', 'new2'] });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.fields_changed).toContain('tags');
    expect(parsed.reembedded).toBe(false);
    const tags = await E.DB.prepare(`SELECT tag FROM tags WHERE note_id = ? ORDER BY tag`).bind('abc').all();
    expect(tags.results.map((t: any) => t.tag)).toEqual(['new1', 'new2']);
  });

  it('rejects when only id is provided', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('at least one field');
  });

  it('rejects unknown id', async () => {
    const r = await reg().update_note({ id: 'ghost', title: 'X' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ghost');
  });

  it('rejects invalid domain slug', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const r = await reg().update_note({ id: 'abc', domains: ['Biologia Evolutiva'] });
    expect(r.isError).toBe(true);
  });

  it('handles legacy note with kind=null when reembedding (no NoteKind crash)', async () => {
    // Direct insert with kind=null simulates a legacy row from before kind became required.
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
    ).bind('legacy', 'T', 'b', 'an old tldr long enough', '["biology"]', null, 1000, 1000).run();

    const r = await reg().update_note({ id: 'legacy', tldr: 'a freshly rewritten tldr that qualifies' });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.reembedded).toBe(true);

    expect(E.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = (E.VECTORIZE.upsert.mock.calls[0] as any[])[0][0];
    expect(upsertArg.metadata.kind).toBe(''); // upsertNoteVector coerces null -> ''
  });

  it('bumps updated_at when only tags change', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    const before = await E.DB.prepare('SELECT updated_at FROM notes WHERE id = ?').bind('abc').first();
    expect(before.updated_at).toBe(1000);

    const r = await reg().update_note({ id: 'abc', tags: ['fresh'] });
    expect(r.isError).toBeUndefined();
    const after = await E.DB.prepare('SELECT updated_at FROM notes WHERE id = ?').bind('abc').first();
    expect(after.updated_at).toBeGreaterThan(1000);
  });

  it('tags=[] clears existing tags', async () => {
    await seed('abc', 'a tldr long enough here', '["biology"]', 'concept');
    await E.DB.prepare(`INSERT INTO tags (note_id, tag) VALUES (?, ?)`).bind('abc', 'old').run();
    const r = await reg().update_note({ id: 'abc', tags: [] });
    expect(r.isError).toBeUndefined();
    const remaining = await E.DB.prepare('SELECT count(*) c FROM tags WHERE note_id = ?').bind('abc').first();
    expect(remaining.c).toBe(0);
  });
});

// spec 10-backend/23: update_note grava o D1 ANTES de embedar — quando o embed
// estoura, a edição JÁ persistiu e a mensagem de erro não pode dizer o contrário.
describe('update_note with embed failure (spec 23)', () => {
  beforeEach(async () => {
    E.AI = { run: vi.fn(async () => { throw new Error('AiError: Workers AI capacity exceeded'); }) };
    E.VECTORIZE = { upsert: vi.fn(async () => ({})), query: vi.fn() };
    await runMigrations(E);
    await E.DB.prepare('DELETE FROM edges').run();
    await E.DB.prepare('DELETE FROM tags').run();
    await E.DB.prepare('DELETE FROM notes').run();
  });

  it('D1 keeps the new tldr and the error message never claims nothing persisted', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
    ).bind('abc', 'Original Title', 'original body', 'the old tldr text here', '["biology"]', 'concept', 1000, 1000).run();

    const r = await reg().update_note({ id: 'abc', tldr: 'a freshly rewritten tldr that qualifies' });
    expect(r.isError).toBe(true);
    const text = r.content[0].text as string;
    // orienta verificar e reembedar, sem afirmar que nada foi salvo
    expect(text).toContain('get_note');
    expect(text).toContain('reembed');
    expect(text).not.toContain('was NOT saved');
    expect(text).not.toContain('there are no partial writes');
    // e o D1 de fato ficou com o tldr novo (partial write é o comportamento normal)
    const row = await E.DB.prepare('SELECT tldr FROM notes WHERE id = ?').bind('abc').first();
    expect(row.tldr).toBe('a freshly rewritten tldr that qualifies');
  });
});
