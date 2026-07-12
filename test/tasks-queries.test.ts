import { env } from 'cloudflare:test';
import { OWNER_TASK_VIS } from '../src/auth/visibility.js';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  insertTask, listActiveTasks, listRecentClosedTasks, setTaskStatus, updateTask, ftsSearch,
  ftsSearchTasks, insertTags, getTagsByNote,
  type TaskRow, type UpdateResult,
} from '../src/db/queries.js';
import { registerStats } from '../src/mcp/tools/stats.js';

const E = env as any;

// updateTask agora devolve TaskRow | 'not-found' | 'conflict' (versionamento
// otimista opt-in). Nos testes de sucesso, narrow pro TaskRow (falha ruidosa se
// vier um sentinel inesperado).
function asTask(r: UpdateResult): TaskRow {
  if (typeof r === 'string') throw new Error(`expected TaskRow, got sentinel '${r}'`);
  return r;
}

async function knowledgeNote(id: string, kind: string, domains = '["product"]') {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,1,1,null)`
  ).bind(id, `Note ${id}`, 'searchable body alpha', 'tldr', domains, kind).run();
}

describe('task queries', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('listActiveTasks returns open+in_progress ordered by due then priority', async () => {
    const now = Date.now();
    await insertTask(E, { id: 'a', title: 'a', body: 'a', tldr: 'a', domains: '["operations"]', status: 'open', due_at: now + 5000, priority: 1, created_at: now, updated_at: now });
    await insertTask(E, { id: 'b', title: 'b', body: 'b', tldr: 'b', domains: '["operations"]', status: 'in_progress', due_at: now + 1000, priority: 3, created_at: now, updated_at: now });
    await insertTask(E, { id: 'c', title: 'c', body: 'c', tldr: 'c', domains: '["operations"]', status: 'done', due_at: now, priority: 1, created_at: now, updated_at: now });
    const active = await listActiveTasks(E, OWNER_TASK_VIS);
    expect(active.map((t) => t.id)).toEqual(['b', 'a']); // b due sooner; c is done (excluded)
  });

  it('setTaskStatus done sets completed_at, reopen clears it', async () => {
    const now = Date.now();
    await insertTask(E, { id: 't', title: 't', body: 't', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
    expect(await setTaskStatus(E, 't', 'done', now)).toBe(true);
    let row = await E.DB.prepare(`SELECT status, completed_at FROM notes WHERE id='t'`).first();
    expect(row.status).toBe('done');
    expect(row.completed_at).toBe(now);
    expect(await setTaskStatus(E, 't', 'open', now + 1)).toBe(true);
    row = await E.DB.prepare(`SELECT status, completed_at FROM notes WHERE id='t'`).first();
    expect(row.status).toBe('open');
    expect(row.completed_at).toBeNull();
  });

  it('setTaskStatus returns false for a non-task id', async () => {
    await knowledgeNote('k', 'concept');
    expect(await setTaskStatus(E, 'k', 'done', Date.now())).toBe(false);
  });

  it('updateTask patches only the passed fields and leaves the rest', async () => {
    const now = Date.now();
    await insertTask(E, { id: 'u', title: 'old', body: 'old body', tldr: 'old', domains: '["operations"]', status: 'open', due_at: now + 1000, priority: 3, created_at: now, updated_at: now });
    const updated = asTask(await updateTask(E, 'u', { priority: 1 }, OWNER_TASK_VIS, now + 5));
    expect(updated.priority).toBe(1);
    expect(updated.title).toBe('old');        // untouched
    expect(updated.body).toBe('old body');    // untouched
    expect(updated.due_at).toBe(now + 1000);  // untouched
    expect(updated.updated_at).toBe(now + 5);
  });

  it('updateTask title also refreshes tldr', async () => {
    const now = Date.now();
    await insertTask(E, { id: 'u', title: 'old', body: 'b', tldr: 'old', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
    const updated = asTask(await updateTask(E, 'u', { title: 'new title' }, OWNER_TASK_VIS, now + 1));
    expect(updated.title).toBe('new title');
    expect(updated.tldr).toBe('new title');
  });

  it('updateTask can clear due_at with explicit null', async () => {
    const now = Date.now();
    await insertTask(E, { id: 'u', title: 't', body: 'b', tldr: 't', domains: '["operations"]', status: 'open', due_at: now + 1000, priority: null, created_at: now, updated_at: now });
    const updated = asTask(await updateTask(E, 'u', { due_at: null }, OWNER_TASK_VIS, now + 1));
    expect(updated.due_at).toBeNull();
  });

  it('updateTask status done stamps completed_at; reopen clears it', async () => {
    const now = Date.now();
    await insertTask(E, { id: 'u', title: 't', body: 'b', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
    let updated = asTask(await updateTask(E, 'u', { status: 'done' }, OWNER_TASK_VIS, now + 1));
    expect(updated.status).toBe('done');
    expect(updated.completed_at).toBe(now + 1);
    updated = asTask(await updateTask(E, 'u', { status: 'in_progress' }, OWNER_TASK_VIS, now + 2));
    expect(updated.status).toBe('in_progress');
    expect(updated.completed_at).toBeNull();
  });

  it("updateTask returns 'not-found' for a non-task id", async () => {
    await knowledgeNote('k', 'concept');
    expect(await updateTask(E, 'k', { priority: 1 }, OWNER_TASK_VIS, Date.now())).toBe('not-found');
    expect(await updateTask(E, 'missing', { priority: 1 }, OWNER_TASK_VIS, Date.now())).toBe('not-found');
  });

  it('updateTask with tags replaces the set and preserves reserved dedupe: tags (spec 52)', async () => {
    const now = Date.now();
    await insertTask(E, { id: 'u', title: 't', body: 'b', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
    await insertTags(E, 'u', ['dedupe:k1', 'old-tag']);
    asTask(await updateTask(E, 'u', { tags: ['new-tag'] }, OWNER_TASK_VIS, now + 1));
    const tags = await getTagsByNote(E, 'u');
    expect(tags.sort()).toEqual(['dedupe:k1', 'new-tag']);
  });

  it('updateTask with tags-only patch still bumps updated_at', async () => {
    const now = Date.now();
    await insertTask(E, { id: 'u', title: 't', body: 'b', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
    const updated = asTask(await updateTask(E, 'u', { tags: ['x'] }, OWNER_TASK_VIS, now + 7));
    expect(updated.updated_at).toBe(now + 7);
    expect(await getTagsByNote(E, 'u')).toEqual(['x']);
  });

  it('listRecentClosedTasks caps and returns done/canceled', async () => {
    const now = Date.now();
    await insertTask(E, { id: 'd1', title: 'd1', body: 'b', tldr: 'd1', domains: '["operations"]', status: 'done', due_at: null, priority: null, created_at: now, updated_at: now });
    await insertTask(E, { id: 'x1', title: 'x1', body: 'b', tldr: 'x1', domains: '["operations"]', status: 'canceled', due_at: null, priority: null, created_at: now, updated_at: now });
    await insertTask(E, { id: 'o1', title: 'o1', body: 'b', tldr: 'o1', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
    const closed = await listRecentClosedTasks(E, 100, OWNER_TASK_VIS);
    expect(closed.map((t) => t.id).sort()).toEqual(['d1', 'x1']);
  });
});

describe('tasks excluded from knowledge read paths', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    const now = Date.now();
    await knowledgeNote('k1', 'concept');
    await insertTask(E, { id: 'task1', title: 'searchable body alpha task', body: 'searchable body alpha', tldr: 'searchable body alpha task', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
  });

  it('ftsSearch does not return tasks', async () => {
    const hits = await ftsSearch(E, 'alpha', 10);
    expect(hits.map((h) => h.id)).toContain('k1');
    expect(hits.map((h) => h.id)).not.toContain('task1');
  });

  it('ftsSearchTasks returns ONLY tasks (mirror of ftsSearch)', async () => {
    // 'alpha' aparece no corpo tanto da nota de conhecimento quanto da task.
    const hits = await ftsSearchTasks(E, 'alpha', 10, OWNER_TASK_VIS);
    expect(hits.map((h) => h.id)).toContain('task1');
    expect(hits.map((h) => h.id)).not.toContain('k1');
  });

  it('stats total_notes excludes tasks', async () => {
    const r: any = {};
    registerStats({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
    const p = JSON.parse((await r.stats({})).content[0].text);
    expect(p.total_notes).toBe(1); // só a nota de conhecimento
    expect(p.notes_by_kind.find((k: any) => k.kind === 'task')).toBeUndefined();
  });
});
