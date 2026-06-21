import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerSaveTask } from '../../src/mcp/tools/save-task.js';

const E = env as any;

function reg() {
  const r: any = {};
  registerSaveTask({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E);
  return r;
}

describe('save_task', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('creates a task with kind=task and default open status + operations domain', async () => {
    const res = await reg().save_task({ title: 'Ligar pro cliente PSP' });
    const p = JSON.parse(res.content[0].text);
    expect(p.status).toBe('open');
    const row = await E.DB.prepare(`SELECT kind, status, domains, due_at, priority FROM notes WHERE id = ?`).bind(p.id).first();
    expect(row.kind).toBe('task');
    expect(row.status).toBe('open');
    expect(JSON.parse(row.domains)).toEqual(['operations']);
    expect(row.due_at).toBeNull();
    expect(row.priority).toBeNull();
  });

  it('parses a BRT due string into unix ms (UTC-3)', async () => {
    const res = await reg().save_task({ title: 'Reunião', due: '2026-06-22T14:00' });
    const p = JSON.parse(res.content[0].text);
    // 14:00 BRT == 17:00 UTC
    expect(new Date(p.due_at).toISOString()).toBe('2026-06-22T17:00:00.000Z');
    expect(p.due_brt).toBe('22/06/2026 14:00');
  });

  it('stores priority and details body', async () => {
    const res = await reg().save_task({ title: 'Pagar fornecedor', details: 'Boleto vence sexta', priority: 1 });
    const p = JSON.parse(res.content[0].text);
    const row = await E.DB.prepare(`SELECT body, priority FROM notes WHERE id = ?`).bind(p.id).first();
    expect(row.priority).toBe(1);
    expect(row.body).toBe('Boleto vence sexta');
  });

  it('rejects an invalid due string', async () => {
    const res = await reg().save_task({ title: 'X', due: 'amanhã às tantas' });
    expect(res.isError).toBe(true);
  });

  it('does not write a vector (task stays out of recall)', async () => {
    // A simple proxy: the handler never calls env.VECTORIZE — if it did, the test
    // env would need an AI binding. Creating succeeds without any AI mock.
    const res = await reg().save_task({ title: 'Sem embed' });
    expect(res.isError).toBeUndefined();
  });
});
