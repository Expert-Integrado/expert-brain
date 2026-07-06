import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { registerSaveNote } from '../../src/mcp/tools/save-note.js';
import { registerUpdateNote } from '../../src/mcp/tools/update-note.js';
import { registerSaveTask } from '../../src/mcp/tools/save-task.js';
import { registerUpdateTask } from '../../src/mcp/tools/update-task.js';
import { registerGetNote } from '../../src/mcp/tools/get-note.js';
import { registerGetTask } from '../../src/mcp/tools/get-task.js';
import { registerListTasks } from '../../src/mcp/tools/list-tasks.js';
import {
  upsertMention, removeMention, listMentionsForNote, listNotesMentioning,
  countNotesMentioning, listTasksFromOrigin, listNoteIdsMentioning,
} from '../../src/db/queries.js';
import { newId } from '../../src/util/id.js';
import type { AuthContext } from '../../src/env.js';

// Suíte das MENÇÕES (spec 50-console-v2/62). O tecido conectivo nota↔task↔contato.
const E = env as any;

const OWNER: AuthContext = { email: 'o@x', loggedInAt: 0 };                                 // sem keyId = vê privados
const NO_PRIV: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'k1' };  // PAT sem escopo private

function fakeAI() { return { run: vi.fn(async () => ({ data: [Array(1024).fill(0.1)] })) }; }
function fakeVectorize() { return { upsert: vi.fn(async () => ({})), query: vi.fn(async () => ({ matches: [] })) }; }

function collector() {
  const tools: Record<string, any> = {};
  const server: any = { registerTool: (n: string, _c: any, h: any) => { tools[n] = h; } };
  return { server, tools };
}

// Mock do Worker de contatos (service binding). `privateIds` são entidades privadas:
// GET /app/entity só as devolve com o header x-include-private:1 (senão 404), espelhando
// o callerSeesPrivate real do contacts. POST /app/entity/event é registrado em `events`.
function mockContacts(opts: { privateIds?: string[]; throwOnFetch?: boolean } = {}) {
  const events: Array<{ entity_id: string; kind: string; context: string; source: string }> = [];
  const priv = new Set(opts.privateIds ?? []);
  const fetcher = {
    fetch: async (req: Request) => {
      if (opts.throwOnFetch) throw new Error('contacts binding down');
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/app/entity/event') {
        const b = await req.json().catch(() => ({}));
        events.push({ entity_id: (b as any).entity_id, kind: (b as any).kind, context: (b as any).context, source: (b as any).source });
        return new Response(JSON.stringify({ ok: true, id: newId() }), { headers: { 'content-type': 'application/json' } });
      }
      if (req.method === 'GET' && url.pathname === '/app/entity') {
        const id = url.searchParams.get('id') || '';
        const seesPriv = req.headers.get('x-include-private') === '1';
        if (priv.has(id) && !seesPriv) {
          return new Response(JSON.stringify({ ok: false, error: 'entity_not_found', id }), { status: 404, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true, title: `Contato ${id}`, kind: 'person' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
    },
  };
  return { fetcher, events };
}

async function resetDb() {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM mentions');
  await E.DB.exec('DELETE FROM edges');
  await E.DB.exec('DELETE FROM tags');
  await E.DB.exec('DELETE FROM notes');
}

beforeEach(async () => {
  await resetDb();
  E.AI = fakeAI();
  E.VECTORIZE = fakeVectorize();
  E.WORKER_URL = 'https://brain.example';
  E.CONTACTS_PROXY_TOKEN = 'proxy-tok';
  E.CONTACTS_WRITE_TOKEN = 'write-tok';
  E.CONTACTS = undefined;
});

describe('mentions — camada de dados (queries)', () => {
  it('upsert cria (true) e dedupa por (note_id, entity_id) — retorna false na 2ª', async () => {
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES ('n1','t','b','tl','["operations"]','concept',1,1)`).run();
    const first = await upsertMention(E, { id: newId(), noteId: 'n1', entityId: 'e1', entityLabel: 'Alice', now: 1 });
    const second = await upsertMention(E, { id: newId(), noteId: 'n1', entityId: 'e1', entityLabel: 'Alice Nova', now: 2 });
    expect(first).toBe(true);
    expect(second).toBe(false);
    const rows = await listMentionsForNote(E, 'n1');
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_label).toBe('Alice Nova'); // label refrescado no conflito
  });

  it('remove tira a menção e retorna false se já não existe', async () => {
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES ('n1','t','b','tl','["operations"]','concept',1,1)`).run();
    await upsertMention(E, { id: newId(), noteId: 'n1', entityId: 'e1', entityLabel: null, now: 1 });
    expect(await removeMention(E, 'n1', 'e1')).toBe(true);
    expect(await removeMention(E, 'n1', 'e1')).toBe(false);
    expect(await listMentionsForNote(E, 'n1')).toHaveLength(0);
  });

  it('listNotesMentioning separa conhecimento de task e respeita status/privado', async () => {
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES ('kn','Nota','b','tl','["operations"]','concept',5,5)`).run();
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,status,created_at,updated_at) VALUES ('t_open','Task aberta','b','t','["operations"]','task','open',6,6)`).run();
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,status,completed_at,created_at,updated_at) VALUES ('t_done','Task feita','b','t','["operations"]','task','done',7,7,7)`).run();
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_at,updated_at) VALUES ('kn_priv','Secreta','b','tl','["operations"]','concept',1,8,8)`).run();
    for (const nid of ['kn', 't_open', 't_done', 'kn_priv']) {
      await upsertMention(E, { id: newId(), noteId: nid, entityId: 'E', entityLabel: null, now: 1 });
    }
    const knowledgePublic = await listNotesMentioning(E, 'E', { mode: 'knowledge' });
    expect(knowledgePublic.map((n) => n.id).sort()).toEqual(['kn']); // privada escondida (fail-closed)
    const knowledgeAll = await listNotesMentioning(E, 'E', { mode: 'knowledge', includePrivate: true });
    expect(knowledgeAll.map((n) => n.id).sort()).toEqual(['kn', 'kn_priv']);
    const tasksOpen = await listNotesMentioning(E, 'E', { mode: 'task', statuses: ['open', 'in_progress'] });
    expect(tasksOpen.map((n) => n.id)).toEqual(['t_open']);
    const closed = await countNotesMentioning(E, 'E', { mode: 'task', statuses: ['done', 'canceled'] });
    expect(closed).toBe(1);
    expect((await listNoteIdsMentioning(E, 'E')).size).toBe(4);
  });
});

