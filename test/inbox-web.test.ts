import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import {
  handleInboxPage,
  handleInboxAddPost,
  handleInboxResolvePost,
  handleInboxToNotePost,
  handleInboxToTaskPost,
} from '../src/web/inbox.js';
import { handleNotesList } from '../src/web/notes.js';
import { insertInboxItem, getInboxItem, countPendingInbox } from '../src/db/queries.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function req(method: string, path: string, opts: { cookie?: string; form?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: string | undefined;
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  return new Request('https://x' + path, { method, headers, body });
}

function fakeAI() {
  return { run: vi.fn(async () => ({ data: [Array(1024).fill(0.1)] })) };
}
function fakeVectorize() {
  return { upsert: vi.fn(async () => ({})), query: vi.fn(async () => ({ matches: [] })) };
}

async function resetDb(): Promise<void> {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM inbox_items');
  await E.DB.exec('DELETE FROM edges');
  await E.DB.exec('DELETE FROM tags');
  await E.DB.exec('DELETE FROM similar_edges');
  await E.DB.exec('DELETE FROM notes');
}

describe('POST /app/inbox/add (quick-add do console)', () => {
  beforeEach(resetDb);

  it('sem sessão: redireciona pro login e NÃO grava', async () => {
    const res = await handleInboxAddPost(req('POST', '/app/inbox/add', { form: { text: 'x' } }), E);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/app/login');
    expect(await countPendingInbox(E)).toBe(0);
  });

  it('grava com source=console e volta pro inbox', async () => {
    const res = await handleInboxAddPost(req('POST', '/app/inbox/add', { cookie: await cookie(), form: { text: '  nova ideia  ' } }), E);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/inbox');
    const row = await E.DB.prepare('SELECT body, source FROM inbox_items').first();
    expect(row.body).toBe('nova ideia');
    expect(row.source).toBe('console');
  });

  it('texto vazio: no-op (302, nada gravado)', async () => {
    const res = await handleInboxAddPost(req('POST', '/app/inbox/add', { cookie: await cookie(), form: { text: '   ' } }), E);
    expect(res.status).toBe(302);
    expect(await countPendingInbox(E)).toBe(0);
  });
});

describe('POST /app/inbox/resolve (descartar)', () => {
  beforeEach(resetDb);

  it('descartar marca triage_action=discard', async () => {
    await insertInboxItem(E, { id: 'ibx_a', body: 'x', source: 'console', created_at: 1000 });
    const res = await handleInboxResolvePost(req('POST', '/app/inbox/resolve', { cookie: await cookie(), form: { id: 'ibx_a', action: 'discard' } }), E);
    expect(res.status).toBe(302);
    const row = await getInboxItem(E, 'ibx_a');
    expect(row?.triaged_at).not.toBeNull();
    expect(row?.triage_action).toBe('discard');
    expect(await countPendingInbox(E)).toBe(0);
  });
});

describe('POST /app/inbox/to-task (virar task)', () => {
  beforeEach(resetDb);

  it('cria task pré-preenchida, resolve o item e redireciona pro detalhe', async () => {
    await insertInboxItem(E, { id: 'ibx_a', body: 'Ligar pro fornecedor\ncontexto extra', source: 'mcp', created_at: 1000 });
    const res = await handleInboxToTaskPost(req('POST', '/app/inbox/to-task', { cookie: await cookie(), form: { id: 'ibx_a' } }), E);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/^\/app\/tasks\//);
    const taskId = loc.split('/').pop()!;
    const task = await E.DB.prepare("SELECT title, body, kind, status FROM notes WHERE id = ?").bind(taskId).first();
    expect(task.kind).toBe('task');
    expect(task.title).toBe('Ligar pro fornecedor'); // primeira linha
    expect(task.body).toBe('Ligar pro fornecedor\ncontexto extra'); // corpo inteiro
    expect(task.status).toBe('open');
    // item resolvido com action=task + result_id = taskId
    const item = await getInboxItem(E, 'ibx_a');
    expect(item?.triage_action).toBe('task');
    expect(item?.result_id).toBe(taskId);
  });

  it('item já triado: não recria (302 pro inbox)', async () => {
    await insertInboxItem(E, { id: 'ibx_a', body: 'x', source: 'mcp', created_at: 1000 });
    // resolve manualmente antes
    await handleInboxResolvePost(req('POST', '/app/inbox/resolve', { cookie: await cookie(), form: { id: 'ibx_a', action: 'discard' } }), E);
    const res = await handleInboxToTaskPost(req('POST', '/app/inbox/to-task', { cookie: await cookie(), form: { id: 'ibx_a' } }), E);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/inbox');
    const tasks = await E.DB.prepare("SELECT count(*) c FROM notes WHERE kind='task'").first();
    expect(tasks.c).toBe(0);
  });
});

