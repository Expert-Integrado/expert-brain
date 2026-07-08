import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import {
  insertTask,
  getTaskById,
  createTaskProject,
  setProjectArchived,
  getProjectById,
  listTaskProjects,
  countTaskProjects,
} from '../src/db/queries.js';

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

async function reset() {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM task_projects');
  await resetKanban();
}

function jsonPost(path: string, body: unknown, ck?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (ck) headers.cookie = ck;
  return SELF.fetch(`https://x${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual' });
}

function formPost(path: string, fields: Record<string, string>, ck?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (ck) headers.cookie = ck;
  const body = new URLSearchParams(fields).toString();
  return SELF.fetch(`https://x${path}`, { method: 'POST', headers, body, redirect: 'manual' });
}

async function seedTask(id: string, status: string, projectId: string | null = null) {
  await insertTask(E, {
    id, title: `Task ${id}`, body: 'b', tldr: `Task ${id}`, domains: '["operations"]',
    status: status as any, due_at: null, priority: null, created_at: 1, updated_at: 1,
    project_id: projectId,
  });
}

describe('GET /app/tasks/data — payload de projetos (spec 58)', () => {
  beforeEach(reset);

  it('devolve projects[] (ativos+arquivados com flag) e project_id por task', async () => {
    await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: '#8b5cf6' }, 1);
    await createTaskProject(E, { id: 'proj_z', label: 'Zeta', color: null }, 2);
    await setProjectArchived(E, 'proj_z', 999);
    await seedTask('t1', 'open', 'proj_a');
    await seedTask('t2', 'open');

    const res = await SELF.fetch('https://x/app/tasks/data', { headers: { accept: 'application/json', cookie: await cookie() } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(Array.isArray(data.projects)).toBe(true);
    const pa = data.projects.find((p: any) => p.id === 'proj_a');
    const pz = data.projects.find((p: any) => p.id === 'proj_z');
    expect(pa).toEqual({ id: 'proj_a', label: 'Alpha', color: '#8b5cf6', archived: false });
    expect(pz.archived).toBe(true);

    const open = data.columns.find((c: any) => c.id === 'col_aberto');
    const t1 = open.tasks.find((t: any) => t.id === 't1');
    const t2 = open.tasks.find((t: any) => t.id === 't2');
    expect(t1.project_id).toBe('proj_a');
    expect(t2.project_id).toBeNull();
    // Onda 8 (spec 70): search_text pronto pro filtro de busca do client —
    // título + corpo, minúsculo e sem acento (fold no server).
    expect(t1.search_text).toContain('task t1');
    expect(t1.search_text).toContain('b');
  });
});

describe('SSR /app/tasks — filtro e breadcrumb de projeto (spec 58 + Onda 5)', () => {
  beforeEach(reset);

  it('a página inclui o select de filtro com o projeto ativo e o breadcrumb no card', async () => {
    await createTaskProject(E, { id: 'proj_a', label: 'Projeto Alfa', color: '#8b5cf6' }, 1);
    await seedTask('t1', 'open', 'proj_a');
    const res = await SELF.fetch('https://x/app/tasks', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="task-project-filter"');
    expect(html).toContain('Projeto Alfa'); // no select e no breadcrumb
    // Onda 5 (specs/60-ux-reforma/66): o chip colorido no head virou breadcrumb
    // muted "Em <projeto>" abaixo do título (anatomia ClickUp).
    expect(html).toContain('task-card-crumb');
    expect(html).toContain('data-project="proj_a"');
    // Onda 8 (spec 70): busca + filtros de prioridade e tag no toolbar.
    expect(html).toContain('id="task-search"');
    expect(html).toContain('id="task-prio-filter"');
    expect(html).toContain('id="task-tag-filter"');
    expect(html).toContain('Todas as prioridades');
    expect(html).toContain('Todas as tags');
  });
});

describe('/app/tasks/update — patch.project_id (spec 58)', () => {
  beforeEach(reset);

  it('vincula a projeto ativo, desvincula com null, rejeita projeto arquivado', async () => {
    const ck = await cookie();
    await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: null }, 1);
    await createTaskProject(E, { id: 'proj_arq', label: 'Antigo', color: null }, 2);
    await setProjectArchived(E, 'proj_arq', 500);
    await seedTask('t1', 'open');

    // vincula
    let res = await jsonPost('/app/tasks/update', { id: 't1', patch: { project_id: 'proj_a' } }, ck);
    expect(res.status).toBe(200);
    expect((await getTaskById(E, 't1'))?.project_id).toBe('proj_a');

    // desvincula (null)
    res = await jsonPost('/app/tasks/update', { id: 't1', patch: { project_id: null } }, ck);
    expect(res.status).toBe(200);
    expect((await getTaskById(E, 't1'))?.project_id).toBeNull();

    // projeto arquivado → 404
    res = await jsonPost('/app/tasks/update', { id: 't1', patch: { project_id: 'proj_arq' } }, ck);
    expect(res.status).toBe(404);

    // projeto inexistente → 404
    res = await jsonPost('/app/tasks/update', { id: 't1', patch: { project_id: 'proj_nope' } }, ck);
    expect(res.status).toBe(404);
  });
});

