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

  it('deletes the note, cascades edges+tags, removes vector', async () => {
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
    expect(parsed.edges_removed).toBe(1);
    expect(parsed.tags_removed).toBe(1);

    expect(E.VECTORIZE.deleteByIds).toHaveBeenCalledWith(['a']);

    const gone = await E.DB.prepare('SELECT id FROM notes WHERE id = ?').bind('a').first();
    expect(gone).toBeNull();
    const edges = await E.DB.prepare('SELECT count(*) c FROM edges').first();
    expect(edges.c).toBe(0);
    const tags = await E.DB.prepare('SELECT count(*) c FROM tags').first();
    expect(tags.c).toBe(0);

    const survivor = await E.DB.prepare('SELECT id FROM notes WHERE id = ?').bind('b').first();
    expect(survivor).not.toBeNull();
  });

  it('rejects unknown id', async () => {
    const r = await reg().delete_note({ id: 'ghost', confirm: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ghost');
    expect(E.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
  });
});
