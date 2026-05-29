import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerGetNote } from '../../src/mcp/tools/get-note.js';

const E = env as any;

describe('get_note', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM edges');
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    await E.DB.prepare(`INSERT INTO notes VALUES ('a','Title','full body','tl','["x"]','idea',1,1,null)`).run();
    await E.DB.prepare(`INSERT INTO tags (note_id,tag) VALUES ('a','t1'),('a','t2')`).run();
  });

  function reg() {
    const r: any = {};
    registerGetNote({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
    return r;
  }

  it('returns full body + tags + edges', async () => {
    const r = await reg().get_note({ id: 'a' });
    const p = JSON.parse(r.content[0].text);
    expect(p.body).toBe('full body');
    expect(p.tags.sort()).toEqual(['t1','t2']);
    expect(Array.isArray(p.edges.out)).toBe(true);
  });

  it('errors on unknown', async () => {
    const r = await reg().get_note({ id: 'ghost' });
    expect(r.isError).toBe(true);
  });
});
