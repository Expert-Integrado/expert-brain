import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerLink } from '../../src/mcp/tools/link.js';

const E = env as any;

describe('link', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM edges');
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    await E.DB.prepare(`INSERT INTO notes VALUES ('a','A','','tl','[]',null,0,0,null)`).run();
    await E.DB.prepare(`INSERT INTO notes VALUES ('b','B','','tl','[]',null,0,0,null)`).run();
  });
  function reg() {
    const r: any = {};
    registerLink({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
    return r;
  }

  it('creates edge', async () => {
    const r = await reg().link({ from_id: 'a', to_id: 'b', relation_type: 'analogous_to', why: 'shared feedback-loop mechanism substantive text' });
    expect(r.isError).toBeUndefined();
    const row = await E.DB.prepare('SELECT * FROM edges').first();
    expect(row.from_id).toBe('a');
  });

  it('rejects self-loop', async () => {
    const r = await reg().link({ from_id: 'a', to_id: 'a', relation_type: 'analogous_to', why: 'shared feedback-loop mechanism substantive text' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('itself');
  });

  it('rejects short why', async () => {
    const r = await reg().link({ from_id: 'a', to_id: 'b', relation_type: 'analogous_to', why: 'short' });
    expect(r.isError).toBe(true);
  });

  it('rejects missing note', async () => {
    const r = await reg().link({ from_id: 'a', to_id: 'ghost', relation_type: 'analogous_to', why: 'shared feedback-loop mechanism substantive text' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ghost');
  });
});
