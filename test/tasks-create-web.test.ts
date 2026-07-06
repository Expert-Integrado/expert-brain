import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { getTaskById, createKanbanColumn, setColumnArchived } from '../src/db/queries.js';

const E = env as any;

// Sessão de browser válida pro OWNER_EMAIL/SESSION_SECRET do vitest.config.ts.
async function sessionCookieHeader(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function post(body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  return SELF.fetch('https://x/app/tasks/create', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /app/tasks/create (criação de task pela UI — spec 36 fase 2)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('sem sessão nem Bearer: 401 quando accept é JSON', async () => {
    const res = await post({ title: 'Comprar leite' });
    expect(res.status).toBe(401);
  });

  it('feliz: cria task open com título e devolve 201 + id', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Comprar leite' }, cookie);
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(typeof data.id).toBe('string');
    expect(data.status).toBe('open');
    expect(data.priority).toBeNull();
    expect(data.due_at).toBeNull();
    // Persistiu no banco como task open, domínio default ['operations'].
    const t = await getTaskById(E, data.id);
    expect(t?.title).toBe('Comprar leite');
    expect(t?.status).toBe('open');
    expect(t?.kind).toBe('task');
    expect(t?.domains).toBe('["operations"]');
    expect(t?.body).toBe('Comprar leite'); // sem descrição → cai no título
    expect(t?.tldr).toBe('Comprar leite');
  });

  it('feliz completo: body + priority + due (data+hora) persistem', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post(
      { title: 'Ligar pro cliente', body: 'Contexto aqui', priority: 1, due: '2026-07-10T14:00' },
      cookie
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.priority).toBe(1);
    expect(typeof data.due_at).toBe('number');
    const t = await getTaskById(E, data.id);
    expect(t?.priority).toBe(1);
    expect(t?.body).toBe('Contexto aqui');
    expect(t?.due_at).not.toBeNull();
  });

  it('due só-data ("2026-07-10") vira fim do dia (23:59 BRT)', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Entregar relatório', due: '2026-07-10' }, cookie);
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    // due_brt omite a hora quando é fim-de-dia-sem-hora (convenção 23:59).
    expect(data.due_brt).toBe('10/07/2026');
    const t = await getTaskById(E, data.id);
    expect(t?.due_at).not.toBeNull();
  });

  it('domains custom válido persiste', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Estudar', domains: ['education'] }, cookie);
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    const t = await getTaskById(E, data.id);
    expect(t?.domains).toBe('["education"]');
  });

  it('inválido: título vazio → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: '   ' }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: título ausente → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ body: 'sem título' }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: priority fora de 1-4 → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'x', priority: 9 }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: due não-parseável → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'x', due: 'amanhã de tarde' }, cookie);
    expect(res.status).toBe(400);
  });

  it('inválido: domínio desconhecido → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'x', domains: ['dominio-que-nao-existe'] }, cookie);
    expect(res.status).toBe(400);
  });

  it('json inválido → 400', async () => {
    const cookie = await sessionCookieHeader();
    const res = await SELF.fetch('https://x/app/tasks/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', cookie },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /app/tasks/create com column_id (criação inline no rodapé da coluna — spec 52)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
    await E.DB.exec('DELETE FROM kanban_columns');
  });

  it('column_id de uma coluna ativa: task nasce nela, status = categoria da coluna', async () => {
    const cookie = await sessionCookieHeader();
    const col = await createKanbanColumn(E, { id: 'col_aguardando', label: 'Aguardando', color: null, category: 'in_progress' });
    const res = await post({ title: 'Ligar de volta', column_id: col.id }, cookie);
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.status).toBe('in_progress');
    expect(data.column_id).toBe(col.id);
    const t = await getTaskById(E, data.id);
    expect(t?.column_id).toBe(col.id);
    expect(t?.status).toBe('in_progress');
  });

  it('column_id inexistente → 404', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'x', column_id: 'col_nao_existe' }, cookie);
    expect(res.status).toBe(404);
  });

  it('column_id arquivado → 404', async () => {
    const cookie = await sessionCookieHeader();
    const col = await createKanbanColumn(E, { id: 'col_velha', label: 'Velha', color: null, category: 'open' });
    await setColumnArchived(E, col.id, Date.now());
    const res = await post({ title: 'x', column_id: col.id }, cookie);
    expect(res.status).toBe(404);
  });

  it('sem column_id: comportamento default inalterado (status open, sem column_id na resposta)', async () => {
    const cookie = await sessionCookieHeader();
    const res = await post({ title: 'Sem coluna' }, cookie);
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.status).toBe('open');
    expect(data.column_id).toBeNull();
  });
});
