import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { insertTask, insertTags } from '../src/db/queries.js';
import { createShare } from '../src/web/share.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function seedTask(id: string, status: string = 'open') {
  await insertTask(E, {
    id, title: `Task ${id}`, body: 'b', tldr: `Task ${id}`, domains: '["operations"]',
    status: status as any, due_at: null, priority: null, created_at: 1, updated_at: 1,
  });
}

// O D1 de teste é COMPARTILHADO entre arquivos (isolatedStorage:false —
// vitest.config.ts) — reseta kanban_columns pros 4 seeds padrão, mesmo padrão
// defensivo de test/kanban-web.test.ts, pra board/create não dependerem da
// ordem de execução dos demais arquivos.
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

async function boardData(): Promise<any> {
  const res = await SELF.fetch('https://x/app/tasks/data', { headers: { accept: 'application/json', cookie: await cookie() } });
  return res.json();
}

function findTask(data: any, id: string): any {
  return data.columns.flatMap((c: any) => c.tasks).find((t: any) => t.id === id);
}

describe('payload /app/tasks/data — tags e compartilhamento no card (spec 52)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
    await resetKanban();
  });

  it('card traz as tags da task, sem as reservadas dedupe:*', async () => {
    await seedTask('t1');
    await insertTags(E, 't1', ['vip', 'projeto-x', 'dedupe:email-123']);
    const data = await boardData();
    const t1 = findTask(data, 't1');
    expect(t1.tags.sort()).toEqual(['projeto-x', 'vip']);
    expect(t1.tags).not.toContain('dedupe:email-123');
  });

  it('task sem tags devolve array vazio', async () => {
    await seedTask('t1');
    const data = await boardData();
    expect(findTask(data, 't1').tags).toEqual([]);
  });

  it('task sem link público: shared=false e share_expires_brt=null', async () => {
    await seedTask('t1');
    const data = await boardData();
    const t1 = findTask(data, 't1');
    expect(t1.shared).toBe(false);
    expect(t1.share_expires_brt).toBeNull();
  });

  it('task com link público ATIVO: shared=true e share_expires_brt preenchido', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', { expiresDays: 30 }, Date.now());
    if (!r.ok) throw new Error('setup');
    const data = await boardData();
    const t1 = findTask(data, 't1');
    expect(t1.shared).toBe(true);
    expect(typeof t1.share_expires_brt).toBe('string');
    expect(t1.share_expires_brt!.length).toBeGreaterThan(0);
  });

  it('link público EXPIRADO conta como shared=false (não é mais um link vivo)', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', { expiresDays: 1 }, Date.now());
    if (!r.ok) throw new Error('setup');
    await E.DB.prepare(`UPDATE notes SET share_expires_at = 5 WHERE id = 't1'`).run();
    const data = await boardData();
    const t1 = findTask(data, 't1');
    expect(t1.shared).toBe(false);
    expect(t1.share_expires_brt).toBeNull();
  });

  it('SSR do board (sem JS) renderiza chips de tag truncados (máx 3 + "+N")', async () => {
    await seedTask('t1');
    await insertTags(E, 't1', ['a', 'b', 'c', 'd', 'e']);
    const res = await SELF.fetch('https://x/app/tasks', { headers: { cookie: await cookie() } });
    const html = await res.text();
    // 3 chips visíveis + indicador "+2" pros 2 restantes.
    expect((html.match(/task-tag-chip"/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('+2');
  });

  it('SSR do board mostra o ícone de link só quando a task está compartilhada', async () => {
    await seedTask('t1');
    await seedTask('t2');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    const html = await (await SELF.fetch('https://x/app/tasks', { headers: { cookie: await cookie() } })).text();
    expect(html).toContain('task-share-icon');
  });
});
