import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { addTaskSubtasks } from '../src/db/subtasks.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

// Task com updated_at conhecido — os endpoints de subtask NÃO podem mexer nele.
async function seedTask(id: string, updatedAt = 1000) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?, 'task', 'open', NULL, NULL, NULL, ?, ?, NULL)`
  ).bind(id, `Task ${id}`, 'corpo', `Task ${id}`, '["operations"]', updatedAt, updatedAt).run();
}

function post(path: string, body: unknown, c?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (c) headers.cookie = c;
  return SELF.fetch(`https://x${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('endpoints de subtask do console (/app/tasks/subtask/*)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_subtasks');
    await E.DB.exec('DELETE FROM task_activity');
    await E.DB.exec('DELETE FROM notes');
  });

  it('sem sessão nem Bearer → 401 e nada gravado', async () => {
    await seedTask('t1');
    const res = await post('/app/tasks/subtask/add', { task_id: 't1', title: 'x' });
    expect(res.status).toBe(401);
    const row = await E.DB.prepare(`SELECT count(*) AS c FROM task_subtasks`).first();
    expect(row.c).toBe(0);
  });

  it('add cria o item, devolve progress e NÃO toca o updated_at da task', async () => {
    await seedTask('t1', 1000);
    const res = await post('/app/tasks/subtask/add', { task_id: 't1', title: 'primeira parte' }, await cookie());
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.subtask.id.startsWith('sub_')).toBe(true);
    expect(data.subtask.title).toBe('primeira parte');
    expect(data.progress).toEqual({ done: 0, total: 1 });

    const note = await E.DB.prepare(`SELECT updated_at FROM notes WHERE id='t1'`).first();
    expect(note.updated_at).toBe(1000); // tick/checklist não invalida edição otimista
  });

  it('toggle marca com actor oauth:<email> da sessão e desmarca limpando', async () => {
    await seedTask('t1');
    const [a] = (await addTaskSubtasks(E, 't1', ['parte'], null, 1000)) as any[];
    const c = await cookie();

    const on = await post('/app/tasks/subtask/toggle', { task_id: 't1', id: a.id, done: true }, c);
    expect(on.status).toBe(200);
    expect(((await on.json()) as any).progress).toEqual({ done: 1, total: 1 });
    const row = await E.DB.prepare(`SELECT done_at, done_by FROM task_subtasks WHERE id=?`).bind(a.id).first();
    expect(row.done_at).not.toBeNull();
    expect(row.done_by).toBe(`oauth:${E.OWNER_EMAIL}`);

    const off = await post('/app/tasks/subtask/toggle', { task_id: 't1', id: a.id, done: false }, c);
    expect(((await off.json()) as any).progress).toEqual({ done: 0, total: 1 });
    const row2 = await E.DB.prepare(`SELECT done_at, done_by FROM task_subtasks WHERE id=?`).bind(a.id).first();
    expect(row2.done_at).toBeNull();
    expect(row2.done_by).toBeNull();
  });

  it('update renomeia; delete remove e devolve progress atualizado', async () => {
    await seedTask('t1');
    const [a, b] = (await addTaskSubtasks(E, 't1', ['renomear', 'remover'], null, 1000)) as any[];
    const c = await cookie();

    const ren = await post('/app/tasks/subtask/update', { task_id: 't1', id: a.id, title: 'novo nome' }, c);
    expect(ren.status).toBe(200);
    expect(((await ren.json()) as any).subtask.title).toBe('novo nome');

    const del = await post('/app/tasks/subtask/delete', { task_id: 't1', id: b.id }, c);
    expect(del.status).toBe(200);
    expect(((await del.json()) as any).progress).toEqual({ done: 0, total: 1 });
    const row = await E.DB.prepare(`SELECT count(*) AS c FROM task_subtasks WHERE task_id='t1'`).first();
    expect(row.c).toBe(1);
  });

  it('404: task inexistente no add; sub de OUTRA task no toggle/update/delete', async () => {
    await seedTask('t1');
    await seedTask('t2');
    const [a] = (await addTaskSubtasks(E, 't1', ['de t1'], null, 1000)) as any[];
    const c = await cookie();

    expect((await post('/app/tasks/subtask/add', { task_id: 'nao-existe', title: 'x' }, c)).status).toBe(404);
    expect((await post('/app/tasks/subtask/toggle', { task_id: 't2', id: a.id, done: true }, c)).status).toBe(404);
    expect((await post('/app/tasks/subtask/update', { task_id: 't2', id: a.id, title: 'y' }, c)).status).toBe(404);
    expect((await post('/app/tasks/subtask/delete', { task_id: 't2', id: a.id }, c)).status).toBe(404);
  });

  it('validação: título vazio ou >200 chars → 400', async () => {
    await seedTask('t1');
    const c = await cookie();
    expect((await post('/app/tasks/subtask/add', { task_id: 't1', title: '   ' }, c)).status).toBe(400);
    expect((await post('/app/tasks/subtask/add', { task_id: 't1', title: 'x'.repeat(201) }, c)).status).toBe(400);
  });

  it('histórico: mutações viram frases PT no detalhe (adicionada/concluída)', async () => {
    await seedTask('t1');
    const c = await cookie();
    const add = await post('/app/tasks/subtask/add', { task_id: 't1', title: 'spec 92' }, c);
    const sub = ((await add.json()) as any).subtask;
    await post('/app/tasks/subtask/toggle', { task_id: 't1', id: sub.id, done: true }, c);

    const det = await (await SELF.fetch('https://x/app/tasks/t1', { headers: { cookie: c } })).text();
    expect(det).toContain('subtarefa adicionada: &quot;spec 92&quot;');
    expect(det).toContain('subtarefa concluída: &quot;spec 92&quot;');
  });
});

