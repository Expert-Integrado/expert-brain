import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerSaveTask } from '../../src/mcp/tools/save-task.js';
import { registerUpdateTask } from '../../src/mcp/tools/update-task.js';
import { createKanbanColumn } from '../../src/db/queries.js';

const E = env as any;

// Parâmetro `stage` do update_task (validação humana, 11/07/2026): agente move a
// task pra uma COLUNA visual do board (ex.: "Validação humana") por id ou label.
// Mantém o invariante do Kanban: status = category da coluna (spec 51).
const AUTH = { email: 'test@example.com', loggedInAt: 0 };
function reg(register: (s: any, e: any, a: any) => void, name: string) {
  const r: any = {};
  register({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, AUTH);
  return r[name];
}
const save = () => reg(registerSaveTask, 'save_task');
const update = () => reg(registerUpdateTask, 'update_task');
const parse = (res: any) => JSON.parse(res.content[0].text);

async function seedValidationColumn(): Promise<string> {
  const col = await createKanbanColumn(E, {
    id: 'col_validacao',
    label: 'Validação humana',
    color: null,
    category: 'in_progress',
  });
  return col.id;
}

describe('update_task stage (mover pra coluna do board)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_activity');
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    await E.DB.exec("DELETE FROM kanban_columns WHERE id NOT IN ('col_aberto','col_progresso','col_concluido','col_cancelado')");
  });

  it('stage por label (case-insensitive) move pra coluna e alinha o status à categoria', async () => {
    await seedValidationColumn();
    const created = parse(await save()({ title: 'Trabalho de agente' }));
    const out = parse(await update()({ id: created.id, stage: 'validação humana' }));
    expect(out.status).toBe('in_progress');
    expect(out.column).toEqual({ id: 'col_validacao', label: 'Validação humana' });
    const row = await E.DB.prepare(`SELECT column_id, status FROM notes WHERE id = ?`).bind(created.id).first();
    expect(row.column_id).toBe('col_validacao');
    expect(row.status).toBe('in_progress');
  });

  it('stage por id (col_...) tambem resolve', async () => {
    const colId = await seedValidationColumn();
    const created = parse(await save()({ title: 'Por id' }));
    const out = parse(await update()({ id: created.id, stage: colId }));
    expect(out.column.id).toBe(colId);
  });

  it('stage numa coluna done fecha a task (completed_at) como o drag do board', async () => {
    const created = parse(await save()({ title: 'Aprovada' }));
    const out = parse(await update()({ id: created.id, stage: 'Concluído' }));
    expect(out.status).toBe('done');
    const row = await E.DB.prepare(`SELECT completed_at FROM notes WHERE id = ?`).bind(created.id).first();
    expect(row.completed_at).not.toBeNull();
  });

  it('stage + status juntos: erro (o stage ja define o status)', async () => {
    await seedValidationColumn();
    const created = parse(await save()({ title: 'Conflito' }));
    const res = await update()({ id: created.id, stage: 'Validação humana', status: 'done' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/stage.*status|status.*stage/i);
  });

  it('stage desconhecido: erro listando as colunas ativas disponiveis', async () => {
    await seedValidationColumn();
    const created = parse(await save()({ title: 'Typo' }));
    const res = await update()({ id: created.id, stage: 'Validacao humana (typo sem acento)' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Validação humana');
  });

  it('coluna arquivada nao resolve por label', async () => {
    const colId = await seedValidationColumn();
    await E.DB.prepare(`UPDATE kanban_columns SET archived_at = 1 WHERE id = ?`).bind(colId).run();
    const created = parse(await save()({ title: 'Arquivada' }));
    const res = await update()({ id: created.id, stage: 'Validação humana' });
    expect(res.isError).toBe(true);
  });

  it('stage junto com outros campos aplica os dois (patch + move)', async () => {
    await seedValidationColumn();
    const created = parse(await save()({ title: 'Combinada' }));
    const out = parse(await update()({ id: created.id, stage: 'Validação humana', priority: 1 }));
    expect(out.priority).toBe(1);
    expect(out.column.id).toBe('col_validacao');
  });

  it('regressao: mudar status sem stage continua caindo na coluna default da categoria', async () => {
    await seedValidationColumn();
    const created = parse(await save()({ title: 'Default' }));
    const out = parse(await update()({ id: created.id, status: 'in_progress' }));
    expect(out.status).toBe('in_progress');
    const row = await E.DB.prepare(`SELECT column_id FROM notes WHERE id = ?`).bind(created.id).first();
    // default da categoria = ativa de MENOR position (Em progresso), nunca a validação
    expect(row.column_id).toBe('col_progresso');
  });

  it('expected_updated_at desatualizado bloqueia o move (conflito)', async () => {
    await seedValidationColumn();
    const created = parse(await save()({ title: 'Guardada' }));
    const fresh = parse(await update()({ id: created.id, priority: 2 }));
    const res = await update()({ id: created.id, stage: 'Validação humana', expected_updated_at: created.updated_at });
    expect(res.isError).toBe(true);
    const row = await E.DB.prepare(`SELECT column_id FROM notes WHERE id = ?`).bind(created.id).first();
    expect(row.column_id).not.toBe('col_validacao');
    // com o updated_at fresco passa
    const ok = parse(await update()({ id: created.id, stage: 'Validação humana', expected_updated_at: fresh.updated_at }));
    expect(ok.column.id).toBe('col_validacao');
  });
});
