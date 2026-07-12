import { env, SELF } from 'cloudflare:test';
import { OWNER_TASK_VIS } from '../src/auth/visibility.js';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { getTaskById, insertTags } from '../src/db/queries.js';

const E = env as any;

// Sessão de browser válida pro OWNER_EMAIL/SESSION_SECRET do vitest.config.ts.
async function sessionCookieHeader(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

// Insere uma task diretamente (kind='task') com updated_at conhecido.
async function seedTask(id: string, updatedAt: number) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?, 'task', 'open', NULL, NULL, NULL, ?, ?, NULL)`
  ).bind(id, `Task ${id}`, 'corpo', `Task ${id}`, '["operations"]', updatedAt, updatedAt).run();
}

function post(body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  return SELF.fetch('https://x/app/tasks/update', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /app/tasks/update (edição inline de task — spec 36)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('sem sessão nem Bearer: 401 quando accept é JSON', async () => {
    await seedTask('t1', 1000);
    const res = await post({ id: 't1', patch: { priority: 2 } });
    expect(res.status).toBe(401);
  });

  it('redireciona (302) pro login numa navegação sem accept JSON', async () => {
    await seedTask('t1', 1000);
    // Sem accept: application/json, mas method POST + path /update casa isDataRequest
    // → ainda deve dar 401 (rota de dados). Aqui garantimos que NÃO passa sem auth.
    const res = await SELF.fetch('https://x/app/tasks/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 't1', patch: { priority: 2 } }),
      redirect: 'manual',
    });
    expect([401, 302]).toContain(res.status);
  });

  it('patch feliz: muda prioridade, status e prazo e persiste', async () => {
    await seedTask('t1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post(
      { id: 't1', patch: { priority: 1, status: 'in_progress', due: '2026-06-22 14:00' }, expected_updated_at: 1000 },
      cookie
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.priority).toBe(1);
    expect(data.status).toBe('in_progress');
    expect(typeof data.due_at).toBe('number');
    // Persistiu no banco.
    const t = await getTaskById(E, 't1', OWNER_TASK_VIS);
    expect(t?.priority).toBe(1);
    expect(t?.status).toBe('in_progress');
    expect(t?.due_at).not.toBeNull();
  });

  it('due=null limpa o prazo', async () => {
    await seedTask('t1', 1000);
    await E.DB.prepare(`UPDATE notes SET due_at = 9999 WHERE id = 't1'`).run();
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 't1', patch: { due: null } }, cookie);
    expect(res.status).toBe(200);
    const t = await getTaskById(E, 't1', OWNER_TASK_VIS);
    expect(t?.due_at).toBeNull();
  });

  it('title e body: salva texto livre e reflete no tldr', async () => {
    await seedTask('t1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 't1', patch: { title: 'Novo título', body: 'Novo corpo' } }, cookie);
    expect(res.status).toBe(200);
    const t = await getTaskById(E, 't1', OWNER_TASK_VIS);
    expect(t?.title).toBe('Novo título');
    expect(t?.body).toBe('Novo corpo');
    expect(t?.tldr).toBe('Novo título'); // tldr espelha o título
  });

  it('409 em concorrência: expected_updated_at defasado NÃO sobrescreve', async () => {
    await seedTask('t1', 1000);
    const cookie = await sessionCookieHeader();
    // Simula edição concorrente: a task já avançou pra updated_at=2000.
    await E.DB.prepare(`UPDATE notes SET updated_at = 2000, title = 'Editada por outro' WHERE id = 't1'`).run();
    const res = await post({ id: 't1', patch: { title: 'Minha edição' }, expected_updated_at: 1000 }, cookie);
    expect(res.status).toBe(409);
    const data = (await res.json()) as any;
    expect(data.error).toBe('conflict');
    expect(data.current_updated_at).toBe(2000);
    // Não sobrescreveu.
    const t = await getTaskById(E, 't1', OWNER_TASK_VIS);
    expect(t?.title).toBe('Editada por outro');
  });

  it('input inválido: priority fora de 1-4 → 400', async () => {
    await seedTask('t1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 't1', patch: { priority: 9 } }, cookie);
    expect(res.status).toBe(400);
  });

  it('input inválido: status desconhecido → 400', async () => {
    await seedTask('t1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 't1', patch: { status: 'wat' } }, cookie);
    expect(res.status).toBe(400);
  });

  it('input inválido: due não-parseável → 400', async () => {
    await seedTask('t1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 't1', patch: { due: 'amanhã de tarde' } }, cookie);
    expect(res.status).toBe(400);
  });

  it('patch vazio → 400', async () => {
    await seedTask('t1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 't1', patch: {} }, cookie);
    expect(res.status).toBe(400);
  });

  it('id inexistente → 404', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 'ghost', patch: { priority: 1 } }, cookie);
    expect(res.status).toBe(404);
  });
});

describe('POST /app/tasks/update — tags (editor de chips da sidebar, spec 52)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM tags');
    await E.DB.exec('DELETE FROM notes');
  });

  it('substitui todas as tags e devolve a lista atualizada (sem reservadas)', async () => {
    await seedTask('t1', 1000);
    await insertTags(E, 't1', ['antigo']);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 't1', patch: { tags: ['novo', 'vip'] } }, cookie);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.tags.sort()).toEqual(['novo', 'vip']);
    const rows = await E.DB.prepare(`SELECT tag FROM tags WHERE note_id = 't1' ORDER BY tag`).all();
    expect(rows.results.map((r: any) => r.tag)).toEqual(['novo', 'vip']);
  });

  it('preserva a tag reservada dedupe: mesmo sem o caller pedir', async () => {
    await seedTask('t1', 1000);
    await insertTags(E, 't1', ['dedupe:origem-x', 'velha']);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 't1', patch: { tags: ['nova'] } }, cookie);
    expect(res.status).toBe(200);
    const rows = await E.DB.prepare(`SELECT tag FROM tags WHERE note_id = 't1' ORDER BY tag`).all();
    const tags = rows.results.map((r: any) => r.tag);
    expect(tags).toContain('nova');
    expect(tags).toContain('dedupe:origem-x');
    expect(tags).not.toContain('velha');
    // A resposta nunca expõe a reservada pro editor da UI.
    const data = (await res.json()) as any;
    expect(data.tags).not.toContain('dedupe:origem-x');
  });

  it('[] limpa as tags não-reservadas', async () => {
    await seedTask('t1', 1000);
    await insertTags(E, 't1', ['a', 'b']);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 't1', patch: { tags: [] } }, cookie);
    expect(res.status).toBe(200);
    const rows = await E.DB.prepare(`SELECT count(*) c FROM tags WHERE note_id = 't1'`).first();
    expect(rows.c).toBe(0);
  });

  it('tags inválidas (não-array ou item não-string) → 400', async () => {
    await seedTask('t1', 1000);
    const cookie = await sessionCookieHeader();
    expect((await post({ id: 't1', patch: { tags: 'nao-e-array' } }, cookie)).status).toBe(400);
    expect((await post({ id: 't1', patch: { tags: ['ok', 123] } }, cookie)).status).toBe(400);
  });
});
