import { env, SELF } from 'cloudflare:test';
import { OWNER_TASK_VIS } from '../src/auth/visibility.js';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { insertTask, getTaskById, getColumnById, listKanbanColumns } from '../src/db/queries.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function resetKanban() {
  await E.DB.exec('DELETE FROM kanban_columns');
  const seed = E.DB.prepare(
    `INSERT INTO kanban_columns (id, label, color, position, category, archived_at) VALUES (?,?,?,?,?,?)`
  );
  await E.DB.batch([
    seed.bind('col_aberto', 'A fazer', null, 1, 'open', null),
    seed.bind('col_progresso', 'Em progresso', null, 2, 'in_progress', null),
    seed.bind('col_concluido', 'Concluído', null, 3, 'done', null),
    seed.bind('col_cancelado', 'Cancelado', null, 4, 'canceled', 1),
  ]);
}

function jsonPost(path: string, body: unknown, ck?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (ck) headers.cookie = ck;
  return SELF.fetch(`https://x${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual' });
}

function formPost(path: string, fields: Record<string, string>, ck?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (ck) headers.cookie = ck;
  const body = new URLSearchParams(fields).toString();
  return SELF.fetch(`https://x${path}`, { method: 'POST', headers, body, redirect: 'manual' });
}

async function seedTask(id: string, status: string, columnId: string | null = null) {
  await insertTask(E, {
    id, title: `Task ${id}`, body: 'b', tldr: `Task ${id}`, domains: '["operations"]',
    status: status as any, due_at: null, priority: null, created_at: 1, updated_at: 1,
    column_id: columnId ?? undefined,
  });
}

describe('GET /app/tasks/data — payload de colunas dinâmicas (spec 51)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('devolve columns como array ordenado, com tasks agrupadas por coluna', async () => {
    await seedTask('t1', 'open');
    await seedTask('t2', 'in_progress');
    const res = await SELF.fetch('https://x/app/tasks/data', { headers: { accept: 'application/json', cookie: await cookie() } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(Array.isArray(data.columns)).toBe(true);
    // col_cancelado nasce arquivado → não aparece no board.
    expect(data.columns.map((c: any) => c.id)).toEqual(['col_aberto', 'col_progresso', 'col_concluido']);
    const open = data.columns.find((c: any) => c.id === 'col_aberto');
    const prog = data.columns.find((c: any) => c.id === 'col_progresso');
    expect(open.tasks.map((t: any) => t.id)).toEqual(['t1']);
    expect(prog.tasks.map((t: any) => t.id)).toEqual(['t2']);
  });

  it('task com column_id incoerente (drift de categoria) cai na coluna default do status', async () => {
    // FK impede column_id apontando pra coluna inexistente; simula o drift real:
    // column_id de uma coluna de OUTRA categoria (col_progresso) com status open.
    // O board deve realocar visualmente pra coluna default de open (col_aberto).
    await seedTask('orf', 'open');
    await E.DB.prepare(`UPDATE notes SET column_id = 'col_progresso' WHERE id = 'orf'`).run();
    const res = await SELF.fetch('https://x/app/tasks/data', { headers: { accept: 'application/json', cookie: await cookie() } });
    const data = (await res.json()) as any;
    const open = data.columns.find((c: any) => c.id === 'col_aberto');
    const prog = data.columns.find((c: any) => c.id === 'col_progresso');
    expect(open.tasks.map((t: any) => t.id)).toContain('orf');
    expect(prog.tasks.map((t: any) => t.id)).not.toContain('orf');
  });
});

describe('POST /app/tasks/move (spec 51)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('sem sessão nem Bearer: 401', async () => {
    await seedTask('t1', 'open');
    const res = await jsonPost('/app/tasks/move', { id: 't1', column_id: 'col_progresso' });
    expect(res.status).toBe(401);
  });

  it('move card pra coluna e persiste column_id + status = categoria', async () => {
    await seedTask('t1', 'open');
    const res = await jsonPost('/app/tasks/move', { id: 't1', column_id: 'col_progresso' }, await cookie());
    expect(res.status).toBe(200);
    const t = await getTaskById(E, 't1', OWNER_TASK_VIS);
    expect(t?.column_id).toBe('col_progresso');
    expect(t?.status).toBe('in_progress');
    expect(t?.completed_at).toBeNull();
  });

  it('mover pra coluna de categoria done stampa completed_at', async () => {
    await seedTask('t1', 'open');
    const res = await jsonPost('/app/tasks/move', { id: 't1', column_id: 'col_concluido' }, await cookie());
    expect(res.status).toBe(200);
    const t = await getTaskById(E, 't1', OWNER_TASK_VIS);
    expect(t?.status).toBe('done');
    expect(t?.completed_at).not.toBeNull();
  });

  it('coluna inexistente → 404', async () => {
    await seedTask('t1', 'open');
    const res = await jsonPost('/app/tasks/move', { id: 't1', column_id: 'col_nope' }, await cookie());
    expect(res.status).toBe(404);
  });

  it('resposta traz updated_at fresco (spec 52 — select de coluna no detalhe reusa como base otimista)', async () => {
    await seedTask('t1', 'open');
    const res = await jsonPost('/app/tasks/move', { id: 't1', column_id: 'col_progresso' }, await cookie());
    const data = (await res.json()) as any;
    expect(typeof data.updated_at).toBe('number');
    const t = await getTaskById(E, 't1', OWNER_TASK_VIS);
    expect(data.updated_at).toBe(t?.updated_at);
  });
});

