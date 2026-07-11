import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTask, addTaskComment } from '../../src/db/queries.js';
import { registerCommentTask } from '../../src/mcp/tools/comment-task.js';
import { registerGetTask } from '../../src/mcp/tools/get-task.js';
import { registerListTasks } from '../../src/mcp/tools/list-tasks.js';

const E = env as any;

// Sessão OAuth do dono: resolveMe cai no perfil user_owner (spec 81 — comment_task
// agora exige credencial com usuário resolvível; os casos PAT estão em
// comment-task-signature.test.ts).
const OWNER = { email: 'o@x', loggedInAt: 0 } as any;

function reg(fn: (s: any, e: any, a?: any) => void) {
  const r: any = {};
  fn({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, OWNER);
  return r;
}

async function seedTask(id: string) {
  const now = Date.now();
  await insertTask(E, {
    id, title: id, body: 'corpo', tldr: id, domains: '["operations"]',
    status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
  });
}

describe('comment_task (MCP)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_comments');
    await E.DB.exec('DELETE FROM notes');
  });

  it('cria comentario author=agent e devolve contagem', async () => {
    await seedTask('t1');
    const res = await reg(registerCommentTask).comment_task({ task_id: 't1', body: 'progresso feito', author_name: 'squad' });
    const p = JSON.parse(res.content[0].text);
    expect(p.author).toBe('agent');
    expect(p.author_name).toBe('squad');
    expect(p.body).toBe('progresso feito');
    expect(p.comment_count).toBe(1);
    expect(typeof p.created_brt).toBe('string');
  });

  it('author_name omitido fica null; a identidade vem do author_user (spec 81)', async () => {
    await seedTask('t1');
    const res = await reg(registerCommentTask).comment_task({ task_id: 't1', body: 'nota' });
    const p = JSON.parse(res.content[0].text);
    expect(p.author_name).toBeNull();
    expect(p.author_user).toBeTruthy();
  });

  it('erro (sem throw) quando id nao e task', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('k','C','b','tl','["product"]','concept',1,1,null)`
    ).run();
    const res = await reg(registerCommentTask).comment_task({ task_id: 'k', body: 'x' });
    expect(res.isError).toBe(true);
    const resGhost = await reg(registerCommentTask).comment_task({ task_id: 'ghost', body: 'x' });
    expect(resGhost.isError).toBe(true);
  });

  it('get_task devolve a thread (cronologica) + comment_count', async () => {
    await seedTask('t1');
    await addTaskComment(E, { id: 'c1', task_id: 't1', author: 'owner', author_name: null, body: 'um', created_at: 1001 });
    await addTaskComment(E, { id: 'c2', task_id: 't1', author: 'agent', author_name: 'bot', body: 'dois', created_at: 1002 });
    const res = await reg(registerGetTask).get_task({ id: 't1' });
    const p = JSON.parse(res.content[0].text);
    expect(p.comment_count).toBe(2);
    expect(p.comments.map((c: any) => c.body)).toEqual(['um', 'dois']);
    expect(p.comments[0].author).toBe('owner');
    expect(typeof p.comments[0].created_brt).toBe('string');
  });

  it('list_tasks traz comment_count por item', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await addTaskComment(E, { id: 'c1', task_id: 't1', author: 'owner', author_name: null, body: 'a', created_at: 1001 });
    await addTaskComment(E, { id: 'c2', task_id: 't1', author: 'guest', author_name: 'Y', body: 'b', created_at: 1002 });
    const res = await reg(registerListTasks).list_tasks({});
    const p = JSON.parse(res.content[0].text);
    const byId = Object.fromEntries(p.tasks.map((t: any) => [t.id, t.comment_count]));
    expect(byId['t1']).toBe(2);
    expect(byId['t2']).toBe(0);
  });
});
