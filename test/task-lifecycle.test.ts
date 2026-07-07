import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { insertTask } from '../src/db/queries.js';
import { runTaskAutocancel } from '../src/task-lifecycle.js';

// spec 30-features/32 §4 — auto-cancel DESLIGADO por default (env var opt-in);
// ligado, cancela só task open VENCIDA há N+ dias E sem update há N+ dias.

const E = env as any;
const DAY = 86_400_000;

function seed(id: string, opts: { status?: string; due_at?: number | null; updated_at?: number }) {
  const now = opts.updated_at ?? Date.now();
  return insertTask(E, {
    id, title: `Task ${id}`, body: 'corpo', tldr: 't', domains: '["operations"]',
    status: (opts.status ?? 'open') as any, due_at: opts.due_at ?? null, priority: null,
    created_at: now, updated_at: now,
  } as any);
}

const getTask = async (id: string) =>
  (await E.DB.prepare(`SELECT status, body, completed_at FROM notes WHERE id = ?`).bind(id).first()) as any;

describe('runTaskAutocancel (spec 32)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('sem TASK_AUTOCANCEL_AFTER_DAYS => no-op, nenhum UPDATE', async () => {
    const now = Date.now();
    await seed('t1', { due_at: now - 100 * DAY, updated_at: now - 100 * DAY });
    const r = await runTaskAutocancel({ ...E, TASK_AUTOCANCEL_AFTER_DAYS: undefined }, now);
    expect(r.canceled).toBe(0);
    expect(r.reason).toContain('desligado');
    expect((await getTask('t1')).status).toBe('open');
  });

  it('com a var: cancela so vencida E sem update ha N dias, com nota no body', async () => {
    const now = Date.now();
    await seed('morta', { due_at: now - 100 * DAY, updated_at: now - 100 * DAY });
    await seed('vencida-mas-tocada', { due_at: now - 100 * DAY, updated_at: now - 1 * DAY });
    await seed('recente', { due_at: now - 1 * DAY, updated_at: now - 1 * DAY });
    await seed('in-progress', { status: 'in_progress', due_at: now - 100 * DAY, updated_at: now - 100 * DAY });
    await seed('sem-due', { due_at: null, updated_at: now - 100 * DAY });

    const r = await runTaskAutocancel({ ...E, TASK_AUTOCANCEL_AFTER_DAYS: '30' }, now);
    expect(r.canceled).toBe(1);

    const morta = await getTask('morta');
    expect(morta.status).toBe('canceled');
    expect(morta.completed_at).not.toBeNull();
    expect(morta.body).toContain('Auto-cancelada');
    expect(morta.body).toContain('reversível');

    expect((await getTask('vencida-mas-tocada')).status).toBe('open');
    expect((await getTask('recente')).status).toBe('open');
    // só status 'open' entra — in_progress indica trabalho ativo
    expect((await getTask('in-progress')).status).toBe('in_progress');
    expect((await getTask('sem-due')).status).toBe('open');
  });

  it('var invalida (nao-numero / <= 0) => no-op', async () => {
    const now = Date.now();
    await seed('t2', { due_at: now - 100 * DAY, updated_at: now - 100 * DAY });
    expect((await runTaskAutocancel({ ...E, TASK_AUTOCANCEL_AFTER_DAYS: 'abc' }, now)).canceled).toBe(0);
    expect((await runTaskAutocancel({ ...E, TASK_AUTOCANCEL_AFTER_DAYS: '0' }, now)).canceled).toBe(0);
    expect((await getTask('t2')).status).toBe('open');
  });
});
