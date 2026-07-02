import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerDeleteNote } from '../../src/mcp/tools/delete-note.js';

const E = env as any;

function fakeVectorize() {
  return {
    upsert: vi.fn(async () => ({})),
    query: vi.fn(),
    deleteByIds: vi.fn(async () => ({ mutationId: 'x' })),
  };
}

async function resetDb(): Promise<void> {
  await E.DB.prepare('DELETE FROM edges').run();
  await E.DB.prepare('DELETE FROM tags').run();
  await E.DB.prepare('DELETE FROM notes').run();
}

async function seed(id: string): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, 'T', 'b', 'a tldr long enough here', '["biology"]', 'concept', 1000, 1000).run();
}

function reg() {
  const r: any = {};
  registerDeleteNote({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
  return r;
}

describe('delete_note', () => {
  beforeEach(async () => {
    E.VECTORIZE = fakeVectorize();
    await runMigrations(E);
    await resetDb();
  });

  it('soft-deletes the note (recoverable), hides edges+tags, removes vector', async () => {
    await seed('a');
    await seed('b');
    await E.DB.prepare(
      `INSERT INTO edges (id,from_id,to_id,relation_type,why,created_at) VALUES (?,?,?,?,?,?)`
    ).bind('e1', 'a', 'b', 'analogous_to', 'a long enough why for validation here', 1000).run();
    await E.DB.prepare(`INSERT INTO tags (note_id, tag) VALUES (?, ?)`).bind('a', 'tag1').run();

    const r = await reg().delete_note({ id: 'a', confirm: true });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.deleted).toBe(true);
    expect(parsed.recoverable).toBe(true);
    expect(parsed.edges_hidden).toBe(1);
    expect(parsed.tags_hidden).toBe(1);

    expect(E.VECTORIZE.deleteByIds).toHaveBeenCalledWith(['a']);

    // Soft-delete: some das leituras normais (deleted_at IS NULL)...
    const visible = await E.DB.prepare('SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL').bind('a').first();
    expect(visible).toBeNull();
    // ...mas a linha sobrevive no D1 com deleted_at preenchido (recuperável).
    const raw = await E.DB.prepare('SELECT deleted_at FROM notes WHERE id = ?').bind('a').first();
    expect(raw).not.toBeNull();
    expect(raw.deleted_at).toBeTruthy();
    // Edges e tags NÃO são apagadas — ficam escondidas e voltam no restore.
    const edges = await E.DB.prepare('SELECT count(*) c FROM edges').first();
    expect(edges.c).toBe(1);
    const tags = await E.DB.prepare('SELECT count(*) c FROM tags').first();
    expect(tags.c).toBe(1);

    const survivor = await E.DB.prepare('SELECT id FROM notes WHERE id = ?').bind('b').first();
    expect(survivor).not.toBeNull();
  });

  it('rejects unknown id', async () => {
    const r = await reg().delete_note({ id: 'ghost', confirm: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ghost');
    expect(E.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
  });

  it('rejects a task id and does NOT soft-delete it', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at,status,due_at,priority,completed_at)
       VALUES ('tk','Task','','tl','["operations"]','task',0,0,null,'open',null,null,null)`
    ).run();
    const r = await reg().delete_note({ id: 'tk', confirm: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('update_task');
    expect(r.content[0].text).toContain('complete_task');
    expect(E.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    const row = await E.DB.prepare('SELECT deleted_at FROM notes WHERE id = ?').bind('tk').first();
    expect(row.deleted_at).toBeNull();
  });

  it('preserves D1 and returns specific error when Vectorize.deleteByIds fails', async () => {
    await seed('a');
    E.VECTORIZE.deleteByIds = vi.fn(async () => {
      throw new Error('Vectorize transient');
    });

    const r = await reg().delete_note({ id: 'a', confirm: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('NOT deleted');
    expect(r.content[0].text).toContain('Safe to retry');

    const row = await E.DB.prepare('SELECT id FROM notes WHERE id = ?').bind('a').first();
    expect(row).not.toBeNull();
  });
});
