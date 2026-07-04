import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerExpand } from '../../src/mcp/tools/expand.js';

const E = env as any;

describe('expand', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM edges');
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('a','A','b','tl','["x"]',null,0,0,null)`).run();
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('b','B','b','tl','["y"]',null,0,0,null)`).run();
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('c','C','b','tl','["z"]',null,0,0,null)`).run();
    await E.DB.prepare(`INSERT INTO edges VALUES ('ex1','a','b','analogous_to','long enough mechanism why text',0)`).run();
    await E.DB.prepare(`INSERT INTO edges VALUES ('ex2','c','a','causes','long enough mechanism why text',0)`).run();
  });

  function reg() {
    const r: any = {};
    const s: any = { registerTool: (n: string, _m: any, h: any) => { r[n] = h; } };
    registerExpand(s, E);
    return r;
  }

  it('returns both directions by default', async () => {
    const r = await reg().expand({ note_id: 'a' });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.neighbors.length).toBe(2);
  });

  it('direction=out filters', async () => {
    const parsed = JSON.parse((await reg().expand({ note_id: 'a', direction: 'out' })).content[0].text);
    expect(parsed.neighbors.every((n: any) => n.note.id !== 'c')).toBe(true);
  });

  it('errors on unknown note', async () => {
    const r = await reg().expand({ note_id: 'ghost' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ghost');
  });
});
