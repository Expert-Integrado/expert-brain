import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { getNoteById } from '../src/db/queries.js';

const E = env as any;

// Mocka Workers AI + Vectorize pro reembed (tldr/domains/kind) não bater no
// backend real dentro do teste. Espelha o padrão de test/tools/update-note.test.ts.
function fakeAI() { return { run: vi.fn(async () => ({ data: [Array(1024).fill(0.3)] })) }; }
function fakeVectorize() { return { upsert: vi.fn(async () => ({})), query: vi.fn(async () => ({ matches: [] })) }; }

async function sessionCookieHeader(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

// Insere uma NOTA de conhecimento (kind != task) com updated_at conhecido.
async function seedNote(id: string, updatedAt: number, kind = 'concept') {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?,?, NULL, NULL, NULL, NULL, ?, ?, NULL)`
  ).bind(id, `Nota ${id}`, 'corpo original', 'tldr da nota original aqui', '["operations"]', kind, updatedAt, updatedAt).run();
}

async function seedTask(id: string, updatedAt: number) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?, 'task', 'open', NULL, NULL, NULL, ?, ?, NULL)`
  ).bind(id, `Task ${id}`, 'corpo', `Task ${id}`, '["operations"]', updatedAt, updatedAt).run();
}

function post(body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  return SELF.fetch('https://x/app/notes/update', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /app/notes/update (edição inline de nota — spec 36 fase 2)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    E.AI = fakeAI();
    E.VECTORIZE = fakeVectorize();
  });

  it('sem sessão: 401 quando accept é JSON', async () => {
    await seedNote('n1', 1000);
    const res = await post({ id: 'n1', patch: { title: 'X' } });
    expect(res.status).toBe(401);
  });

  it('sem sessão numa navegação (sem accept JSON): 302 ou 401', async () => {
    await seedNote('n1', 1000);
    const res = await SELF.fetch('https://x/app/notes/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'n1', patch: { title: 'X' } }),
      redirect: 'manual',
    });
    expect([401, 302]).toContain(res.status);
  });

  it('patch feliz: muda título, tldr e kind e persiste', async () => {
    await seedNote('n1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post(
      { id: 'n1', patch: { title: 'Novo título', tldr: 'novo resumo com dez mais chars', kind: 'insight' }, expected_updated_at: 1000 },
      cookie
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(typeof data.updated_at).toBe('number');
    const n = await getNoteById(E, 'n1');
    expect(n?.title).toBe('Novo título');
    expect(n?.tldr).toBe('novo resumo com dez mais chars');
    expect(n?.kind).toBe('insight');
  });

  it('domínios: aceita canônicos e persiste como JSON', async () => {
    await seedNote('n1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 'n1', patch: { domains: ['sales', 'marketing'] } }, cookie);
    expect(res.status).toBe(200);
    const n = await getNoteById(E, 'n1');
    expect(JSON.parse(n!.domains)).toEqual(['sales', 'marketing']);
  });

  it('409 em concorrência: expected_updated_at defasado NÃO sobrescreve', async () => {
    await seedNote('n1', 1000);
    const cookie = await sessionCookieHeader();
    await E.DB.prepare(`UPDATE notes SET updated_at = 2000, title = 'Editada por outro' WHERE id = 'n1'`).run();
    const res = await post({ id: 'n1', patch: { title: 'Minha edição' }, expected_updated_at: 1000 }, cookie);
    expect(res.status).toBe(409);
    const data = (await res.json()) as any;
    expect(data.error).toBe('conflict');
    expect(data.current_updated_at).toBe(2000);
    const n = await getNoteById(E, 'n1');
    expect(n?.title).toBe('Editada por outro');
  });

  it('inválido: title vazio → 400', async () => {
    await seedNote('n1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 'n1', patch: { title: '   ' } }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: tldr curto (<10) → 400', async () => {
    await seedNote('n1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 'n1', patch: { tldr: 'curto' } }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: domínio fora do canon → 400', async () => {
    await seedNote('n1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 'n1', patch: { domains: ['biologia-evolutiva'] } }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: mais de 3 domínios → 400', async () => {
    await seedNote('n1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 'n1', patch: { domains: ['sales', 'marketing', 'product', 'operations'] } }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: kind fora dos 7 (task não conta) → 400', async () => {
    await seedNote('n1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 'n1', patch: { kind: 'task' } }, cookie);
    expect(res.status).toBe(400);
  });

  it('patch vazio → 400', async () => {
    await seedNote('n1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 'n1', patch: {} }, cookie);
    expect(res.status).toBe(400);
  });

  it('nota inexistente → 404', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 'ghost', patch: { title: 'X' } }, cookie);
    expect(res.status).toBe(404);
  });

  it('id é uma TASK → 404 (task edita só por /app/tasks/update)', async () => {
    await seedTask('t1', 1000);
    const cookie = await sessionCookieHeader();
    const res = await post({ id: 't1', patch: { title: 'X' } }, cookie);
    expect(res.status).toBe(404);
    // Task intocada.
    const t = await getNoteById(E, 't1');
    expect(t?.title).toBe('Task t1');
  });
});
