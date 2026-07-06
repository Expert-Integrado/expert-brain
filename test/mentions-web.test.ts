import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { upsertMention, listMentionsForNote, listTasksFromOrigin } from '../src/db/queries.js';
import { newId } from '../src/util/id.js';

// Superfícies WEB das menções (spec 62): seções reversas da página do contato,
// "criar task desta nota", persistência de menção pelo editor e camada de menção do grafo.
// SELF.fetch usa o env real (sem binding CONTACTS) — os handlers Brain-local funcionam,
// e applyMentions engole a ausência do contacts (a menção D1 persiste mesmo assim).
const E = env as any;

function fakeAI() { return { run: vi.fn(async () => ({ data: [Array(1024).fill(0.2)] })) }; }
function fakeVectorize() { return { upsert: vi.fn(async () => ({})), query: vi.fn(async () => ({ matches: [] })) }; }

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function seedNote(id: string, kind = 'concept', priv = 0) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, `Nota ${id}`, 'corpo', 'tldr da nota de teste aqui', '["operations"]', kind, priv, 100, 100).run();
}
async function seedTask(id: string, status: string, priv = 0) {
  const completed = status === 'done' || status === 'canceled' ? 200 : null;
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,completed_at,private,created_at,updated_at) VALUES (?,?,?,?,?, 'task', ?, ?, ?, ?, ?)`
  ).bind(id, `Task ${id}`, 'c', `Task ${id}`, '["operations"]', status, completed, priv, 100, 100).run();
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM mentions');
  await E.DB.exec('DELETE FROM notes');
  E.AI = fakeAI();
  E.VECTORIZE = fakeVectorize();
});

describe('GET /app/contacts/entity/mentions (seções reversas — spec 62 §4)', () => {
  it('lista notas + tasks abertas que mencionam o contato e conta as fechadas', async () => {
    const ent = 'ent_' + newId();
    await seedNote('mn_note');
    await seedTask('mn_open', 'open');
    await seedTask('mn_done', 'done');
    for (const nid of ['mn_note', 'mn_open', 'mn_done']) {
      await upsertMention(E, { id: newId(), noteId: nid, entityId: ent, entityLabel: 'X', now: 1 });
    }
    const res = await SELF.fetch(`https://x/app/contacts/entity/mentions?id=${ent}`, { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.ok).toBe(true);
    expect(d.notes.map((n: any) => n.id)).toEqual(['mn_note']);
    expect(d.tasks_open.map((t: any) => t.id)).toEqual(['mn_open']);   // fechada sai da lista
    expect(d.tasks_closed_count).toBe(1);                              // e entra no contador
  });

  it('sem sessão: 401/302', async () => {
    const res = await SELF.fetch('https://x/app/contacts/entity/mentions?id=abc', { redirect: 'manual' });
    expect([401, 302]).toContain(res.status);
  });
});

describe('POST /app/notes/task-from-note (spec 62 §2)', () => {
  it('cria task com origin_note_id + menções herdadas da nota', async () => {
    const ent = 'ent_' + newId();
    await seedNote('src_note', 'decision');
    await upsertMention(E, { id: newId(), noteId: 'src_note', entityId: ent, entityLabel: 'Herdado', now: 1 });
    const res = await SELF.fetch('https://x/app/notes/task-from-note', {
      method: 'POST',
      headers: { cookie: await cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ note_id: 'src_note' }),
    });
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.ok).toBe(true);
    const tasks = await listTasksFromOrigin(E, 'src_note', true);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(d.id);
    const mentions = await listMentionsForNote(E, d.id);
    expect(mentions.map((m) => m.entity_id)).toEqual([ent]); // menção herdada
  });

  it('note_id de uma task → 404 (task não origina task)', async () => {
    await seedTask('a_task', 'open');
    const res = await SELF.fetch('https://x/app/notes/task-from-note', {
      method: 'POST',
      headers: { cookie: await cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ note_id: 'a_task' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /app/notes/update — mentions/mentions_remove (spec 62 §2)', () => {
  it('adiciona e depois remove menção pelo editor', async () => {
    const ent = 'ent_' + newId();
    await seedNote('edit_note');
    const add = await SELF.fetch('https://x/app/notes/update', {
      method: 'POST',
      headers: { cookie: await cookie(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: 'edit_note', patch: {}, mentions: [ent] }),
    });
    expect(add.status).toBe(200);
    expect((await listMentionsForNote(E, 'edit_note')).map((m) => m.entity_id)).toEqual([ent]);

    const rem = await SELF.fetch('https://x/app/notes/update', {
      method: 'POST',
      headers: { cookie: await cookie(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: 'edit_note', patch: {}, mentions_remove: [ent] }),
    });
    expect(rem.status).toBe(200);
    expect(await listMentionsForNote(E, 'edit_note')).toHaveLength(0);
  });
});

describe('GET /app/graph/data?mentions=1 — camada de menção (spec 62 §3.2)', () => {
  it('anexa nó de contato + aresta de menção só sob o param; default não os traz', async () => {
    const ent = 'gent_' + newId();
    await seedNote('graph_note');
    await upsertMention(E, { id: newId(), noteId: 'graph_note', entityId: ent, entityLabel: 'Grafo', now: 1 });

    const withM = await SELF.fetch('https://x/app/graph/data?mentions=1', { headers: { authorization: 'Bearer tok' } });
    expect(withM.status).toBe(200);
    const p = await withM.json() as any;
    const contactNode = p.nodes.find((n: any) => n.id === `contact:${ent}`);
    expect(contactNode).toBeTruthy();
    expect(contactNode.type).toBe('contact');
    const mentionEdge = p.edges.find((e: any) => e.type === 'mention' && e.source === 'graph_note' && e.target === `contact:${ent}`);
    expect(mentionEdge).toBeTruthy();

    const base = await SELF.fetch('https://x/app/graph/data', { headers: { authorization: 'Bearer tok' } });
    const pb = await base.json() as any;
    expect(pb.nodes.find((n: any) => n.id === `contact:${ent}`)).toBeUndefined();
    expect(pb.edges.find((e: any) => e.type === 'mention')).toBeUndefined();
  });
});