describe('POST /app/inbox/to-note (virar nota)', () => {
  beforeEach(async () => {
    await resetDb();
    E.AI = fakeAI();
    E.VECTORIZE = fakeVectorize();
  });

  it('cria nota pelo fluxo normal (embed+vetor), resolve o item e vai pro editor', async () => {
    await insertInboxItem(E, { id: 'ibx_a', body: 'Insight sobre foco\ndetalhe', source: 'mcp', created_at: 1000 });
    const res = await handleInboxToNotePost(req('POST', '/app/inbox/to-note', { cookie: await cookie(), form: { id: 'ibx_a' } }), E);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/^\/app\/notes\//);
    const noteId = loc.split('/').pop()!;
    const note = await E.DB.prepare('SELECT title, body, kind, tldr FROM notes WHERE id = ?').bind(noteId).first();
    expect(note.kind).toBe('insight');
    expect(note.title).toBe('Insight sobre foco');
    expect(note.body).toBe('Insight sobre foco\ndetalhe');
    // embedou pelo fluxo normal (save_note-like): AI + Vectorize chamados
    expect(E.AI.run).toHaveBeenCalled();
    expect(E.VECTORIZE.upsert).toHaveBeenCalled();
    // item resolvido com result_id = noteId
    const item = await getInboxItem(E, 'ibx_a');
    expect(item?.triage_action).toBe('note');
    expect(item?.result_id).toBe(noteId);
  });

  it('embed falha (AI quebrado): a nota é criada mesmo assim e o item resolve', async () => {
    E.AI = { run: vi.fn(async () => { throw new Error('AI down'); }) };
    await insertInboxItem(E, { id: 'ibx_b', body: 'ideia resiliente', source: 'mcp', created_at: 2000 });
    const res = await handleInboxToNotePost(req('POST', '/app/inbox/to-note', { cookie: await cookie(), form: { id: 'ibx_b' } }), E);
    expect(res.status).toBe(302);
    const noteId = res.headers.get('location')!.split('/').pop()!;
    const note = await E.DB.prepare('SELECT title FROM notes WHERE id = ?').bind(noteId).first();
    expect(note.title).toBe('ideia resiliente');
    const item = await getInboxItem(E, 'ibx_b');
    expect(item?.triage_action).toBe('note');
    expect(item?.result_id).toBe(noteId);
  });
});

describe('página /app/inbox + badge na navegação', () => {
  beforeEach(resetDb);

  it('lista pendentes e mostra o quick-add', async () => {
    await insertInboxItem(E, { id: 'ibx_a', body: 'primeira ideia', source: 'mcp', created_at: 1000 });
    const res = await handleInboxPage(req('GET', '/app/inbox', { cookie: await cookie() }), E);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('primeira ideia');
    expect(html).toContain('/app/inbox/add'); // quick-add form
    expect(html).toContain('/app/inbox/to-note');
    expect(html).toContain('/app/inbox/to-task');
  });

  it('badge na nav mostra a contagem e some em zero', async () => {
    // 2 pendentes → badge "2" na nav de QUALQUER página (aqui: notas)
    await insertInboxItem(E, { id: 'ibx_a', body: 'x', source: 'mcp', created_at: 1000 });
    await insertInboxItem(E, { id: 'ibx_b', body: 'y', source: 'mcp', created_at: 2000 });
    const withBadge = await (await handleNotesList(req('GET', '/app/notes', { cookie: await cookie() }), E)).text();
    // O span do badge (não a regra CSS .nav-badge, sempre presente): checa pela aria-label.
    expect(withBadge).toContain('class="nav-badge"');
    expect(withBadge).toContain('aria-label="2 na triagem"');

    // zera → badge some (a aria-label "na triagem" não existe no CSS, então é sinal limpo)
    await handleInboxResolvePost(req('POST', '/app/inbox/resolve', { cookie: await cookie(), form: { id: 'ibx_a', action: 'discard' } }), E);
    await handleInboxResolvePost(req('POST', '/app/inbox/resolve', { cookie: await cookie(), form: { id: 'ibx_b', action: 'discard' } }), E);
    const noBadge = await (await handleNotesList(req('GET', '/app/notes', { cookie: await cookie() }), E)).text();
    expect(noBadge).not.toContain('class="nav-badge"');
    expect(noBadge).not.toContain('na triagem');
  });
});
