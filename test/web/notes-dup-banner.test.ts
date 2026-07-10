import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { handleNoteDetail } from '../../src/web/notes.js';

// TDD da spec 70-grafo-higiene/75: o detalhe da nota renderiza um banner
// informativo quando chega com ?dup=<id> (redirect pós-criação do to-note do
// inbox) e a nota candidata existe/está viva.

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function seedNote(id: string, title: string, opts: { deleted?: boolean } = {}): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, title, 'corpo de teste', 'tldr da nota de teste', '["operations"]', 'concept', 1000, 1000, opts.deleted ? 2000 : null).run();
}

describe('detalhe da nota — banner de possível duplicata (spec 75, ?dup=)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM edges');
    await E.DB.exec('DELETE FROM similar_edges');
    await E.DB.exec('DELETE FROM notes');
  });

  it('com ?dup=<id> de candidata viva: renderiza o banner com link e título da candidata', async () => {
    await seedNote('n1', 'Nota nova recém-criada');
    await seedNote('n2', 'Nota candidata a duplicata');
    const req = new Request('https://x/app/notes/n1?dup=n2', { headers: { cookie: await cookie() } });
    const res = await handleNoteDetail(req, E, 'n1');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Possível duplicata de');
    expect(html).toContain('Nota candidata a duplicata');
    expect(html).toContain('href="/app/notes/n2"');
  });

  it('sem ?dup=: fluxo idêntico ao atual, sem banner', async () => {
    await seedNote('n1', 'Nota nova recém-criada');
    const req = new Request('https://x/app/notes/n1', { headers: { cookie: await cookie() } });
    const res = await handleNoteDetail(req, E, 'n1');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Possível duplicata de');
  });

  it('?dup=<id> de nota deletada: banner some silenciosamente (sem erro)', async () => {
    await seedNote('n1', 'Nota nova recém-criada');
    await seedNote('n2', 'Nota apagada', { deleted: true });
    const req = new Request('https://x/app/notes/n1?dup=n2', { headers: { cookie: await cookie() } });
    const res = await handleNoteDetail(req, E, 'n1');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Possível duplicata de');
  });

  it('?dup=<id> inexistente: banner some silenciosamente (sem 500)', async () => {
    await seedNote('n1', 'Nota nova recém-criada');
    const req = new Request('https://x/app/notes/n1?dup=fantasma', { headers: { cookie: await cookie() } });
    const res = await handleNoteDetail(req, E, 'n1');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Possível duplicata de');
  });
});
