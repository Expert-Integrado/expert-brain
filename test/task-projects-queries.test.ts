import { env } from 'cloudflare:test';
import { OWNER_TASK_VIS } from '../src/auth/visibility.js';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  insertTask,
  getTaskById,
  updateTask,
  listTaskProjects,
  getProjectById,
  getProjectByIdOrLabel,
  createTaskProject,
  updateTaskProject,
  reorderTaskProject,
  setProjectArchived,
  countTaskProjects,
  countTasksByProject,
  taskCountsByProject,
  type TaskRow,
} from '../src/db/queries.js';

const E = env as any;

function asTask(r: TaskRow | string): TaskRow {
  if (typeof r === 'string') throw new Error(`expected TaskRow, got sentinel '${r}'`);
  return r;
}

// Storage compartilhado no singleWorker: limpar notes ANTES de task_projects (uma nota
// pode referenciar project_id via FK) e zerar a tabela de projetos pra ficar hermético.
async function reset() {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM task_projects');
}

describe('migration 0011_task_projects (aditiva)', () => {
  beforeEach(reset);

  it('a tabela task_projects e o índice parcial existem', async () => {
    const tbl = await E.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_projects'`
    ).first();
    expect(tbl?.name).toBe('task_projects');
    const idx = await E.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notes_project'`
    ).first();
    expect(idx?.name).toBe('idx_notes_project');
  });

  it('task pré-existente (insert sem project) fica com project_id NULL', async () => {
    // Simula uma task anterior à 0011: insert cru sem a coluna project_id.
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,status,created_at,updated_at)
       VALUES ('old','t','b','t','["operations"]','task','open',1,1)`
    ).run();
    const row = await getTaskById(E, 'old', OWNER_TASK_VIS);
    expect(row?.project_id).toBeNull();
  });
});

describe('CRUD de projeto (spec 58)', () => {
  beforeEach(reset);

  it('create aloca position sequencial; countTaskProjects conta ativos+arquivados', async () => {
    const a = await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: '#8b5cf6' }, 100);
    const b = await createTaskProject(E, { id: 'proj_b', label: 'Beta', color: null }, 200);
    expect(a.position).toBe(1);
    expect(b.position).toBe(2);
    expect(await countTaskProjects(E)).toBe(2);
    await setProjectArchived(E, 'proj_b', 999);
    expect(await countTaskProjects(E)).toBe(2); // arquivado ainda conta pro cap
    expect((await listTaskProjects(E, false)).map((p) => p.id)).toEqual(['proj_a']);
    expect((await listTaskProjects(E, true)).map((p) => p.id)).toEqual(['proj_a', 'proj_b']);
  });

  it('update muda label/color; reorder troca vizinhos ativos', async () => {
    await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: null }, 1);
    await createTaskProject(E, { id: 'proj_b', label: 'Beta', color: null }, 2);
    expect(await updateTaskProject(E, 'proj_a', { label: 'Alfa', color: '#22d3ee' })).toBe(true);
    const a = await getProjectById(E, 'proj_a');
    expect(a?.label).toBe('Alfa');
    expect(a?.color).toBe('#22d3ee');

    expect(await reorderTaskProject(E, 'proj_b', 'up')).toBe(true);
    expect((await listTaskProjects(E, false)).map((p) => p.id)).toEqual(['proj_b', 'proj_a']);
    // já é o primeiro → sem vizinha
    expect(await reorderTaskProject(E, 'proj_b', 'up')).toBe(false);
  });
});

describe('getProjectByIdOrLabel — id/label case-insensitive Unicode, ativos vs arquivados', () => {
  beforeEach(reset);

  it('resolve por id exato e por label (case-insensitive, com acento)', async () => {
    await createTaskProject(E, { id: 'proj_edu', label: 'Educação', color: null }, 1);
    expect((await getProjectByIdOrLabel(E, 'proj_edu', true))?.id).toBe('proj_edu');
    expect((await getProjectByIdOrLabel(E, 'educação', true))?.id).toBe('proj_edu');
    expect((await getProjectByIdOrLabel(E, '  EDUCAÇÃO  ', true))?.id).toBe('proj_edu');
    expect(await getProjectByIdOrLabel(E, 'inexistente', true)).toBeNull();
  });

  it('activesOnly esconde arquivados; includeArchived (false) os enxerga', async () => {
    await createTaskProject(E, { id: 'proj_x', label: 'Antigo', color: null }, 1);
    await setProjectArchived(E, 'proj_x', 500);
    expect(await getProjectByIdOrLabel(E, 'Antigo', true)).toBeNull(); // ativos only
    expect((await getProjectByIdOrLabel(E, 'Antigo', false))?.id).toBe('proj_x'); // histórico
  });
});

describe('vínculo de task a projeto (insert/update)', () => {
  beforeEach(reset);

  it('insertTask grava project_id; updateTask troca e desvincula (null)', async () => {
    await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: null }, 1);
    await createTaskProject(E, { id: 'proj_b', label: 'Beta', color: null }, 2);
    await insertTask(E, {
      id: 't', title: 't', body: 't', tldr: 't', domains: '["operations"]',
      status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1, project_id: 'proj_a',
    });
    expect((await getTaskById(E, 't', OWNER_TASK_VIS))?.project_id).toBe('proj_a');

    let updated = asTask(await updateTask(E, 't', { project_id: 'proj_b' }, OWNER_TASK_VIS, 2));
    expect(updated.project_id).toBe('proj_b');
    updated = asTask(await updateTask(E, 't', { project_id: null }, OWNER_TASK_VIS, 3));
    expect(updated.project_id).toBeNull();
  });

  it('countTasksByProject e taskCountsByProject contam só tasks vivas do projeto', async () => {
    await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: null }, 1);
    await insertTask(E, { id: 't1', title: 't1', body: 'b', tldr: 't1', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1, project_id: 'proj_a' });
    await insertTask(E, { id: 't2', title: 't2', body: 'b', tldr: 't2', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1, project_id: 'proj_a' });
    await insertTask(E, { id: 't3', title: 't3', body: 'b', tldr: 't3', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1 });
    expect(await countTasksByProject(E, 'proj_a')).toBe(2);
    const map = await taskCountsByProject(E);
    expect(map.get('proj_a')).toBe(2);
  });

  it('arquivar projeto NÃO realoca as tasks (project_id fica)', async () => {
    await createTaskProject(E, { id: 'proj_a', label: 'Alpha', color: null }, 1);
    await insertTask(E, { id: 't', title: 't', body: 'b', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1, project_id: 'proj_a' });
    await setProjectArchived(E, 'proj_a', 900);
    expect((await getTaskById(E, 't', OWNER_TASK_VIS))?.project_id).toBe('proj_a'); // intocada
    expect(await countTasksByProject(E, 'proj_a')).toBe(1);
  });
});
