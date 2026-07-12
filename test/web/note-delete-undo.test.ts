import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';

// Undo com toast (specs/91-experiencia-premium/95): delete de nota vira soft-delete
// acessível pela web (303 → lista com ?deleted=, o shell mostra o toast "Desfazer")
// e o restore ganha rota web espelhando o restore_note do MCP. Task NÃO se deleta
// pela web (mesma regra do delete_note MCP: task tem ciclo próprio — cancelar).

const E = env as any;
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  // Delete espelha o MCP: remove do Vectorize primeiro; restore re-embeda.
  E.VECTORIZE = {
    deleteByIds: async () => ({}),
    upsert: async () => ({}),
    query: async () => ({ matches: [] }),
  };
  E.AI = { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) };
  await runMigrations(E);
});

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function seedNote(id: string, kind = 'insight', deletedAt: number | null = null): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id, title, body, tldr, domains, kind, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'corpo', 'tldr da nota', '["operations"]', ?, 1, 1, ?)`
  ).bind(id, `Nota ${id}`, kind, deletedAt).run();
}

beforeEach(async () => {
  await E.DB.exec(`DELETE FROM notes WHERE id LIKE 'undo_%'`);
  await E.DB.exec(`DELETE FROM edges WHERE from_id LIKE 'undo_%' OR to_id LIKE 'undo_%'`);
});

describe('POST /app/notes/:id/delete (spec 95)', () => {
  it('soft-deleta e redireciona pra lista com ?deleted= (gatilho do toast Desfazer)', async () => {
    await seedNote('undo_n1');
    const res = await SELF.fetch('https://x.test/app/notes/undo_n1/delete', {
      method: 'POST', headers: { cookie: await authCookie() }, redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/app/notes?deleted=undo_n1');
    const row = await E.DB.prepare(`SELECT deleted_at FROM notes WHERE id = 'undo_n1'`).first();
    expect(row.deleted_at).not.toBeNull();
  });

  it('task NÃO se deleta pela web (mesma regra do MCP) — 404', async () => {
    await seedNote('undo_t1', 'task');
    const res = await SELF.fetch('https://x.test/app/notes/undo_t1/delete', {
      method: 'POST',
      headers: { cookie: await authCookie(), accept: 'application/json' },
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
    const row = await E.DB.prepare(`SELECT deleted_at FROM notes WHERE id = 'undo_t1'`).first();
    expect(row.deleted_at).toBeNull();
  });

  it('id inexistente → 404; sem sessão → não deleta', async () => {
    const miss = await SELF.fetch('https://x.test/app/notes/undo_nope/delete', {
      method: 'POST',
      headers: { cookie: await authCookie(), accept: 'application/json' },
      redirect: 'manual',
    });
    expect(miss.status).toBe(404);

    await seedNote('undo_n2');
    const anon = await SELF.fetch('https://x.test/app/notes/undo_n2/delete', {
      method: 'POST', redirect: 'manual',
    });
    expect([302, 401]).toContain(anon.status);
    const row = await E.DB.prepare(`SELECT deleted_at FROM notes WHERE id = 'undo_n2'`).first();
    expect(row.deleted_at).toBeNull();
  });
});

describe('POST /app/notes/:id/restore (spec 95)', () => {
  it('restaura nota deletada preservando edges', async () => {
    await seedNote('undo_n3', 'insight', 111);
    await seedNote('undo_n4');
    await E.DB.prepare(
      `INSERT INTO edges (id, from_id, to_id, relation_type, why, created_at) VALUES ('undo_e1', 'undo_n3', 'undo_n4', 'analogous_to', 'mesmo mecanismo de teste', 1)`
    ).run();

    const res = await SELF.fetch('https://x.test/app/notes/undo_n3/restore', {
      method: 'POST', headers: { cookie: await authCookie(), accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const row = await E.DB.prepare(`SELECT deleted_at FROM notes WHERE id = 'undo_n3'`).first();
    expect(row.deleted_at).toBeNull();
    const edge = await E.DB.prepare(`SELECT COUNT(*) AS n FROM edges WHERE from_id = 'undo_n3'`).first();
    expect(edge.n).toBe(1);
  });

  it('404 pra id inexistente ou nota NÃO deletada', async () => {
    await seedNote('undo_n5');
    const ck = await authCookie();
    const notDeleted = await SELF.fetch('https://x.test/app/notes/undo_n5/restore', {
      method: 'POST', headers: { cookie: ck, accept: 'application/json' },
    });
    expect(notDeleted.status).toBe(404);
    const missing = await SELF.fetch('https://x.test/app/notes/undo_nope/restore', {
      method: 'POST', headers: { cookie: ck, accept: 'application/json' },
    });
    expect(missing.status).toBe(404);
  });

  it('exige sessão', async () => {
    await seedNote('undo_n6', 'insight', 111);
    const res = await SELF.fetch('https://x.test/app/notes/undo_n6/restore', {
      method: 'POST', redirect: 'manual',
    });
    expect([302, 401]).toContain(res.status);
    const row = await E.DB.prepare(`SELECT deleted_at FROM notes WHERE id = 'undo_n6'`).first();
    expect(row.deleted_at).not.toBeNull();
  });
});

describe('botão Excluir no detalhe (spec 95)', () => {
  it('detalhe da nota tem o form de excluir apontando pra rota de delete', async () => {
    await seedNote('undo_n7');
    const res = await SELF.fetch('https://x.test/app/notes/undo_n7', { headers: { cookie: await authCookie() } });
    const html = await res.text();
    expect(html).toContain('/app/notes/undo_n7/delete');
  });
});
