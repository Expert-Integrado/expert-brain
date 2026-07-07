import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTask, replaceTags } from '../../src/db/queries.js';
import * as queries from '../../src/db/queries.js';
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

  it('status:[done] returns closed tasks WITHOUT include_closed', async () => {
    await seedTask('o', 'open');
    await seedTask('d', 'done');
    await seedTask('c', 'canceled');
    const res = await reg().list_tasks({ status: ['done'] });
    const p = JSON.parse(res.content[0].text);
    expect(p.tasks.map((t: any) => t.id)).toEqual(['d']);
  });

  it('tag filter is case-insensitive both ways', async () => {
    // Tag gravada lowercase (normalização); filtro passa maiúscula.
    await seedTask('a', 'open', { tags: ['Cliente-X'] });
    const res = await reg().list_tasks({ tag: 'cliente-x' });
    const p = JSON.parse(res.content[0].text);
    expect(p.tasks.map((t: any) => t.id)).toEqual(['a']);
    // e o inverso: tag gravada lowercase, filtro maiúsculo
    const res2 = await reg().list_tasks({ tag: 'CLIENTE-X' });
    const p2 = JSON.parse(res2.content[0].text);
    expect(p2.tasks.map((t: any) => t.id)).toEqual(['a']);
  });

  it('query does full-text search over tasks (incl. closed) and no knowledge notes', async () => {
    const now = Date.now();
    await insertTask(E, { id: 'q1', title: 'Enviar relatório mensal', body: 'corpo', tldr: 'x', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
    await insertTask(E, { id: 'q2', title: 'Relatório trimestral', body: 'corpo', tldr: 'x', domains: '["operations"]', status: 'done', due_at: null, priority: null, created_at: now, updated_at: now });
    await insertTask(E, { id: 'other', title: 'Ligar para fornecedor', body: 'corpo', tldr: 'x', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
    // uma nota de conhecimento com a palavra — NÃO pode aparecer
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at) VALUES ('k','Relatório de pesquisa','b','tl','["product"]','concept',1,1,null)`
    ).run();
    const res = await reg().list_tasks({ query: 'relatório' });
    const p = JSON.parse(res.content[0].text);
    const ids = p.tasks.map((t: any) => t.id).sort();
    // abertas E fechadas casam; nota de conhecimento e 'other' não
    expect(ids).toContain('q1');
    expect(ids).toContain('q2');
    expect(ids).not.toContain('other');
    expect(ids).not.toContain('k');
  });

  it('query full-text search does not error on FTS5-significant punctuation in the query string', async () => {
    // sanitizeFtsQuery já strippava pontuação do texto de busca corretamente;
    // este teste cobre o mesmo tipo de payload do regression de save_task
    // (título pontuado), agora do lado da leitura (list_tasks query=...).
    const now = Date.now();
    await insertTask(E, { id: 'q1', title: 'Foo: bar (baz) — qux!', body: 'corpo', tldr: 'x', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: now, updated_at: now });
    const res = await reg().list_tasks({ query: 'Foo: bar (baz) — qux!' });
    expect(res.isError).toBeUndefined();
    const p = JSON.parse(res.content[0].text);
    expect(p.tasks.map((t: any) => t.id)).toContain('q1');
  });

  it('marca stale: true so em task ativa sem update ha 60+ dias (spec 32)', async () => {
    const now = Date.now();
    const DAY = 86_400_000;
    const mk = (id: string, status: string, updatedAt: number) =>
      insertTask(E, {
        id, title: id, body: id, tldr: id, domains: '["operations"]',
        status: status as any, due_at: null, priority: null, created_at: updatedAt, updated_at: updatedAt,
      });
    await mk('velha-open', 'open', now - 90 * DAY);
    await mk('velha-inprog', 'in_progress', now - 90 * DAY);
    await mk('fresca', 'open', now - 5 * DAY);
    const res = await reg().list_tasks({});
    const p = JSON.parse(res.content[0].text);
    const byId = Object.fromEntries(p.tasks.map((t: any) => [t.id, t.stale]));
    expect(byId['velha-open']).toBe(true);
    expect(byId['velha-inprog']).toBe(true);
    expect(byId['fresca']).toBe(false);
  });

  it('without a tag filter, getTagsForNotes is called only for sliced items', async () => {
    // Seed mais tasks que o limit; espia getTagsForNotes e confere que recebe só `limit` ids.
    for (let i = 0; i < 6; i++) await seedTask(`t${i}`, 'open');
    const spy = vi.spyOn(queries, 'getTagsForNotes');
    await reg().list_tasks({ limit: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    const idsArg = spy.mock.calls[0][1] as string[];
    expect(idsArg.length).toBe(2);
    spy.mockRestore();
  });
});