describe('SSR do detalhe — seção Subtarefas', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_subtasks');
    await E.DB.exec('DELETE FROM notes');
  });

  it('lista itens com progresso e marca os concluídos', async () => {
    await seedTask('t1');
    const subs = (await addTaskSubtasks(E, 't1', ['feita', 'aberta'], null, 1000)) as any[];
    await E.DB.prepare(`UPDATE task_subtasks SET done_at=2000, done_by='pat_x' WHERE id=?`).bind(subs[0].id).run();

    const det = await (await SELF.fetch('https://x/app/tasks/t1', { headers: { cookie: await cookie() } })).text();
    expect(det).toContain('id="subtarefas"');
    expect(det).toContain('data-subtasks-progress');
    expect(det).toContain('1/2');
    expect(det).toContain('feita');
    expect(det).toContain('aberta');
    expect(det).toContain(`data-subtask-id="${subs[0].id}"`);
    // Item feito vem com checkbox marcado no SSR.
    expect(det).toMatch(new RegExp(`data-subtask-id="${subs[0].id}"[\\s\\S]{0,300}?checked`));
  });

  it('task sem checklist mostra a seção com form de adicionar (sem contador)', async () => {
    await seedTask('t1');
    const det = await (await SELF.fetch('https://x/app/tasks/t1', { headers: { cookie: await cookie() } })).text();
    expect(det).toContain('id="subtarefas"');
    expect(det).toContain('data-subtask-input');
    expect(det).not.toContain('data-subtasks-progress-visible');
  });

  it('escape: título malicioso vira texto inerte', async () => {
    await seedTask('t1');
    await addTaskSubtasks(E, 't1', ['<script>alert(3)</script>'], null, 1000);
    const det = await (await SELF.fetch('https://x/app/tasks/t1', { headers: { cookie: await cookie() } })).text();
    expect(det).toContain('&lt;script&gt;alert(3)&lt;/script&gt;');
    expect(det).not.toContain('<script>alert(3)</script>');
  });
});
