import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerSaveTask } from '../../src/mcp/tools/save-task.js';
import { registerUpdateTask } from '../../src/mcp/tools/update-task.js';
import { registerCompleteTask } from '../../src/mcp/tools/complete-task.js';

const E = env as any;

// Gate de concorrência/idempotência/dedupe das tasks (spec 14). Registra as 3
// tools num server fake (padrão da suíte) e chama os handlers direto.
const AUTH = { email: 'test@example.com', loggedInAt: 0 };
function reg(register: (s: any, e: any, a: any) => void, name: string) {
  const r: any = {};
  register({ registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any, E, AUTH);
  return r[name];
}

const save = () => reg(registerSaveTask, 'save_task');
const update = () => reg(registerUpdateTask, 'update_task');
const complete = () => reg(registerCompleteTask, 'complete_task');

const parse = (res: any) => JSON.parse(res.content[0].text);

describe('tasks concurrency / idempotency / dedupe', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
  });

  // ── Versionamento otimista ──────────────────────────────────────────────
  it('update_task with expected_updated_at: A wins, stale B conflicts, A intact', async () => {
    const created = parse(await save()({ title: 'Concurrent task' }));
    const id = created.id;
    const v0 = created.updated_at;

    // A grava com o updated_at correto → sucesso, nova versão.
    const a = parse(await update()({ id, priority: 1, expected_updated_at: v0 }));
    expect(a.priority).toBe(1);
    expect(a.updated_at).toBeGreaterThan(v0);

    // B grava com o updated_at ANTIGO → conflito, nada escrito.
    const bRes = await update()({ id, priority: 4, expected_updated_at: v0 });
    expect(bRes.isError).toBe(true);
    expect(bRes.content[0].text).toContain('changed since you read it');

    // O patch de A permanece intacto.
    const row = await E.DB.prepare(`SELECT priority FROM notes WHERE id = ?`).bind(id).first();
    expect(row.priority).toBe(1);
  });

  it('update_task WITHOUT expected_updated_at keeps last-write-wins (compat)', async () => {
    const created = parse(await save()({ title: 'Compat task' }));
    const id = created.id;
    const r1 = await update()({ id, priority: 2 });
    expect(r1.isError).toBeUndefined();
    const r2 = await update()({ id, priority: 3 });
    expect(r2.isError).toBeUndefined();
    const row = await E.DB.prepare(`SELECT priority FROM notes WHERE id = ?`).bind(id).first();
    expect(row.priority).toBe(3);
  });

  // ── Idempotência do complete ────────────────────────────────────────────
  it('complete_task twice: second is already_done, completed_at unchanged, one Resultado', async () => {
    const created = parse(await save()({ title: 'Finish me' }));
    const id = created.id;

    const first = parse(await complete()({ id, outcome: 'done well' }));
    expect(first.status).toBe('done');
    const firstCompletedAt = first.completed_at;
    expect(firstCompletedAt).toBeGreaterThan(0);

    const second = parse(await complete()({ id, outcome: 'done again' }));
    expect(second.already_done).toBe(true);
    expect(second.completed_at).toBe(firstCompletedAt);

    const row = await E.DB.prepare(`SELECT body FROM notes WHERE id = ?`).bind(id).first();
    const occurrences = (row.body.match(/\*\*Resultado:\*\*/g) || []).length;
    expect(occurrences).toBe(1);
    expect(row.body).toContain('done well');
    expect(row.body).not.toContain('done again');
  });

  it('complete append happens in SQL (no read-modify-write) — single outcome under repeat', async () => {
    const created = parse(await save()({ title: 'Atomic append' }));
    const id = created.id;
    // Chama complete duas vezes "seguidas": segunda é no-op (status<>'done').
    await complete()({ id, outcome: 'winner' });
    await complete()({ id, outcome: 'loser' });
    const row = await E.DB.prepare(`SELECT body, status FROM notes WHERE id = ?`).bind(id).first();
    expect(row.status).toBe('done');
    const occurrences = (row.body.match(/\*\*Resultado:\*\*/g) || []).length;
    expect(occurrences).toBe(1);
    expect(row.body).toContain('winner');
  });

  // ── Dedupe por dedupe_key ───────────────────────────────────────────────
  it('save_task with same dedupe_key twice: second deduped, only one task', async () => {
    const first = parse(await save()({ title: 'Send proposal', dedupe_key: 'email-123' }));
    expect(first.deduped).toBeUndefined();
    const second = parse(await save()({ title: 'Send proposal', dedupe_key: 'email-123' }));
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);

    const count = await E.DB.prepare(`SELECT count(*) c FROM notes WHERE kind='task'`).first();
    expect(count.c).toBe(1);
    // dedupe_key persistida como tag reservada.
    const tag = await E.DB.prepare(`SELECT tag FROM tags WHERE note_id = ? AND tag LIKE 'dedupe:%'`).bind(first.id).first();
    expect(tag.tag).toBe('dedupe:email-123');
  });

  it('dedupe_key of a COMPLETED task does not block a new creation', async () => {
    const first = parse(await save()({ title: 'One-off', dedupe_key: 'k-done' }));
    await complete()({ id: first.id });
    const second = parse(await save()({ title: 'One-off again', dedupe_key: 'k-done' }));
    expect(second.deduped).toBeUndefined();
    expect(second.id).not.toBe(first.id);
    const count = await E.DB.prepare(`SELECT count(*) c FROM notes WHERE kind='task'`).first();
    expect(count.c).toBe(2);
  });

  it('update_task with new tags preserves the reserved dedupe: tag', async () => {
    const created = parse(await save()({ title: 'Keep dedupe', dedupe_key: 'keep-1', tags: ['project-x'] }));
    const id = created.id;
    await update()({ id, tags: ['new-tag'] });
    const rows = await E.DB.prepare(`SELECT tag FROM tags WHERE note_id = ? ORDER BY tag`).bind(id).all();
    const tags = rows.results.map((r: any) => r.tag);
    expect(tags).toContain('new-tag');
    expect(tags).toContain('dedupe:keep-1');   // preservada
    expect(tags).not.toContain('project-x');   // substituída pelo replace
  });

  // ── Aviso por título similar (não bloqueia) ─────────────────────────────
  it('save_task without dedupe_key returns possible_duplicates but still creates', async () => {
    await save()({ title: 'Ligar para o cliente' });
    const second = parse(await save()({ title: 'Ligar para o cliente' }));
    expect(Array.isArray(second.possible_duplicates)).toBe(true);
    expect(second.possible_duplicates.length).toBeGreaterThan(0);
    // A segunda foi criada mesmo assim.
    const count = await E.DB.prepare(`SELECT count(*) c FROM notes WHERE kind='task'`).first();
    expect(count.c).toBe(2);
  });

  // ── status inicial fechado stampa completed_at ──────────────────────────
  it('save_task with status done stamps completed_at', async () => {
    const created = parse(await save()({ title: 'Born done', status: 'done' }));
    const row = await E.DB.prepare(`SELECT status, completed_at FROM notes WHERE id = ?`).bind(created.id).first();
    expect(row.status).toBe('done');
    expect(row.completed_at).toBeGreaterThan(0);
  });

  // ── retornos trazem updated_at (insumo pro expected_updated_at) ──────────
  it('save_task and complete_task return updated_at', async () => {
    const created = parse(await save()({ title: 'Has updated_at' }));
    expect(typeof created.updated_at).toBe('number');
    const done = parse(await complete()({ id: created.id }));
    expect(typeof done.updated_at).toBe('number');
  });
});
