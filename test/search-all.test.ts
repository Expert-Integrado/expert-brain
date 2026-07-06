import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { insertNote, insertTask } from '../src/db/queries.js';
import { signSession } from '../src/web/session.js';

// Agregador da paleta de comando (spec 50-console-v2/66): GET /app/search/all
// combina notas (ftsSearch) + tasks (ftsSearchTasks) + contatos (proxy CONTACTS)
// num request só. Storage é COMPARTILHADO entre arquivos de teste
// (isolatedStorage:false — ver test/queries.test.ts) — cada teste usa um token
// único em vez de truncar tabelas, pra não colidir com fixtures de outros arquivos.
const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => { await runMigrations(E); });

describe('GET /app/search/all (spec 66 — agregador da paleta)', () => {
  it('sem sessão → 401 (data request)', async () => {
    const res = await SELF.fetch('https://x/app/search/all?q=qualquer', {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  it('q vazio → 3 grupos vazios, sem tocar as fontes', async () => {
    const res = await SELF.fetch('https://x/app/search/all', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d).toEqual({ notes: [], tasks: [], contacts: [] });
  });

  it('retorna os 3 grupos: termo em nota E em task acha os dois; contatos degrada (sem binding no teste)', async () => {
    const token = 'qxaggregtermo';
    await insertNote(E, {
      id: `n_${token}`, title: `Nota ${token}`, body: 'corpo qualquer',
      tldr: `tldr da nota ${token}`, domains: JSON.stringify(['operations', 'product']),
      kind: 'concept', created_at: 1, updated_at: 1,
    });
    const dueAt = Date.UTC(2026, 6, 10, 14, 0);
    await insertTask(E, {
      id: `t_${token}`, title: `Task ${token}`, body: `Task ${token}`, tldr: `Task ${token}`,
      domains: JSON.stringify(['operations']), status: 'open', due_at: dueAt, priority: 2,
      created_at: 1, updated_at: 1,
    });

    const res = await SELF.fetch(`https://x/app/search/all?q=${token}`, { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const d = await res.json() as any;

    expect(d.notes).toEqual([{ id: `n_${token}`, title: `Nota ${token}`, kind: 'concept', domain: 'operations' }]);
    expect(d.tasks).toHaveLength(1);
    expect(d.tasks[0]).toMatchObject({ id: `t_${token}`, title: `Task ${token}`, status: 'open' });
    expect(typeof d.tasks[0].due_brt).toBe('string');

    // Ambiente de teste não tem o binding CONTACTS (mesmo padrão de
    // test/contacts-events-recent-proxy.test.ts) — grupo vazio + degradado, nunca 500.
    expect(d.contacts).toEqual([]);
    expect(d.degraded).toEqual(['contacts']);
  });

  it('cap de 6 por grupo — notas e tasks', async () => {
    const token = 'qxcaptoken';
    for (let i = 0; i < 8; i++) {
      await insertNote(E, {
        id: `n_${token}_${i}`, title: `Nota ${token} ${i}`, body: '',
        tldr: `tldr ${token} ${i}`, domains: JSON.stringify(['operations']),
        kind: null, created_at: 1, updated_at: 1,
      });
      await insertTask(E, {
        id: `t_${token}_${i}`, title: `Task ${token} ${i}`, body: `Task ${token} ${i}`,
        tldr: `Task ${token} ${i}`, domains: JSON.stringify(['operations']), status: 'open',
        due_at: null, priority: null, created_at: 1, updated_at: 1,
      });
    }

    const res = await SELF.fetch(`https://x/app/search/all?q=${token}`, { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.notes).toHaveLength(6);
    expect(d.tasks).toHaveLength(6);
  });

  it('inclui nota e task PRIVADAS — sessão é o dono (spec 31/59)', async () => {
    const token = 'qxprivtoken';
    await insertNote(E, {
      id: `n_${token}`, title: `Nota ${token}`, body: '', tldr: `tldr ${token}`,
      domains: JSON.stringify(['operations']), kind: null, created_at: 1, updated_at: 1,
      private: 1,
    });
    await insertTask(E, {
      id: `t_${token}`, title: `Task ${token}`, body: `Task ${token}`, tldr: `Task ${token}`,
      domains: JSON.stringify(['operations']), status: 'open', due_at: null, priority: null,
      created_at: 1, updated_at: 1, private: 1,
    });

    const res = await SELF.fetch(`https://x/app/search/all?q=${token}`, { headers: { cookie: await cookie() } });
    const d = await res.json() as any;
    expect(d.notes.map((n: any) => n.id)).toContain(`n_${token}`);
    expect(d.tasks.map((t: any) => t.id)).toContain(`t_${token}`);
  });
});
