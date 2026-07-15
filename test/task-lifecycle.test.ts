import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { insertTask } from '../src/db/queries.js';
import { runTaskAutocancel, runTaskAging } from '../src/task-lifecycle.js';
import { claimTask } from '../src/db/queries.js';

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

// spec 80-frota-agentes/94 — aging automático DESLIGADO por default (env var
// opt-in); ligado, reabre só task in_progress sem NENHUM update há N+ dias,
// solta o claim e grava um comentário [info] no thread.
describe('runTaskAging (spec 94)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_comments');
    await E.DB.exec('DELETE FROM notes');
  });

  it('sem TASK_AGING_AFTER_DAYS => no-op, nenhum UPDATE', async () => {
    const now = Date.now();
    await seed('t1', { status: 'in_progress', updated_at: now - 100 * DAY });
    const r = await runTaskAging({ ...E, TASK_AGING_AFTER_DAYS: undefined }, now);
    expect(r.reopened).toBe(0);
    expect(r.reason).toContain('desligado');
    expect((await getTask('t1')).status).toBe('in_progress');
  });

  it('com a var: reabre so in_progress parada ha N+ dias, solta claim e comenta [info]', async () => {
    const now = Date.now();
    await seed('parada', { status: 'in_progress', updated_at: now - 30 * DAY });
    await seed('tocada-recente', { status: 'in_progress', updated_at: now - 1 * DAY });
    await seed('aberta', { status: 'open', updated_at: now - 30 * DAY });
    await seed('concluida', { status: 'done', updated_at: now - 30 * DAY });
    await claimTask(E, 'parada', 'user_a', now - 30 * DAY, 60_000_000_000); // claim "vivo" antigo

    const r = await runTaskAging({ ...E, TASK_AGING_AFTER_DAYS: '14' }, now);
    expect(r.reopened).toBe(1);

    const parada = await getTask('parada');
    expect(parada.status).toBe('open');
    expect(parada.body).toContain('Reaberta automaticamente');
    expect(parada.body).toContain('14 dias');

    const paradaRow: any = await E.DB.prepare(
      `SELECT claimed_by, claim_expires_at FROM notes WHERE id = 'parada'`
    ).first();
    expect(paradaRow.claimed_by).toBeNull();
    expect(paradaRow.claim_expires_at).toBeNull();

    const comments = (await E.DB.prepare(
      `SELECT kind, body, author, author_user_id FROM task_comments WHERE task_id = 'parada'`
    ).all()).results as any[];
    expect(comments).toHaveLength(1);
    expect(comments[0].kind).toBe('info');
    expect(comments[0].author).toBe('agent');
    expect(comments[0].author_user_id).toBeNull();
    expect(comments[0].body).toContain('[info]');

    expect((await getTask('tocada-recente')).status).toBe('in_progress');
    expect((await getTask('aberta')).status).toBe('open');
    expect((await getTask('concluida')).status).toBe('done');
    // Tasks intocadas não ganham comentário nenhum.
    const noComment: any = await E.DB.prepare(
      `SELECT count(*) AS c FROM task_comments WHERE task_id != 'parada'`
    ).first();
    expect(noComment.c).toBe(0);
  });

  it('var invalida (nao-numero / <= 0) => no-op', async () => {
    const now = Date.now();
    await seed('t2', { status: 'in_progress', updated_at: now - 100 * DAY });
    expect((await runTaskAging({ ...E, TASK_AGING_AFTER_DAYS: 'abc' }, now)).reopened).toBe(0);
    expect((await runTaskAging({ ...E, TASK_AGING_AFTER_DAYS: '0' }, now)).reopened).toBe(0);
    expect((await getTask('t2')).status).toBe('in_progress');
  });
});
