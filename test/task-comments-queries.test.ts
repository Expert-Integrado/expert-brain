import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  insertTask,
  addTaskComment,
  listTaskComments,
  countTaskComments,
  countTaskCommentsBatch,
  deleteTaskComment,
} from '../src/db/queries.js';

const E = env as any;

async function seedTask(id: string) {
  const now = Date.now();
  await insertTask(E, {
    id, title: id, body: id, tldr: id, domains: '["operations"]',
    status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
  });
}

let seq = 0;
async function addComment(taskId: string, author: 'owner' | 'guest' | 'agent', body: string, name: string | null = null) {
  const id = `cmt_test_${seq++}`;
  // created_at crescente garante ordem cronologica deterministica no teste.
  await addTaskComment(E, { id, task_id: taskId, author, author_name: name, body, created_at: 1000 + seq });
  return id;
}

describe('task_comments — queries (spec 53)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_comments');
    await E.DB.exec('DELETE FROM notes');
    seq = 0;
  });

  it('add + list em ordem cronologica com autor/nome corretos', async () => {
    await seedTask('t1');
    await addComment('t1', 'owner', 'primeiro');
    await addComment('t1', 'guest', 'segundo', 'Convidado Fic');
    await addComment('t1', 'agent', 'terceiro', 'bot');
    const list = await listTaskComments(E, 't1');
    expect(list.map((c) => c.body)).toEqual(['primeiro', 'segundo', 'terceiro']);
    expect(list[0].author).toBe('owner');
    expect(list[1].author).toBe('guest');
    expect(list[1].author_name).toBe('Convidado Fic');
    expect(list[2].author_name).toBe('bot');
  });

  it('countTaskComments total e por autor', async () => {
    await seedTask('t1');
    await addComment('t1', 'guest', 'a', 'X');
    await addComment('t1', 'guest', 'b', 'Y');
    await addComment('t1', 'owner', 'c');
    expect(await countTaskComments(E, 't1')).toBe(3);
    expect(await countTaskComments(E, 't1', 'guest')).toBe(2);
    expect(await countTaskComments(E, 't1', 'owner')).toBe(1);
    expect(await countTaskComments(E, 't1', 'agent')).toBe(0);
  });

  it('countTaskCommentsBatch: 1 query pra N tasks (sem N+1)', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await seedTask('t3');
    await addComment('t1', 'owner', 'a');
    await addComment('t1', 'owner', 'b');
    await addComment('t2', 'guest', 'c', 'Z');

    const spy = vi.spyOn(E.DB, 'prepare');
    const counts = await countTaskCommentsBatch(E, ['t1', 't2', 't3']);
    // Uma unica chamada a prepare (1 chunk) — nao 1 por task.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    expect(counts.get('t1')).toBe(2);
    expect(counts.get('t2')).toBe(1);
    expect(counts.get('t3')).toBeUndefined(); // 0 comentarios → ausente do Map
  });

  it('deleteTaskComment remove so o alvo', async () => {
    await seedTask('t1');
    const a = await addComment('t1', 'owner', 'fica');
    const b = await addComment('t1', 'guest', 'sai', 'Y');
    expect(await deleteTaskComment(E, b)).toBe(true);
    expect(await deleteTaskComment(E, 'inexistente')).toBe(false);
    const list = await listTaskComments(E, 't1');
    expect(list.map((c) => c.id)).toEqual([a]);
  });

  it('soft-delete da task: comentarios NAO vazam em list/count', async () => {
    await seedTask('t1');
    await addComment('t1', 'owner', 'a');
    await addComment('t1', 'guest', 'b', 'Y');
    expect(await countTaskComments(E, 't1')).toBe(2);
    // Soft-delete (o delete_note real marca deleted_at, nao apaga a linha).
    await E.DB.prepare(`UPDATE notes SET deleted_at = ? WHERE id = 't1'`).bind(Date.now()).run();
    expect(await listTaskComments(E, 't1')).toEqual([]);
    expect(await countTaskComments(E, 't1')).toBe(0);
    expect(await countTaskComments(E, 't1', 'guest')).toBe(0);
  });

  it('hard-delete da task: FK ON DELETE CASCADE limpa os comentarios', async () => {
    await seedTask('t1');
    await addComment('t1', 'owner', 'a');
    await addComment('t1', 'guest', 'b', 'Y');
    // Hard delete da nota → cascade remove as linhas de task_comments.
    await E.DB.prepare(`DELETE FROM notes WHERE id = 't1'`).run();
    const rows = await E.DB.prepare(`SELECT count(*) AS c FROM task_comments WHERE task_id = 't1'`).first();
    expect(rows.c).toBe(0);
  });
});