describe('save_note — mentions', () => {
  it('cria a menção e dispara mentioned_in_brain na timeline do contato', async () => {
    const { fetcher, events } = mockContacts();
    E.CONTACTS = fetcher;
    const { tools } = collector();
    registerSaveNote({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);
    const r = await tools.save_note({
      title: 'Reunião', body: 'b', tldr: 'decidimos algo importante aqui hoje', domains: ['operations'], kind: 'decision',
      mentions: ['ent1'],
    });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0].text);
    expect(out.mentions_created).toBe(1);
    const rows = await listMentionsForNote(E, out.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe('ent1');
    expect(rows[0].entity_label).toBe('Contato ent1'); // label cacheado do contacts
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entity_id: 'ent1', kind: 'mentioned_in_brain', source: 'brain_bridge' });
  });

  it('binding do contacts CAINDO não impede o save (critério 7)', async () => {
    const { fetcher } = mockContacts({ throwOnFetch: true });
    E.CONTACTS = fetcher;
    const { tools } = collector();
    registerSaveNote({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);
    const r = await tools.save_note({
      title: 'Nota', body: 'b', tldr: 'conteudo relevante da nota aqui', domains: ['operations'], kind: 'concept',
      mentions: ['entX'],
    });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0].text);
    // A nota foi salva mesmo com o contacts fora do ar; a menção (D1) também persistiu.
    const note = await E.DB.prepare('SELECT id FROM notes WHERE id = ?').bind(out.id).first();
    expect(note).not.toBeNull();
    expect(await listMentionsForNote(E, out.id)).toHaveLength(1);
  });
});

