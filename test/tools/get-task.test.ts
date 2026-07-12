import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTask, replaceTags } from '../../src/db/queries.js';
import { registerGetTask } from '../../src/mcp/tools/get-task.js';

const E = env as any;

function reg() {
  const r: any = {};
  registerGetTask({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
  return r;
}

describe('get_task', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
  });

  it('returns full task state (status/priority/due/tags/url)', async () => {
    const now = Date.now();
    const due = Date.parse('2026-06-22T17:00:00.000Z'); // 14:00 BRT
    await insertTask(E, { id: 't1', title: 'Ligar cliente', body: 'contexto', tldr: 't', domains: '["operations"]', status: 'in_progress', due_at: due, priority: 2, created_at: now, updated_at: now });
    await replaceTags(E, 't1', ['psp']);
    const res = await reg().get_task({ id: 't1' });
    const p = JSON.parse(res.content[0].text);
    expect(p.status).toBe('in_progress');
    expect(p.priority).toBe(2);
    expect(p.due_at).toBe(due);
    expect(p.due_brt).toBe('22/06/2026 14:00');
    expect(p.tags).toEqual(['psp']);
    expect(p.body).toBe('contexto');
    expect(typeof p.url).toBe('string');
    expect(p.completed_at).toBeNull();
  });

  it('errors (without throwing) on a knowledge note id', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('k','C','b','tl','["product"]','concept',1,1,null)`
    ).run();
    const res = await reg().get_task({ id: 'k' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('k');
  });

  it('errors on unknown id', async () => {
    const res = await reg().get_task({ id: 'ghost' });
    expect(res.isError).toBe(true);
  });

  it('returns the checklist with progress (spec 38)', async () => {
    const now = Date.now();
    await insertTask(E, { id: 't1', title: 'Com checklist', body: 'b', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
    const { addTaskSubtasks, setSubtaskDone } = await import('../../src/db/subtasks.js');
    const subs = (await addTaskSubtasks(E, 't1', ['feita', 'aberta'], 'oauth:o@x', now)) as any[];
    await setSubtaskDone(E, 't1', subs[0].id, true, 'key_pat9', now);
    const res = await reg().get_task({ id: 't1' });
    const p = JSON.parse(res.content[0].text);
    expect(p.subtasks.map((s: any) => [s.title, s.done])).toEqual([['feita', true], ['aberta', false]]);
    expect(p.subtasks[0].done_by).toBe('key_pat9');
    expect(p.subtask_progress).toEqual({ done: 1, total: 2 });
  });
});
