import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { insertTask } from '../src/db/queries.js';
import {
  addTaskSubtasks,
  listTaskSubtasks,
  setSubtaskDone,
  retitleSubtask,
  deleteSubtask,
  countTaskSubtasksBatch,
  subtaskProgress,
  MAX_SUBTASKS_PER_TASK,
} from '../src/db/subtasks.js';

const E = env as any;

async function seedTask(id: string) {
  const now = Date.now();
  await insertTask(E, {
    id, title: id, body: id, tldr: id, domains: '["operations"]',
    status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
  });
}

describe('task_subtasks — queries (spec 38)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_subtasks');
    await E.DB.exec('DELETE FROM notes');
  });

  it('add em lote: position incremental, created_by gravado, ordem preservada', async () => {
    await seedTask('t1');
    const subs = await addTaskSubtasks(E, 't1', ['spec 92', 'spec 93'], 'oauth:dono@x.dev', 1000);
    expect(subs).not.toBe('cap-exceeded');
    const created = subs as Exclude<typeof subs, 'cap-exceeded'>;
    expect(created.map((s) => s.title)).toEqual(['spec 92', 'spec 93']);
    expect(created.map((s) => s.position)).toEqual([1, 2]);
    expect(created[0].id.startsWith('sub_')).toBe(true);
    expect(created[0].created_by).toBe('oauth:dono@x.dev');
    expect(created[0].done_at).toBeNull();

    // Segundo lote continua do max(position)+1 — append, nunca renumera.
    const more = await addTaskSubtasks(E, 't1', ['spec 94'], null, 2000);
    expect((more as any)[0].position).toBe(3);

    const list = await listTaskSubtasks(E, 't1');
    expect(list.map((s) => s.title)).toEqual(['spec 92', 'spec 93', 'spec 94']);
  });

  it('setSubtaskDone marca com actor/timestamp e é idempotente (não re-stampa done_at)', async () => {
    await seedTask('t1');
    const [a] = (await addTaskSubtasks(E, 't1', ['x'], null, 1000)) as any[];
    const done = await setSubtaskDone(E, 't1', a.id, true, 'pat_abc', 5000);
    expect(done).not.toBe('not-found');
    expect((done as any).done_at).toBe(5000);
    expect((done as any).done_by).toBe('pat_abc');

    // Re-marcar done: no-op, preserva o carimbo original.
    const again = await setSubtaskDone(E, 't1', a.id, true, 'pat_outro', 9000);
    expect((again as any).done_at).toBe(5000);
    expect((again as any).done_by).toBe('pat_abc');

    // Reabrir limpa os dois campos.
    const reopened = await setSubtaskDone(E, 't1', a.id, false, 'oauth:d@x.dev', 9500);
    expect((reopened as any).done_at).toBeNull();
    expect((reopened as any).done_by).toBeNull();
  });

  it('setSubtaskDone nunca cruza tasks (WHERE id AND task_id)', async () => {
    await seedTask('t1');
    await seedTask('t2');
    const [a] = (await addTaskSubtasks(E, 't1', ['de t1'], null, 1000)) as any[];
    expect(await setSubtaskDone(E, 't2', a.id, true, null, 2000)).toBe('not-found');
    expect(await setSubtaskDone(E, 't1', 'sub_nao_existe', true, null, 2000)).toBe('not-found');
  });

  it('retitle e delete: delete devolve a row removida (pro log de atividade)', async () => {
    await seedTask('t1');
    const [a, b] = (await addTaskSubtasks(E, 't1', ['fica', 'sai'], null, 1000)) as any[];
    const renamed = await retitleSubtask(E, 't1', a.id, 'ficou renomeada');
    expect((renamed as any).title).toBe('ficou renomeada');
    expect(await retitleSubtask(E, 't1', 'sub_x', 'nada')).toBe('not-found');

    const removed = await deleteSubtask(E, 't1', b.id);
    expect((removed as any).title).toBe('sai');
    expect(await deleteSubtask(E, 't1', b.id)).toBe('not-found');
    const list = await listTaskSubtasks(E, 't1');
    expect(list.map((s) => s.title)).toEqual(['ficou renomeada']);
  });

  it('soft-delete da task esconde as subtasks em list (JOIN notes viva)', async () => {
    await seedTask('t1');
    await addTaskSubtasks(E, 't1', ['a', 'b'], null, 1000);
    expect((await listTaskSubtasks(E, 't1')).length).toBe(2);
    await E.DB.prepare(`UPDATE notes SET deleted_at = ? WHERE id = 't1'`).bind(Date.now()).run();
    expect(await listTaskSubtasks(E, 't1')).toEqual([]);
  });

  it('hard-delete da task cascateia (ON DELETE CASCADE)', async () => {
    await seedTask('t1');
    await addTaskSubtasks(E, 't1', ['a'], null, 1000);
    await E.DB.prepare(`DELETE FROM notes WHERE id = 't1'`).run();
    const rows = await E.DB.prepare(`SELECT count(*) AS c FROM task_subtasks WHERE task_id = 't1'`).first();
    expect(rows.c).toBe(0);
  });

  it('countTaskSubtasksBatch: {done,total} por task numa query por chunk, ausente = sem checklist', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await seedTask('t3');
    const subs1 = (await addTaskSubtasks(E, 't1', ['a', 'b', 'c'], null, 1000)) as any[];
    await addTaskSubtasks(E, 't2', ['x'], null, 1000);
    await setSubtaskDone(E, 't1', subs1[0].id, true, null, 2000);
    await setSubtaskDone(E, 't1', subs1[1].id, true, null, 2000);

    const spy = vi.spyOn(E.DB, 'prepare');
    const counts = await countTaskSubtasksBatch(E, ['t1', 't2', 't3']);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    expect(counts.get('t1')).toEqual({ done: 2, total: 3 });
    expect(counts.get('t2')).toEqual({ done: 0, total: 1 });
    expect(counts.get('t3')).toBeUndefined();
  });

  it('countTaskSubtasksBatch com mais de 100 ids divide em chunks', async () => {
    await seedTask('t1');
    await addTaskSubtasks(E, 't1', ['a'], null, 1000);
    const ids = ['t1', ...Array.from({ length: 150 }, (_, i) => `fantasma_${i}`)];
    const spy = vi.spyOn(E.DB, 'prepare');
    const counts = await countTaskSubtasksBatch(E, ids);
    expect(spy).toHaveBeenCalledTimes(2); // 151 ids → 2 chunks de <=100
    spy.mockRestore();
    expect(counts.get('t1')).toEqual({ done: 0, total: 1 });
  });

  it('cap de itens por task: add que estouraria retorna cap-exceeded sem gravar nada', async () => {
    await seedTask('t1');
    const first = await addTaskSubtasks(E, 't1', Array.from({ length: MAX_SUBTASKS_PER_TASK }, (_, i) => `i${i}`), null, 1000);
    expect(first).not.toBe('cap-exceeded');
    const over = await addTaskSubtasks(E, 't1', ['excedente'], null, 2000);
    expect(over).toBe('cap-exceeded');
    expect((await listTaskSubtasks(E, 't1')).length).toBe(MAX_SUBTASKS_PER_TASK);
  });

  it('subtaskProgress resume a lista', () => {
    expect(subtaskProgress([])).toEqual({ done: 0, total: 0 });
    expect(
      subtaskProgress([
        { done_at: 1 } as any,
        { done_at: null } as any,
        { done_at: 2 } as any,
      ])
    ).toEqual({ done: 2, total: 3 });
  });
});
