import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerListTasksDueToday } from '../../src/mcp/tools/list-tasks-due-today.js';

const E = env as any;
const COLS = `(id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at,status,due_at,priority,completed_at)`;

function reg() {
  const r: any = {};
  registerListTasksDueToday({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
  return r;
}

async function insertTaskRow(id: string, status: string, dueOffsetMs: number | null, priority: number | null) {
  const now = Date.now();
  const due = dueOffsetMs === null ? null : now + dueOffsetMs;
  await E.DB.prepare(
    `INSERT INTO notes ${COLS} VALUES (?,?,?,?,?,'task',?,?,null,?,?,?,null)`
  ).bind(id, id, 'b', id, '["operations"]', now, now, status, due, priority).run();
}

describe('list_tasks_due_today', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('includes overdue + due-within-24h, excludes future and done', async () => {
    await insertTaskRow('overdue', 'open', -2 * 3600_000, 2);
    await insertTaskRow('soon', 'in_progress', 3 * 3600_000, 1);
    await insertTaskRow('next-week', 'open', 5 * 24 * 3600_000, 1);
    await insertTaskRow('done-overdue', 'done', -1 * 3600_000, 1);
    await insertTaskRow('no-due', 'open', null, 1);

    const res = await reg().list_tasks_due_today({});
    const p = JSON.parse(res.content[0].text);
    const ids = p.tasks.map((t: any) => t.id).sort();
    expect(ids).toEqual(['overdue', 'soon']);
    expect(p.overdue_count).toBe(1);
  });

  it('orders by due_at then priority', async () => {
    await insertTaskRow('later', 'open', 6 * 3600_000, 1);
    await insertTaskRow('earlier', 'open', 1 * 3600_000, 4);
    const res = await reg().list_tasks_due_today({});
    const p = JSON.parse(res.content[0].text);
    expect(p.tasks.map((t: any) => t.id)).toEqual(['earlier', 'later']);
  });

  it('horizon_hours widens the window', async () => {
    await insertTaskRow('weekish', 'open', 5 * 24 * 3600_000, 1);
    const narrow = JSON.parse((await reg().list_tasks_due_today({})).content[0].text);
    expect(narrow.count).toBe(0);
    const wide = JSON.parse((await reg().list_tasks_due_today({ horizon_hours: 168 })).content[0].text);
    expect(wide.count).toBe(1);
  });
});
