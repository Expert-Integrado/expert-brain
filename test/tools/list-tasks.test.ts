import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTask, replaceTags } from '../../src/db/queries.js';
import { registerListTasks } from '../../src/mcp/tools/list-tasks.js';

const E = env as any;

function reg() {
  const r: any = {};
  registerListTasks({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
  return r;
}

async function seedTask(id: string, status: string, opts: { due_at?: number | null; tags?: string[] } = {}) {
  const now = Date.now();
  await insertTask(E, {
    id, title: id, body: id, tldr: id, domains: '["operations"]',
    status: status as any, due_at: opts.due_at ?? null, priority: null, created_at: now, updated_at: now,
  });
  if (opts.tags) await replaceTags(E, id, opts.tags);
}

describe('list_tasks', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('returns open+in_progress by default, INCLUDING tasks without due (the gap list_tasks_due_today has)', async () => {
    await seedTask('sem-due', 'open', { due_at: null });
    await seedTask('em-prog', 'in_progress', { due_at: Date.now() + 99 * 24 * 3600_000 }); // 99 dias no futuro
    await seedTask('fechada', 'done');
    const res = await reg().list_tasks({});
    const p = JSON.parse(res.content[0].text);
    const ids = p.tasks.map((t: any) => t.id).sort();
    expect(ids).toEqual(['em-prog', 'sem-due']); // sem-due aparece; done NAO (default exclui closed)
  });

  it('include_closed traz done/canceled', async () => {
    await seedTask('o', 'open');
    await seedTask('d', 'done');
    const res = await reg().list_tasks({ include_closed: true });
    const p = JSON.parse(res.content[0].text);
    expect(p.tasks.map((t: any) => t.id).sort()).toEqual(['d', 'o']);
  });

  it('filtra por status', async () => {
    await seedTask('o', 'open');
    await seedTask('ip', 'in_progress');
    const res = await reg().list_tasks({ status: ['in_progress'] });
    const p = JSON.parse(res.content[0].text);
    expect(p.tasks.map((t: any) => t.id)).toEqual(['ip']);
  });

  it('filtra por tag e devolve as tags de cada task', async () => {
    await seedTask('pc', 'open', { tags: ['maquina:pc-principal', 'projeto-x'] });
    await seedTask('vps', 'open', { tags: ['maquina:vps'] });
    const res = await reg().list_tasks({ tag: 'maquina:pc-principal' });
    const p = JSON.parse(res.content[0].text);
    expect(p.tasks.map((t: any) => t.id)).toEqual(['pc']);
    expect(p.tasks[0].tags.sort()).toEqual(['maquina:pc-principal', 'projeto-x']);
  });
});
