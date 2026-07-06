import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  insertTask,
  setTaskStatus,
  updateTask,
  completeTask,
  listKanbanColumns,
  getColumnById,
  defaultColumnForCategory,
  resolveTaskColumn,
  moveTaskToColumn,
  reassignColumn,
  createKanbanColumn,
  updateKanbanColumn,
  reorderKanbanColumn,
  setColumnArchived,
  countTasksInColumn,
  countActiveColumnsInCategory,
  getTaskById,
  type TaskRow,
} from '../src/db/queries.js';
import { registerGetTask } from '../src/mcp/tools/get-task.js';
import { registerListTasks } from '../src/mcp/tools/list-tasks.js';

const E = env as any;

// Reseta kanban_columns pros 4 seeds canônicos (a migration já rodou, mas o storage
// é compartilhado entre arquivos no singleWorker — deixar hermético). col_cancelado
// nasce arquivado, espelhando a migration 0009.
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

function asTask(r: TaskRow | string): TaskRow {
  if (typeof r === 'string') throw new Error(`expected TaskRow, got sentinel '${r}'`);
  return r;
}

async function seedTaskRaw(id: string, status: string, columnId: string | null) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,column_id,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?, 'task', ?, NULL, NULL, NULL, ?, 1, 1, NULL)`
  ).bind(id, `Task ${id}`, 'body', `Task ${id}`, '["operations"]', status, columnId).run();
}

describe('kanban_columns — schema, seeds e backfill (spec 51)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('os 4 seeds existem; col_cancelado nasce arquivado, o resto ativo', async () => {
    const all = await listKanbanColumns(E, true);
    expect(all.map((c) => c.id)).toEqual(['col_aberto', 'col_progresso', 'col_concluido', 'col_cancelado']);
    const active = await listKanbanColumns(E, false);
    expect(active.map((c) => c.id)).toEqual(['col_aberto', 'col_progresso', 'col_concluido']);
    expect((await getColumnById(E, 'col_cancelado'))?.archived_at).not.toBeNull();
  });

  it('backfill mapeia os 4 status pros 4 seeds SEM tocar status/due/priority', async () => {
    // Tasks pre-migration: column_id NULL. Roda o MESMO UPDATE de backfill da 0009.
    await seedTaskRaw('t-open', 'open', null);
    await seedTaskRaw('t-prog', 'in_progress', null);
    await seedTaskRaw('t-done', 'done', null);
    await seedTaskRaw('t-canc', 'canceled', null);
    await E.DB.prepare(
      `UPDATE notes SET column_id = 'col_' || CASE status
           WHEN 'open' THEN 'aberto'
           WHEN 'in_progress' THEN 'progresso'
           WHEN 'done' THEN 'concluido'
           WHEN 'canceled' THEN 'cancelado'
         END
         WHERE kind = 'task' AND status IS NOT NULL AND column_id IS NULL`
    ).run();
    const rows = await E.DB.prepare(`SELECT id, status, column_id FROM notes WHERE kind='task' ORDER BY id`).all();
    const byId = Object.fromEntries(rows.results.map((r: any) => [r.id, r]));
    expect(byId['t-open'].column_id).toBe('col_aberto');
    expect(byId['t-prog'].column_id).toBe('col_progresso');
    expect(byId['t-done'].column_id).toBe('col_concluido');
    expect(byId['t-canc'].column_id).toBe('col_cancelado');
    // status intocado.
    expect(byId['t-open'].status).toBe('open');
    expect(byId['t-canc'].status).toBe('canceled');
  });
});

describe('resolução de coluna e defaults (spec 51)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('defaultColumnForCategory devolve a ativa de menor position; custom não rouba o default', async () => {
    // Coluna custom in_progress nasce em position alta (max+1) — não vira default.
    await createKanbanColumn(E, { id: 'col_wait', label: 'Aguardando', color: null, category: 'in_progress' });
    expect((await defaultColumnForCategory(E, 'open'))?.id).toBe('col_aberto');
    expect((await defaultColumnForCategory(E, 'in_progress'))?.id).toBe('col_progresso');
  });

  it('defaultColumnForCategory cai no seed arquivado quando não há coluna ativa (canceled)', async () => {
    expect((await defaultColumnForCategory(E, 'canceled'))?.id).toBe('col_cancelado');
  });

  it('resolveTaskColumn: column_id órfão cai no default da categoria do status', () => {
    const cols = [
      { id: 'col_aberto', label: 'A fazer', color: null, position: 1, category: 'open' as const, archived_at: null },
      { id: 'col_progresso', label: 'Em progresso', color: null, position: 2, category: 'in_progress' as const, archived_at: null },
    ];
    const orphan = resolveTaskColumn({ column_id: 'col_ja_deletada', status: 'open' }, cols);
    expect(orphan?.id).toBe('col_aberto');
    const nullCol = resolveTaskColumn({ column_id: null, status: 'in_progress' }, cols);
    expect(nullCol?.id).toBe('col_progresso');
  });
});

describe('escrita de task realoca column_id pela categoria (spec 51)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('insertTask aloca a coluna default da categoria do status', async () => {
    await insertTask(E, { id: 'a', title: 'a', body: 'a', tldr: 'a', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1 });
    expect((await getTaskById(E, 'a'))?.column_id).toBe('col_aberto');
    await insertTask(E, { id: 'd', title: 'd', body: 'd', tldr: 'd', domains: '["operations"]', status: 'done', due_at: null, priority: null, created_at: 1, updated_at: 1 });
    expect((await getTaskById(E, 'd'))?.column_id).toBe('col_concluido');
  });

  it('setTaskStatus realoca column_id e mantém completed_at coerente', async () => {
    await insertTask(E, { id: 't', title: 't', body: 't', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1 });
    await setTaskStatus(E, 't', 'done', 500);
    let row = await getTaskById(E, 't');
    expect(row?.column_id).toBe('col_concluido');
    expect(row?.completed_at).toBe(500);
    await setTaskStatus(E, 't', 'open', 600);
    row = await getTaskById(E, 't');
    expect(row?.column_id).toBe('col_aberto');
    expect(row?.completed_at).toBeNull();
  });

  it('updateTask por status realoca pra coluna default da nova categoria', async () => {
    await insertTask(E, { id: 't', title: 't', body: 't', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1 });
    const updated = asTask(await updateTask(E, 't', { status: 'in_progress' }, 700));
    expect(updated.status).toBe('in_progress');
    expect(updated.column_id).toBe('col_progresso');
  });

  it('completeTask realoca pra coluna default de done', async () => {
    await insertTask(E, { id: 't', title: 't', body: 't', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1 });
    const done = asTask(await completeTask(E, 't', 800));
    expect(done.status).toBe('done');
    expect(done.column_id).toBe('col_concluido');
  });
});

describe('moveTaskToColumn — invariante status↔categoria (spec 51)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('mover pra coluna custom seta column_id + status = categoria; done stampa completed_at', async () => {
    await createKanbanColumn(E, { id: 'col_wait', label: 'Aguardando', color: '#8b5cf6', category: 'in_progress' });
    await insertTask(E, { id: 't', title: 't', body: 't', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1 });

    let r = asTask(await moveTaskToColumn(E, 't', 'col_wait', 1000));
    expect(r.column_id).toBe('col_wait');
    expect(r.status).toBe('in_progress');
    expect(r.completed_at).toBeNull();

    r = asTask(await moveTaskToColumn(E, 't', 'col_concluido', 2000));
    expect(r.status).toBe('done');
    expect(r.completed_at).toBe(2000);

    // reabrir limpa completed_at
    r = asTask(await moveTaskToColumn(E, 't', 'col_aberto', 3000));
    expect(r.status).toBe('open');
    expect(r.completed_at).toBeNull();
  });

  it('sentinelas: task inexistente e coluna inexistente', async () => {
    await insertTask(E, { id: 't', title: 't', body: 't', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1 });
    expect(await moveTaskToColumn(E, 't', 'col_nope', 1)).toBe('column-not-found');
    expect(await moveTaskToColumn(E, 'ghost', 'col_aberto', 1)).toBe('not-found');
  });
});

describe('CRUD de coluna e realocação (spec 51)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('create aloca position = max+1; update muda label/color; reorder troca vizinhas', async () => {
    const created = await createKanbanColumn(E, { id: 'col_x', label: 'Revisão', color: '#22d3ee', category: 'open' });
    expect(created.position).toBe(5); // max seed é 4
    await updateKanbanColumn(E, 'col_x', { label: 'Em revisão', color: null });
    const c = await getColumnById(E, 'col_x');
    expect(c?.label).toBe('Em revisão');
    expect(c?.color).toBeNull();

    // reorder: col_progresso (pos2) sobe → troca com col_aberto (pos1).
    const before = await listKanbanColumns(E, false);
    expect(before.slice(0, 2).map((c) => c.id)).toEqual(['col_aberto', 'col_progresso']);
    expect(await reorderKanbanColumn(E, 'col_progresso', 'up')).toBe(true);
    const after = await listKanbanColumns(E, false);
    expect(after.slice(0, 2).map((c) => c.id)).toEqual(['col_progresso', 'col_aberto']);
    // primeira coluna não sobe mais (sem vizinha)
    expect(await reorderKanbanColumn(E, 'col_progresso', 'up')).toBe(false);
  });

  it('reassignColumn move as tasks e archive esconde a coluna', async () => {
    await createKanbanColumn(E, { id: 'col_wait', label: 'Aguardando', color: null, category: 'open' });
    await insertTask(E, { id: 't1', title: 't1', body: 't1', tldr: 't1', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1, column_id: 'col_wait' });
    await insertTask(E, { id: 't2', title: 't2', body: 't2', tldr: 't2', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1, column_id: 'col_wait' });
    expect(await countTasksInColumn(E, 'col_wait')).toBe(2);

    const moved = await reassignColumn(E, 'col_wait', 'col_aberto');
    expect(moved).toBe(2);
    expect(await countTasksInColumn(E, 'col_wait')).toBe(0);
    expect(await countTasksInColumn(E, 'col_aberto')).toBe(2);

    await setColumnArchived(E, 'col_wait', 999);
    expect((await getColumnById(E, 'col_wait'))?.archived_at).toBe(999);
    expect((await listKanbanColumns(E, false)).map((c) => c.id)).not.toContain('col_wait');
  });

  it('countActiveColumnsInCategory reflete arquivamento', async () => {
    expect(await countActiveColumnsInCategory(E, 'open')).toBe(1);
    await createKanbanColumn(E, { id: 'col_o2', label: 'Outra', color: null, category: 'open' });
    expect(await countActiveColumnsInCategory(E, 'open')).toBe(2);
    await setColumnArchived(E, 'col_o2', 1);
    expect(await countActiveColumnsInCategory(E, 'open')).toBe(1);
  });
});

describe('contrato MCP: get_task / list_tasks retornam column (spec 51)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  function regGet() {
    const r: any = {};
    registerGetTask({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
    return r;
  }
  function regList() {
    const r: any = {};
    registerListTasks({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
    return r;
  }

  it('get_task inclui column {id,label} da coluna alocada', async () => {
    await createKanbanColumn(E, { id: 'col_wait', label: 'Aguardando', color: null, category: 'in_progress' });
    await insertTask(E, { id: 't', title: 't', body: 't', tldr: 't', domains: '["operations"]', status: 'in_progress', due_at: null, priority: null, created_at: 1, updated_at: 1, column_id: 'col_wait' });
    const p = JSON.parse((await regGet().get_task({ id: 't' })).content[0].text);
    expect(p.column).toEqual({ id: 'col_wait', label: 'Aguardando' });
  });

  it('list_tasks inclui column e reflete realocação por update de status', async () => {
    await insertTask(E, { id: 't', title: 't', body: 't', tldr: 't', domains: '["operations"]', status: 'open', due_at: null, priority: null, created_at: 1, updated_at: 1 });
    let p = JSON.parse((await regList().list_tasks({})).content[0].text);
    expect(p.tasks[0].column).toEqual({ id: 'col_aberto', label: 'A fazer' });
    // muda status por MCP → realoca coluna default da nova categoria
    await updateTask(E, 't', { status: 'in_progress' }, 500);
    p = JSON.parse((await regList().list_tasks({})).content[0].text);
    expect(p.tasks[0].column).toEqual({ id: 'col_progresso', label: 'Em progresso' });
  });
});
