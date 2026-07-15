import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTask } from '../../src/db/queries.js';
import { registerUpdateTaskDeps } from '../../src/mcp/tools/update-task-deps.js';

const E = env as any;

const OWNER = { email: 'o@x', loggedInAt: 0 } as any;
const PAT_FULL = { email: 'pat@x', loggedInAt: 0, scopes: 'full', keyId: 'key_pat1' } as any;
const PAT_PRIVATE = { email: 'pat@x', loggedInAt: 0, scopes: 'full,private', keyId: 'key_pat2' } as any;

function reg(auth: any) {
  const r: any = {};
  registerUpdateTaskDeps({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, auth);
  return r.update_task_deps;
}

async function seedTask(id: string, title = id, status: 'open' | 'in_progress' | 'done' | 'canceled' = 'open') {
  await insertTask(E, {
    id, title, body: 'corpo', tldr: title, domains: '["operations"]',
    status, due_at: null, priority: null, created_at: 1000, updated_at: 1000,
  });
}

describe('update_task_deps (MCP — spec 93)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_deps');
    await E.DB.exec('DELETE FROM task_activity');
    await E.DB.exec('DELETE FROM notes');
  });

  it('block_on por id declara a dependência e devolve blocked_by/blocks/blocked', async () => {
    await seedTask('t1');
    await seedTask('t2');
    const res = await reg(OWNER)({ task_id: 't1', block_on: ['t2'] });
    expect(res.isError).toBeUndefined();
    const p = JSON.parse(res.content[0].text);
    expect(p.blocked_by.map((t: any) => t.id)).toEqual(['t2']);
    expect(p.blocked).toBe(true);
  });

  it('block_on por TÍTULO exato resolve o id', async () => {
    await seedTask('t1', 'Task um');
    await seedTask('t2', 'Título único');
    const res = await reg(OWNER)({ task_id: 't1', block_on: ['Título único'] });
    expect(res.isError).toBeUndefined();
    const p = JSON.parse(res.content[0].text);
    expect(p.blocked_by.map((t: any) => t.id)).toEqual(['t2']);
  });

  it('blocked reflete status: bloqueadora done → blocked false', async () => {
    await seedTask('t1');
    await seedTask('t2', 't2', 'done');
    const res = await reg(OWNER)({ task_id: 't1', block_on: ['t2'] });
    const p = JSON.parse(res.content[0].text);
    expect(p.blocked).toBe(false);
    expect(p.blocked_by.map((t: any) => t.id)).toEqual(['t2']); // continua listada, só não "pendente"
  });

  it('unblock_from remove a dependência', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await reg(OWNER)({ task_id: 't1', block_on: ['t2'] });
    const res = await reg(OWNER)({ task_id: 't1', unblock_from: ['t2'] });
    expect(res.isError).toBeUndefined();
    const p = JSON.parse(res.content[0].text);
    expect(p.blocked_by).toEqual([]);
    expect(p.blocked).toBe(false);
  });

  it('auto-referência é rejeitada, sem escrita parcial', async () => {
    await seedTask('t1');
    await seedTask('t2');
    const res = await reg(OWNER)({ task_id: 't1', block_on: ['t2', 't1'] });
    expect(res.isError).toBe(true);
    const row = await E.DB.prepare(`SELECT count(*) AS c FROM task_deps`).first();
    expect(row.c).toBe(0);
  });

  it('ciclo direto é rejeitado', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await reg(OWNER)({ task_id: 't2', block_on: ['t1'] }); // t2 bloqueada por t1
    const res = await reg(OWNER)({ task_id: 't1', block_on: ['t2'] }); // cycle
    expect(res.isError).toBe(true);
  });

  it('ref de task inexistente aborta a call inteira', async () => {
    await seedTask('t1');
    const res = await reg(OWNER)({ task_id: 't1', block_on: ['nao-existe'] });
    expect(res.isError).toBe(true);
    const row = await E.DB.prepare(`SELECT count(*) AS c FROM task_deps`).first();
    expect(row.c).toBe(0);
  });

  it('cada mutação gera task_activity field=dependency', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await reg(OWNER)({ task_id: 't1', block_on: ['t2'] });
    const rows = await E.DB.prepare(`SELECT * FROM task_activity WHERE task_id='t1' AND field='dependency'`).all();
    expect(rows.results.length).toBe(1);
  });

  it('task privada: PAT sem escopo private = not found; com escopo funciona', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await E.DB.prepare(`UPDATE notes SET private = 1 WHERE id = 't1'`).run();

    const denied = await reg(PAT_FULL)({ task_id: 't1', block_on: ['t2'] });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('not found');

    const allowed = await reg(PAT_PRIVATE)({ task_id: 't1', block_on: ['t2'] });
    expect(allowed.isError).toBeUndefined();
  });

  it('call sem nenhuma operação → erro orientando', async () => {
    await seedTask('t1');
    const res = await reg(OWNER)({ task_id: 't1' });
    expect(res.isError).toBe(true);
  });
});