describe('gestão de projetos via /app/config (spec 58)', () => {
  beforeEach(reset);

  it('sem sessão: redireciona pro login (302)', async () => {
    const res = await formPost('/app/tasks/projects/create', { label: 'X' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toMatch(/\/app\/login/);
  });

  it('create/update/reorder/archive/unarchive', async () => {
    const ck = await cookie();
    // create
    let res = await formPost('/app/tasks/projects/create', { label: 'Cliente ACME', color: '#22d3ee' }, ck);
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('saved=projects');
    let all = await listTaskProjects(E, true);
    const acme = all.find((p) => p.label === 'Cliente ACME')!;
    expect(acme.color).toBe('#22d3ee');
    expect(acme.id.startsWith('proj_')).toBe(true);

    // update (renomeia + recolora)
    res = await formPost('/app/tasks/projects/update', { id: acme.id, label: 'ACME Corp', color: '' }, ck);
    expect(res.status).toBe(302);
    let p = await getProjectById(E, acme.id);
    expect(p?.label).toBe('ACME Corp');
    expect(p?.color).toBeNull();

    // segundo projeto + reorder
    await formPost('/app/tasks/projects/create', { label: 'Beta' }, ck);
    const beta = (await listTaskProjects(E, true)).find((x) => x.label === 'Beta')!;
    res = await formPost('/app/tasks/projects/reorder', { id: beta.id, direction: 'up' }, ck);
    expect(res.status).toBe(302);
    expect((await listTaskProjects(E, false)).map((x) => x.id)).toEqual([beta.id, acme.id]);

    // archive → some dos ativos; unarchive → volta
    res = await formPost('/app/tasks/projects/archive', { id: acme.id, archived: '1' }, ck);
    expect(res.status).toBe(302);
    expect((await getProjectById(E, acme.id))?.archived_at).not.toBeNull();
    expect((await listTaskProjects(E, false)).map((x) => x.id)).not.toContain(acme.id);
    res = await formPost('/app/tasks/projects/archive', { id: acme.id, archived: '0' }, ck);
    expect((await getProjectById(E, acme.id))?.archived_at).toBeNull();
  });

  it('create respeita o cap de 64 (400)', async () => {
    const ck = await cookie();
    for (let i = 0; i < 64; i++) {
      await createTaskProject(E, { id: `proj_${i}`, label: `P${i}`, color: null }, i + 1);
    }
    const res = await formPost('/app/tasks/projects/create', { label: 'Excedente' }, ck);
    expect(res.status).toBe(400);
    expect(await countTaskProjects(E)).toBe(64);
  });

  it('a seção Projetos aparece em /app/config', async () => {
    await createTaskProject(E, { id: 'proj_a', label: 'MinhaPasta', color: null }, 1);
    const res = await SELF.fetch('https://x/app/config', { headers: { cookie: await cookie() } });
    const html = await res.text();
    expect(html).toContain('id="projects"');
    expect(html).toContain('MinhaPasta');
    expect(html).toContain('/app/tasks/projects/create');
  });
});

describe('arquivar projeto com tasks: tasks continuam no board (spec 58)', () => {
  beforeEach(reset);

  it('archive não realoca — a task continua no board com project_id', async () => {
    const ck = await cookie();
    await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: null }, 1);
    await seedTask('t1', 'open', 'proj_a');

    await formPost('/app/tasks/projects/archive', { id: 'proj_a', archived: '1' }, ck);

    // task intocada
    expect((await getTaskById(E, 't1'))?.project_id).toBe('proj_a');
    // ainda no board (coluna A fazer), com project_id no payload
    const data = (await (await SELF.fetch('https://x/app/tasks/data', { headers: { accept: 'application/json', cookie: ck } })).json()) as any;
    const open = data.columns.find((c: any) => c.id === 'col_aberto');
    const t1 = open.tasks.find((t: any) => t.id === 't1');
    expect(t1).toBeTruthy();
    expect(t1.project_id).toBe('proj_a');
    // o projeto arquivado aparece no payload com archived=true (pro chip esmaecido)
    const pa = data.projects.find((p: any) => p.id === 'proj_a');
    expect(pa.archived).toBe(true);
  });
});
