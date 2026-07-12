import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTask } from '../../src/db/queries.js';
import { addTaskSubtasks } from '../../src/db/subtasks.js';
import { registerUpdateSubtask } from '../../src/mcp/tools/update-subtask.js';

const E = env as any;

// Sessão OAuth do dono (sem scopes = nível dono: vê privada, autoria oauth:<email>).
const OWNER = { email: 'o@x', loggedInAt: 0 } as any;
// PAT full SEM escopo private (não enxerga task privada) e COM (enxerga).
const PAT_FULL = { email: 'pat@x', loggedInAt: 0, scopes: 'full', keyId: 'key_pat1' } as any;
const PAT_PRIVATE = { email: 'pat@x', loggedInAt: 0, scopes: 'full,private', keyId: 'key_pat2' } as any;

function reg(auth: any) {
  const r: any = {};
  registerUpdateSubtask({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, auth);
  return r.update_subtask;
}

async function seedTask(id: string, updatedAt = 1000) {
  await insertTask(E, {
    id, title: id, body: 'corpo', tldr: id, domains: '["operations"]',
    status: 'open', due_at: null, priority: null, created_at: updatedAt, updated_at: updatedAt,
  });
  // updated_at conhecido pra provar que mutação de subtask NÃO mexe nele
  // (insertTask pode stampar por conta própria).
  await E.DB.prepare(`UPDATE notes SET updated_at = ? WHERE id = ?`).bind(updatedAt, id).run();
}

async function taskUpdatedAt(id: string): Promise<number> {
  const row = await E.DB.prepare(`SELECT updated_at FROM notes WHERE id = ?`).bind(id).first();
  return row.updated_at;
}

describe('update_subtask (MCP — spec 38)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_subtasks');
    await E.DB.exec('DELETE FROM task_activity');
    await E.DB.exec('DELETE FROM notes');
  });

  it('add cria itens em ordem e devolve checklist completo + progresso', async () => {
    await seedTask('t1');
    const res = await reg(OWNER)({ task_id: 't1', add: ['spec 92', 'spec 93'] });
    expect(res.isError).toBeUndefined();
    const p = JSON.parse(res.content[0].text);
    expect(p.subtasks.map((s: any) => s.title)).toEqual(['spec 92', 'spec 93']);
    expect(p.subtasks[0].id.startsWith('sub_')).toBe(true);
    expect(p.subtasks[0].done).toBe(false);
    expect(p.subtask_progress).toEqual({ done: 0, total: 2 });
    expect(await taskUpdatedAt('t1')).toBe(1000); // checklist não toca a task
  });

  it('check por ID e por TÍTULO exato; uncheck reabre; progresso acompanha', async () => {
    await seedTask('t1');
    const [a] = (await addTaskSubtasks(E, 't1', ['primeira', 'segunda'], null, 500)) as any[];
    const tool = reg(PAT_FULL);

    const r1 = await tool({ task_id: 't1', check: [a.id, 'segunda'] });
    expect(r1.isError).toBeUndefined();
    const p1 = JSON.parse(r1.content[0].text);
    expect(p1.subtask_progress).toEqual({ done: 2, total: 2 });
    expect(p1.subtasks.every((s: any) => s.done === true)).toBe(true);

    // Autoria do tick = keyId do PAT.
    const row = await E.DB.prepare(`SELECT done_by FROM task_subtasks WHERE id = ?`).bind(a.id).first();
    expect(row.done_by).toBe('key_pat1');

    const r2 = await tool({ task_id: 't1', uncheck: ['primeira'] });
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.subtask_progress).toEqual({ done: 1, total: 2 });
    expect(await taskUpdatedAt('t1')).toBe(1000);
  });

  it('ref por título ambíguo → erro LISTANDO os itens, sem escrita parcial', async () => {
    await seedTask('t1');
    const subs = (await addTaskSubtasks(E, 't1', ['duplicada', 'duplicada'], null, 500)) as any[];
    const res = await reg(OWNER)({ task_id: 't1', check: ['duplicada'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(subs[0].id);
    expect(res.content[0].text).toContain(subs[1].id);
    const row = await E.DB.prepare(`SELECT count(done_at) AS c FROM task_subtasks WHERE task_id='t1'`).first();
    expect(row.c).toBe(0); // nada foi marcado
  });

  it('ref inexistente aborta a call inteira — nem o add válido da mesma call grava', async () => {
    await seedTask('t1');
    const res = await reg(OWNER)({ task_id: 't1', add: ['novo item'], check: ['sub_nao_existe'] });
    expect(res.isError).toBe(true);
    const row = await E.DB.prepare(`SELECT count(*) AS c FROM task_subtasks WHERE task_id='t1'`).first();
    expect(row.c).toBe(0); // o add não passou — sem escrita parcial
  });

  it('remove exige ID (título em remove → erro); retitle renomeia', async () => {
    await seedTask('t1');
    const [a, b] = (await addTaskSubtasks(E, 't1', ['renomear', 'remover'], null, 500)) as any[];
    const tool = reg(OWNER);

    const byTitle = await tool({ task_id: 't1', remove: ['remover'] });
    expect(byTitle.isError).toBe(true);

    const ok = await tool({
      task_id: 't1',
      remove: [b.id],
      retitle: [{ id: a.id, title: 'renomeada' }],
    });
    expect(ok.isError).toBeUndefined();
    const p = JSON.parse(ok.content[0].text);
    expect(p.subtasks.map((s: any) => s.title)).toEqual(['renomeada']);
    expect(p.subtask_progress).toEqual({ done: 0, total: 1 });
  });

  it('task privada: PAT sem escopo private = not found; com escopo funciona', async () => {
    await seedTask('t1');
    await E.DB.prepare(`UPDATE notes SET private = 1 WHERE id = 't1'`).run();

    const denied = await reg(PAT_FULL)({ task_id: 't1', add: ['x'] });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('not found');

    const allowed = await reg(PAT_PRIVATE)({ task_id: 't1', add: ['x'] });
    expect(allowed.isError).toBeUndefined();
  });

  it('task inexistente ou id de nota de conhecimento → not found', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('k','C','b','tl','["product"]','concept',1,1,null)`
    ).run();
    const tool = reg(OWNER);
    expect((await tool({ task_id: 'nao-existe', add: ['x'] })).isError).toBe(true);
    expect((await tool({ task_id: 'k', add: ['x'] })).isError).toBe(true);
  });

  it('call sem nenhuma operação → erro orientando', async () => {
    await seedTask('t1');
    const res = await reg(OWNER)({ task_id: 't1' });
    expect(res.isError).toBe(true);
  });

  it('mutações logam task_activity field=subtask (auditoria)', async () => {
    await seedTask('t1');
    const [a] = (await addTaskSubtasks(E, 't1', ['item'], null, 500)) as any[];
    await reg(OWNER)({ task_id: 't1', add: ['outro'], check: [a.id] });
    const rows = await E.DB.prepare(
      `SELECT field, old_value FROM task_activity WHERE task_id='t1' AND field='subtask' ORDER BY id`
    ).all();
    const acts = (rows.results ?? []).map((r: any) => r.old_value);
    expect(acts).toContain('adicionada');
    expect(acts).toContain('concluída');
  });

  it('cap de 100 itens por task → erro claro sem gravar', async () => {
    await seedTask('t1');
    await addTaskSubtasks(E, 't1', Array.from({ length: 100 }, (_, i) => `i${i}`), null, 500);
    const res = await reg(OWNER)({ task_id: 't1', add: ['excedente'] });
    expect(res.isError).toBe(true);
    const row = await E.DB.prepare(`SELECT count(*) AS c FROM task_subtasks WHERE task_id='t1'`).first();
    expect(row.c).toBe(100);
  });
});
