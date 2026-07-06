import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerSaveTask } from '../../src/mcp/tools/save-task.js';
import { registerUpdateTask } from '../../src/mcp/tools/update-task.js';
import { registerListTasks } from '../../src/mcp/tools/list-tasks.js';
import { registerGetTask } from '../../src/mcp/tools/get-task.js';
import {
  createTaskProject,
  setProjectArchived,
  countTaskProjects,
  getTaskById,
} from '../../src/db/queries.js';

const E = env as any;

function reg(register: (s: any, e: any) => void): any {
  const r: any = {};
  register({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
  return r;
}
const save = () => reg(registerSaveTask).save_task;
const upd = () => reg(registerUpdateTask).update_task;
const list = () => reg(registerListTasks).list_tasks;
const get = () => reg(registerGetTask).get_task;

const out = (res: any) => JSON.parse(res.content[0].text);

async function reset() {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM task_projects');
}

describe('save_task project — auto-create + dedupe case-insensitive', () => {
  beforeEach(reset);

  it('label novo auto-cria o projeto e vincula; response ecoa o projeto resolvido', async () => {
    const p = out(await save()({ title: 'Ligar', project: 'Cliente ACME' }));
    expect(p.project).toBeTruthy();
    expect(p.project.label).toBe('Cliente ACME');
    const row = await getTaskById(E, p.id);
    expect(row?.project_id).toBe(p.project.id);
    expect(await countTaskProjects(E)).toBe(1);
  });

  it('segunda chamada com caixa diferente REUSA o mesmo projeto (sem duplicar)', async () => {
    const a = out(await save()({ title: 'A', project: 'Cliente ACME' }));
    const b = out(await save()({ title: 'B', project: 'cliente acme' }));
    expect(b.project.id).toBe(a.project.id);
    expect(await countTaskProjects(E)).toBe(1);
  });

  it('project por id existente vincula sem criar novo', async () => {
    await createTaskProject(E, { id: 'proj_fixo', label: 'Fixo', color: null }, 1);
    const p = out(await save()({ title: 'X', project: 'proj_fixo' }));
    expect(p.project.id).toBe('proj_fixo');
    expect(await countTaskProjects(E)).toBe(1);
  });

  it('project = label de projeto ARQUIVADO → erro (não vincula, orienta desarquivar)', async () => {
    await createTaskProject(E, { id: 'proj_arq', label: 'Antigo', color: null }, 1);
    await setProjectArchived(E, 'proj_arq', 500);
    const res = await save()({ title: 'X', project: 'Antigo' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain('archived');
  });

  it('cap de 64 projetos bloqueia o auto-create com erro orientando arquivar', async () => {
    for (let i = 0; i < 64; i++) {
      await createTaskProject(E, { id: `proj_${i}`, label: `P${i}`, color: null }, i + 1);
    }
    const res = await save()({ title: 'X', project: 'Um a mais' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('cap');
    expect(await countTaskProjects(E)).toBe(64); // não criou o 65º
  });

  it('sem project → task sem projeto (não muda o comportamento existente)', async () => {
    const p = out(await save()({ title: 'Sem pasta' }));
    expect(p.project).toBeNull();
    expect((await getTaskById(E, p.id))?.project_id).toBeNull();
  });
});

describe('list_tasks project filter + get_task/list_tasks incluem project', () => {
  beforeEach(reset);

  it('filtra só as tasks do projeto e compõe com status; sem project não muda nada', async () => {
    await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: null }, 1);
    const inA1 = out(await save()({ title: 'A aberta', project: 'Alpha' }));
    out(await save()({ title: 'A feita', project: 'Alpha', status: 'done' }));
    out(await save()({ title: 'Fora do projeto' }));

    // sem filtro: todas as abertas aparecem (a com projeto + a sem)
    const all = out(await list()({}));
    const allIds = all.tasks.map((t: any) => t.id);
    expect(allIds).toContain(inA1.id);
    expect(all.count).toBe(2); // 2 abertas (a done não entra no default)

    // filtro por label: só as do projeto Alpha (aberta) — compõe com o default open
    const onlyA = out(await list()({ project: 'Alpha' }));
    expect(onlyA.tasks.map((t: any) => t.id)).toEqual([inA1.id]);

    // compõe com status done: a task done do projeto
    const doneA = out(await list()({ project: 'proj_a', status: ['done'] }));
    expect(doneA.tasks.every((t: any) => t.status === 'done')).toBe(true);
    expect(doneA.tasks.length).toBe(1);
  });

  it('project ref sem match → resultado vazio (não silencia como "todas")', async () => {
    out(await save()({ title: 'Qualquer' }));
    const res = out(await list()({ project: 'Inexistente' }));
    expect(res.count).toBe(0);
    expect(res.tasks).toEqual([]);
  });

  it('filtro por projeto compõe com tag', async () => {
    await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: null }, 1);
    const t1 = out(await save()({ title: 'Com tag', project: 'Alpha', tags: ['urgente'] }));
    out(await save()({ title: 'Sem tag', project: 'Alpha' }));
    const res = out(await list()({ project: 'Alpha', tag: 'urgente' }));
    expect(res.tasks.map((t: any) => t.id)).toEqual([t1.id]);
  });

  it('get_task e list_tasks retornam project {id,label}|null', async () => {
    await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: null }, 1);
    const withP = out(await save()({ title: 'Com', project: 'Alpha' }));
    const without = out(await save()({ title: 'Sem' }));

    const g1 = out(await get()({ id: withP.id }));
    expect(g1.project).toEqual({ id: 'proj_a', label: 'Alpha' });
    const g2 = out(await get()({ id: without.id }));
    expect(g2.project).toBeNull();

    const l = out(await list()({}));
    const lWith = l.tasks.find((t: any) => t.id === withP.id);
    const lWithout = l.tasks.find((t: any) => t.id === without.id);
    expect(lWith.project).toEqual({ id: 'proj_a', label: 'Alpha' });
    expect(lWithout.project).toBeNull();
  });
});

describe('update_task project — desvincular e projeto arquivado', () => {
  beforeEach(reset);

  it('project: "" desvincula a task', async () => {
    const p = out(await save()({ title: 'X', project: 'Alpha' }));
    expect(p.project).toBeTruthy();
    const u = out(await upd()({ id: p.id, project: '' }));
    expect(u.project).toBeNull();
    expect((await getTaskById(E, p.id))?.project_id).toBeNull();
  });

  it('project por label muda de projeto e ecoa o novo', async () => {
    const p = out(await save()({ title: 'X', project: 'Alpha' }));
    const u = out(await upd()({ id: p.id, project: 'Beta' }));
    expect(u.project.label).toBe('Beta');
  });

  it('label de projeto ARQUIVADO não vincula (erro); mas list_tasks lista o histórico', async () => {
    // task no projeto, depois arquiva o projeto
    const p = out(await save()({ title: 'Histórica', project: 'Alpha' }));
    const projId = p.project.id;
    await setProjectArchived(E, projId, 700);

    // tentar mover OUTRA task pro projeto arquivado → erro
    const other = out(await save()({ title: 'Outra' }));
    const res = await upd()({ id: other.id, project: 'Alpha' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain('archived');

    // list_tasks com o projeto arquivado ainda lista a task histórica (por id e label)
    const byId = out(await list()({ project: projId }));
    expect(byId.tasks.map((t: any) => t.id)).toContain(p.id);
    const byLabel = out(await list()({ project: 'Alpha' }));
    expect(byLabel.tasks.map((t: any) => t.id)).toContain(p.id);
  });
});