describe('save_task — origin_note_id e herança de menções', () => {
  it('herda as menções da nota de origem quando mentions é omitido', async () => {
    const { fetcher, events } = mockContacts();
    E.CONTACTS = fetcher;
    // nota de origem com 2 menções
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES ('origin','Origem','b','tl','["operations"]','decision',1,1)`).run();
    await upsertMention(E, { id: newId(), noteId: 'origin', entityId: 'a1', entityLabel: 'A', now: 1 });
    await upsertMention(E, { id: newId(), noteId: 'origin', entityId: 'a2', entityLabel: 'B', now: 1 });
    const { tools } = collector();
    registerSaveTask({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);
    const r = await tools.save_task({ title: 'Follow-up', origin_note_id: 'origin' });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0].text);
    expect(out.origin_note_id).toBe('origin');
    const inherited = (await listMentionsForNote(E, out.id)).map((m) => m.entity_id).sort();
    expect(inherited).toEqual(['a1', 'a2']);
    expect(await listTasksFromOrigin(E, 'origin')).toHaveLength(1);
    // 2 eventos disparados (um por menção nova)
    expect(events.filter((e) => e.kind === 'mentioned_in_brain')).toHaveLength(2);
  });

  it('origin_note_id inexistente → erro (não cria task)', async () => {
    const { tools } = collector();
    registerSaveTask({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);
    const r = await tools.save_task({ title: 'X', origin_note_id: 'ghost' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ghost');
    const count = await E.DB.prepare(`SELECT count(*) c FROM notes WHERE kind = 'task'`).first();
    expect(count.c).toBe(0);
  });
});

describe('list_tasks — filtro mentions_entity', () => {
  it('filtra só as tasks que mencionam a entidade', async () => {
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,status,created_at,updated_at) VALUES ('tA','Task A','b','t','["operations"]','task','open',1,1)`).run();
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,status,created_at,updated_at) VALUES ('tB','Task B','b','t','["operations"]','task','open',2,2)`).run();
    await upsertMention(E, { id: newId(), noteId: 'tA', entityId: 'target', entityLabel: null, now: 1 });
    const { tools } = collector();
    registerListTasks({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);
    const r = await tools.list_tasks({ mentions_entity: 'target' });
    const out = JSON.parse(r.content[0].text);
    expect(out.count).toBe(1);
    expect(out.tasks[0].id).toBe('tA');
    // entidade sem menção → vazio
    const r2 = await tools.list_tasks({ mentions_entity: 'nobody' });
    expect(JSON.parse(r2.content[0].text).count).toBe(0);
  });
});

describe('get_note / get_task — mentions[] e omissão de label', () => {
  it('get_note e get_task retornam mentions[]; get_task inclui origin_note_id', async () => {
    const { fetcher } = mockContacts();
    E.CONTACTS = fetcher;
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES ('n1','Nota','b','tl','["operations"]','concept',1,1)`).run();
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,status,origin_note_id,created_at,updated_at) VALUES ('t1','Task','b','t','["operations"]','task','open','n1',1,1)`).run();
    await upsertMention(E, { id: newId(), noteId: 'n1', entityId: 'pub1', entityLabel: 'Pub', now: 1 });
    await upsertMention(E, { id: newId(), noteId: 't1', entityId: 'pub1', entityLabel: 'Pub', now: 1 });

    const { tools } = collector();
    registerGetNote({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);
    registerGetTask({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);

    const noteOut = JSON.parse((await tools.get_note({ id: 'n1' })).content[0].text);
    expect(noteOut.mentions).toEqual([{ entity_id: 'pub1', label: 'Pub' }]);

    const taskOut = JSON.parse((await tools.get_task({ id: 't1' })).content[0].text);
    expect(taskOut.mentions).toEqual([{ entity_id: 'pub1', label: 'Pub' }]);
    expect(taskOut.origin_note_id).toBe('n1');
  });

  it('caller SEM escopo private: menção a contato PRIVADO vem sem label (critério 8)', async () => {
    const { fetcher } = mockContacts({ privateIds: ['secret'] });
    E.CONTACTS = fetcher;
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES ('n1','Nota','b','tl','["operations"]','concept',1,1)`).run();
    // menção com label cacheado (como se o dono tivesse criado)
    await upsertMention(E, { id: newId(), noteId: 'n1', entityId: 'secret', entityLabel: 'Nome Sensível', now: 1 });
    await upsertMention(E, { id: newId(), noteId: 'n1', entityId: 'pub', entityLabel: 'Público', now: 1 });

    // Caller COM escopo (owner): vê os dois labels.
    const owner = collector();
    registerGetNote({ registerTool: (n: string, _c: any, h: any) => { (owner.tools as any)[n] = h; } }, E, OWNER);
    const ownerOut = JSON.parse((await owner.tools.get_note({ id: 'n1' })).content[0].text);
    const ownerSecret = ownerOut.mentions.find((m: any) => m.entity_id === 'secret');
    expect(ownerSecret.label).toBe('Nome Sensível');

    // Caller SEM escopo: contato privado vem sem label; público mantém.
    const guest = collector();
    registerGetNote({ registerTool: (n: string, _c: any, h: any) => { (guest.tools as any)[n] = h; } }, E, NO_PRIV);
    const guestOut = JSON.parse((await guest.tools.get_note({ id: 'n1' })).content[0].text);
    const guestSecret = guestOut.mentions.find((m: any) => m.entity_id === 'secret');
    const guestPub = guestOut.mentions.find((m: any) => m.entity_id === 'pub');
    expect(guestSecret).toEqual({ entity_id: 'secret' }); // label omitido
    expect(guestPub.label).toBe('Público');
  });
});

describe('update_note / update_task — mentions_remove', () => {
  it('update_note remove a menção via mentions_remove', async () => {
    const { fetcher } = mockContacts();
    E.CONTACTS = fetcher;
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES ('n1','Nota','b','tl','["operations"]','concept',1,1)`).run();
    await upsertMention(E, { id: newId(), noteId: 'n1', entityId: 'e1', entityLabel: 'E1', now: 1 });
    const { tools } = collector();
    registerUpdateNote({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);
    const r = await tools.update_note({ id: 'n1', mentions_remove: ['e1'] });
    expect(r.isError).toBeUndefined();
    expect(await listMentionsForNote(E, 'n1')).toHaveLength(0);
  });

  it('update_task adiciona menção nova via mentions', async () => {
    const { fetcher, events } = mockContacts();
    E.CONTACTS = fetcher;
    await E.DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,status,created_at,updated_at) VALUES ('t1','Task','b','t','["operations"]','task','open',1,1)`).run();
    const { tools } = collector();
    registerUpdateTask({ registerTool: (n: string, _c: any, h: any) => { (tools as any)[n] = h; } }, E, OWNER);
    const r = await tools.update_task({ id: 't1', mentions: ['e9'] });
    expect(r.isError).toBeUndefined();
    expect((await listMentionsForNote(E, 't1')).map((m) => m.entity_id)).toEqual(['e9']);
    expect(events.filter((e) => e.entity_id === 'e9')).toHaveLength(1);
  });
});
