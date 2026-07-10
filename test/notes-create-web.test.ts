import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { getNoteById } from '../src/db/queries.js';

const E = env as any;

// Mocka Workers AI + Vectorize pro embed best-effort não bater no backend real dentro
// do teste. Espelha o padrão de test/notes-update-web.test.ts.
function fakeAI() { return { run: vi.fn(async () => ({ data: [Array(1024).fill(0.3)] })) }; }
function fakeVectorize() { return { upsert: vi.fn(async () => ({})), query: vi.fn(async () => ({ matches: [] })) }; }

async function sessionCookieHeader(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function post(body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  return SELF.fetch('https://x/app/notes/create', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// Insere uma nota de conhecimento existente com vetor conhecido — usada como candidata
// de "possível duplicata" no teste de dedupe.
async function seedNote(id: string, title: string, updatedAt: number) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?,'concept', NULL, NULL, NULL, NULL, ?, ?, NULL)`
  ).bind(id, title, 'corpo original', 'tldr da nota original aqui', '["operations"]', updatedAt, updatedAt).run();
}

describe('POST /app/notes/create ("+ Nova nota" — audit ui-audit/RELATORIO.md item N2)', () => {
  beforeEach(async () => {
    E.OWNER_EMAIL = 'owner@example.com';
    E.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    E.AI = fakeAI();
    E.VECTORIZE = fakeVectorize();
  });

  it('sem sessão: 401 quando accept é JSON — nunca cria a nota', async () => {
    const res = await post({ title: 'Sem sessão' });
    expect(res.status).toBe(401);
  });

  it('sem sessão numa navegação (sem accept JSON): 302 pro login', async () => {
    const res = await SELF.fetch('https://x/app/notes/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Sem sessão' }),
      redirect: 'manual',
    });
    expect([401, 302]).toContain(res.status);
  });

  it('feliz: só título — body cai no título, kind fica NULL, domains default operations', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Nota mínima' }, cookie);
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(typeof data.id).toBe('string');
    expect(data.title).toBe('Nota mínima');
    expect(data.dup).toBeNull();

    const n = await getNoteById(E, data.id);
    expect(n?.title).toBe('Nota mínima');
    expect(n?.body).toBe('Nota mínima');
    expect(n?.tldr).toBe('Nota mínima');
    expect(n?.kind).toBeNull();
    expect(JSON.parse(n!.domains)).toEqual(['operations']);
  });

  it('feliz: título + corpo — body persistido, tldr deriva da primeira linha do corpo', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Com corpo', body: 'Primeira linha do corpo\nSegunda linha' }, cookie);
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;

    const n = await getNoteById(E, data.id);
    expect(n?.body).toBe('Primeira linha do corpo\nSegunda linha');
    expect(n?.tldr).toBe('Primeira linha do corpo');
  });

  it('embed best-effort: upsert do vetor é chamado quando o embed funciona', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Nota com vetor' }, cookie);
    expect(res.status).toBe(201);
    expect(E.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
  });

  it('embed best-effort: falha do Workers AI não derruba a criação (nota nasce sem vetor)', async () => {
    E.AI = { run: vi.fn(async () => { throw new Error('AI indisponível'); }) };
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Nota sem vetor' }, cookie);
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    const n = await getNoteById(E, data.id);
    expect(n?.title).toBe('Nota sem vetor');
    expect(E.VECTORIZE.upsert).not.toHaveBeenCalled();
  }, 10000);

  it('dedupe: match acima do limiar (0.8) devolve dup com o id da candidata', async () => {
    await seedNote('cand1', 'Candidata existente', 1000);
    E.VECTORIZE = {
      upsert: vi.fn(async () => ({})),
      query: vi.fn(async () => ({ matches: [{ id: 'cand1', score: 0.92 }] })),
    };
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Possível duplicata' }, cookie);
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.dup).toBe('cand1');
  });

  it('dedupe: match abaixo do limiar não vira dup', async () => {
    await seedNote('cand2', 'Candidata fraca', 1000);
    E.VECTORIZE = {
      upsert: vi.fn(async () => ({})),
      query: vi.fn(async () => ({ matches: [{ id: 'cand2', score: 0.5 }] })),
    };
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Não é duplicata' }, cookie);
    const data = (await res.json()) as any;
    expect(data.dup).toBeNull();
  });

  it('inválido: title ausente → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({}, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: title vazio (só espaços) → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: '   ' }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: title acima de 200 chars → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'x'.repeat(201) }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: body não-string → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Título válido', body: 123 }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: json malformado → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await SELF.fetch('https://x/app/notes/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});
