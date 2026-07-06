import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerCompleteTask } from '../../src/mcp/tools/complete-task.js';

const E = env as any;
const AUTH = { email: 'test@example.com', loggedInAt: 0 };
const COLS = `(id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at,status,due_at,priority,completed_at)`;

function reg() {
  const r: any = {};
  registerCompleteTask({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, AUTH);
  return r;
}

describe('complete_task', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await E.DB.prepare(
      `INSERT INTO notes ${COLS} VALUES ('t1','Tarefa','corpo','t1','["operations"]','task',1,1,null,'open',null,null,null)`
    ).run();
    // uma nota de conhecimento, pra garantir que complete_task não a toca
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('k1','Conceito','b','tl','["product"]','concept',1,1,null)`
    ).run();
  });

  it('marks status=done + completed_at and appends outcome', async () => {
    const res = await reg().complete_task({ id: 't1', outcome: 'Cliente fechou' });
    const p = JSON.parse(res.content[0].text);
    expect(p.status).toBe('done');
    const row = await E.DB.prepare(`SELECT status, completed_at, body FROM notes WHERE id='t1'`).first();
    expect(row.status).toBe('done');
    expect(row.completed_at).toBeGreaterThan(0);
    expect(row.body).toContain('**Resultado:** Cliente fechou');
  });

  it('errors when the id is not a task', async () => {
    const res = await reg().complete_task({ id: 'k1' });
    expect(res.isError).toBe(true);
  });

  it('errors on unknown id', async () => {
    const res = await reg().complete_task({ id: 'ghost' });
    expect(res.isError).toBe(true);
  });

  it('is idempotent: completing an already-done task is a no-op', async () => {
    const first = JSON.parse((await reg().complete_task({ id: 't1', outcome: 'primeiro' })).content[0].text);
    const firstCompleted = first.completed_at;
    const second = JSON.parse((await reg().complete_task({ id: 't1', outcome: 'segundo' })).content[0].text);
    expect(second.already_done).toBe(true);
    expect(second.completed_at).toBe(firstCompleted);
    const row = await E.DB.prepare(`SELECT body FROM notes WHERE id='t1'`).first();
    expect((row.body.match(/\*\*Resultado:\*\*/g) || []).length).toBe(1);
  });
});
