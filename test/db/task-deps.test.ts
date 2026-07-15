// Dependências entre tasks (blocked_by, spec 80-frota-agentes/93). Camada de dados
// da tabela filha `task_deps` (migration 0030). Cobre: add/remove, leitura nas duas
// direções (blockedBy / blocks), detecção de auto-referência e ciclo direto, batch de
// "está bloqueada" pro filtro available de list_tasks, e o não-cascateio do
// soft-delete (mesma convenção de task_subtasks/mentions).
import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTask, deleteNote } from '../../src/db/queries.js';
import {
  addTaskDep,
  removeTaskDep,
  listBlockedBy,
  listBlocks,
  isBlockedBatch,
  type AddDepResult,
} from '../../src/db/task-deps.js';

const E = env as any;

async function seedTask(id: string, status: 'open' | 'in_progress' | 'done' | 'canceled' = 'open') {
  await insertTask(E, {
    id, title: id, body: 'corpo', tldr: id, domains: '["operations"]',
    status, due_at: null, priority: null, created_at: 1000, updated_at: 1000,
  });
}

describe('task-deps (db — spec 93)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_deps');
    await E.DB.exec('DELETE FROM notes');
  });

  it('addTaskDep cria a dependência e listBlockedBy/listBlocks enxergam nas duas direções', async () => {
    await seedTask('t1');
    await seedTask('t2');
    const res = await addTaskDep(E, 't1', 't2', 'oauth:o@x', 2000);
    expect(res).toEqual<AddDepResult>({ ok: true });

    const blockedBy = await listBlockedBy(E, 't1');
    expect(blockedBy.map((t) => t.id)).toEqual(['t2']);

    const blocks = await listBlocks(E, 't2');
    expect(blocks.map((t) => t.id)).toEqual(['t1']);
  });

  it('rejeita auto-referência (task_id === depends_on_id)', async () => {
    await seedTask('t1');
    const res = await addTaskDep(E, 't1', 't1', null, 2000);
    expect(res).toEqual<AddDepResult>({ ok: false, error: 'self' });
    expect(await listBlockedBy(E, 't1')).toEqual([]);
  });

  it('rejeita ciclo direto (A depende de B que já depende de A)', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await addTaskDep(E, 't2', 't1', null, 2000); // t2 bloqueada por t1
    const res = await addTaskDep(E, 't1', 't2', null, 2100); // tentaria t1 bloqueada por t2 → ciclo
    expect(res).toEqual<AddDepResult>({ ok: false, error: 'cycle' });
  });

  it('dependência duplicada é idempotente (UNIQUE), não duplica linha', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await addTaskDep(E, 't1', 't2', null, 2000);
    const res2 = await addTaskDep(E, 't1', 't2', null, 2100);
    expect(res2).toEqual<AddDepResult>({ ok: true });
    const blockedBy = await listBlockedBy(E, 't1');
    expect(blockedBy).toHaveLength(1);
  });

  it('removeTaskDep remove o par; listBlockedBy some', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await addTaskDep(E, 't1', 't2', null, 2000);
    const removed = await removeTaskDep(E, 't1', 't2');
    expect(removed).toBe(true);
    expect(await listBlockedBy(E, 't1')).toEqual([]);
  });

  it('removeTaskDep de par inexistente devolve false', async () => {
    await seedTask('t1');
    await seedTask('t2');
    expect(await removeTaskDep(E, 't1', 't2')).toBe(false);
  });

  it('isBlockedBatch: bloqueada enquanto QUALQUER bloqueadora não está done/canceled', async () => {
    await seedTask('t1');
    await seedTask('t2', 'open');
    await seedTask('t3', 'done');
    await addTaskDep(E, 't1', 't2', null, 2000); // t1 bloqueada por t2 (aberta)
    const map1 = await isBlockedBatch(E, ['t1']);
    expect(map1.get('t1')).toBe(true);

    await removeTaskDep(E, 't1', 't2');
    await addTaskDep(E, 't1', 't3', null, 2100); // t1 bloqueada só por t3 (done)
    const map2 = await isBlockedBatch(E, ['t1']);
    expect(map2.get('t1')).toBe(false);
  });

  it('task sem dependências não aparece no map de isBlockedBatch (ausente = não bloqueada)', async () => {
    await seedTask('t1');
    const map = await isBlockedBatch(E, ['t1']);
    expect(map.get('t1')).toBeUndefined();
  });

  it('bloqueadora soft-deletada some de listBlockedBy (JOIN filtra deleted_at)', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await addTaskDep(E, 't1', 't2', null, 2000);
    await deleteNote(E, 't2', null);
    expect(await listBlockedBy(E, 't1')).toEqual([]);
  });
});
