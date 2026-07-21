import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import type { AuthContext } from '../../src/env.js';
import { runMigrations } from '../../src/db/migrate.js';
import { registerLink } from '../../src/mcp/tools/link.js';

const E = env as any;

describe('link', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM edges');
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('a','A','','tl','[]',null,0,0,null)`).run();
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('b','B','','tl','[]',null,0,0,null)`).run();
  });
  function reg(auth?: AuthContext) {
    const r: any = {};
    registerLink({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, auth);
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

  it('rejects a task as endpoint (from and to)', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at,status,due_at,priority,completed_at)
       VALUES ('t','Task','','tl','["operations"]','task',0,0,null,'open',null,null,null)`
    ).run();
    const rTo = await reg().link({ from_id: 'a', to_id: 't', relation_type: 'analogous_to', why: 'shared feedback-loop mechanism substantive text' });
    expect(rTo.isError).toBe(true);
    expect(rTo.content[0].text).toContain('tasks live outside the graph');
    const rFrom = await reg().link({ from_id: 't', to_id: 'a', relation_type: 'analogous_to', why: 'shared feedback-loop mechanism substantive text' });
    expect(rFrom.isError).toBe(true);
    // nenhuma edge criada
    const count = await E.DB.prepare('SELECT count(*) c FROM edges').first();
    expect(count.c).toBe(0);
  });

  // Fix 21/07/2026 (curadoria): o lookup dos endpoints ignorava o escopo `private`
  // — nota privada era "not found" MESMO pra credencial com o escopo, então nota
  // privada nunca podia ganhar edge via MCP (get_note lia, link recusava).
  it('nota privada: link funciona COM escopo private e segue "not found" sem ele', async () => {
    await E.DB.prepare(`UPDATE notes SET private = 1 WHERE id = 'b'`).run();
    const why = 'shared feedback-loop mechanism substantive text';

    const noScope = await reg({ email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'k1' })
      .link({ from_id: 'a', to_id: 'b', relation_type: 'analogous_to', why });
    expect(noScope.isError).toBe(true);
    expect(noScope.content[0].text).toContain('not found');

    const withScope = await reg({ email: 'o@x', loggedInAt: 0, scopes: 'full,private', keyId: 'k2' })
      .link({ from_id: 'a', to_id: 'b', relation_type: 'analogous_to', why });
    expect(withScope.isError).toBeUndefined();
    const count = await E.DB.prepare('SELECT count(*) c FROM edges').first();
    expect(count.c).toBe(1);
  });

  it('duplicate returns duplicate:true without id and keeps original why', async () => {
    const why1 = 'original shared mechanism explanation here';
    const first = await reg().link({ from_id: 'a', to_id: 'b', relation_type: 'analogous_to', why: why1 });
    expect(JSON.parse(first.content[0].text).id).toBeDefined();
    const second = await reg().link({ from_id: 'a', to_id: 'b', relation_type: 'analogous_to', why: 'a different why that should be ignored' });
    const p = JSON.parse(second.content[0].text);
    expect(p.duplicate).toBe(true);
    expect(p.id).toBeUndefined();
    // COUNT = 1 e o why original permanece
    const count = await E.DB.prepare('SELECT count(*) c FROM edges').first();
    expect(count.c).toBe(1);
    const row = await E.DB.prepare('SELECT why FROM edges').first();
    expect(row.why).toBe(why1);
  });
});