describe('gestão de colunas via /app/config (spec 51)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('sem sessão: redireciona pro login (302)', async () => {
    // Form nativo (sem accept: application/json) — o middleware manda pro login.
    const res = await SELF.fetch('https://x/app/tasks/columns/create', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ label: 'X', category: 'open' }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toMatch(/\/app\/login/);
  });

  it('create: cria coluna e redireciona pra seção board', async () => {
    const res = await formPost('/app/tasks/columns/create', { label: 'Aguardando resposta', color: '#8b5cf6', category: 'in_progress' }, await cookie());
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('saved=board');
    const cols = await listKanbanColumns(E, true);
    const created = cols.find((c) => c.label === 'Aguardando resposta');
    expect(created).toBeTruthy();
    expect(created?.category).toBe('in_progress');
    expect(created?.color).toBe('#8b5cf6');
    expect(created?.id.startsWith('col_')).toBe(true);
  });

  it('create: categoria inválida → 400; cor inválida → 400', async () => {
    const ck = await cookie();
    expect((await formPost('/app/tasks/columns/create', { label: 'X', category: 'bogus' }, ck)).status).toBe(400);
    expect((await formPost('/app/tasks/columns/create', { label: 'X', category: 'open', color: 'roxo' }, ck)).status).toBe(400);
  });

  it('update: renomeia e recolore', async () => {
    const res = await formPost('/app/tasks/columns/update', { id: 'col_aberto', label: 'Backlog', color: '#22d3ee' }, await cookie());
    expect(res.status).toBe(302);
    const c = await getColumnById(E, 'col_aberto');
    expect(c?.label).toBe('Backlog');
    expect(c?.color).toBe('#22d3ee');
  });

  it('reorder: ↓ desce a coluna trocando com a vizinha', async () => {
    const res = await formPost('/app/tasks/columns/reorder', { id: 'col_aberto', direction: 'down' }, await cookie());
    expect(res.status).toBe(302);
    const active = await listKanbanColumns(E, false);
    expect(active.slice(0, 2).map((c) => c.id)).toEqual(['col_progresso', 'col_aberto']);
  });

  it('archive com tasks: exige destino, realoca e arquiva', async () => {
    const ck = await cookie();
    // coluna custom (não protegida) com 2 tasks
    await formPost('/app/tasks/columns/create', { label: 'Aguardando', category: 'open' }, ck);
    const wait = (await listKanbanColumns(E, true)).find((c) => c.label === 'Aguardando')!;
    await seedTask('t1', 'open', wait.id);
    await seedTask('t2', 'open', wait.id);

    // sem destino → 400
    expect((await formPost('/app/tasks/columns/archive', { id: wait.id, archived: '1' }, ck)).status).toBe(400);

    // com destino válido → realoca + arquiva
    const ok = await formPost('/app/tasks/columns/archive', { id: wait.id, archived: '1', to: 'col_aberto' }, ck);
    expect(ok.status).toBe(302);
    expect((await getColumnById(E, wait.id))?.archived_at).not.toBeNull();
    expect((await getTaskById(E, 't1', OWNER_TASK_VIS))?.column_id).toBe('col_aberto');
    expect((await getTaskById(E, 't2', OWNER_TASK_VIS))?.column_id).toBe('col_aberto');
  });

  it('archive: não arquiva col_aberto quando é a última coluna ativa de open', async () => {
    const res = await formPost('/app/tasks/columns/archive', { id: 'col_aberto', archived: '1' }, await cookie());
    expect(res.status).toBe(400);
    expect((await getColumnById(E, 'col_aberto'))?.archived_at).toBeNull();
  });

  it('unarchive col_cancelado: canceladas voltam a aparecer no board', async () => {
    const ck = await cookie();
    await seedTask('canc', 'canceled', 'col_cancelado');
    // antes: col_cancelado arquivado → não aparece
    let data = (await (await SELF.fetch('https://x/app/tasks/data', { headers: { accept: 'application/json', cookie: ck } })).json()) as any;
    expect(data.columns.map((c: any) => c.id)).not.toContain('col_cancelado');

    const res = await formPost('/app/tasks/columns/archive', { id: 'col_cancelado', archived: '0' }, ck);
    expect(res.status).toBe(302);

    data = (await (await SELF.fetch('https://x/app/tasks/data', { headers: { accept: 'application/json', cookie: ck } })).json()) as any;
    const canc = data.columns.find((c: any) => c.id === 'col_cancelado');
    expect(canc).toBeTruthy();
    expect(canc.tasks.map((t: any) => t.id)).toContain('canc');
  });
});

describe('SSR /app/tasks renderiza colunas do banco (spec 51)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('a página inclui as colunas custom (label + dropzone por column_id)', async () => {
    const ck = await cookie();
    await formPost('/app/tasks/columns/create', { label: 'Em revisão', category: 'in_progress' }, ck);
    const rev = (await listKanbanColumns(E, true)).find((c) => c.label === 'Em revisão')!;
    const res = await SELF.fetch('https://x/app/tasks', { headers: { cookie: ck } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Em revisão');
    expect(html).toContain(`data-dropzone="${rev.id}"`);
  });
});
