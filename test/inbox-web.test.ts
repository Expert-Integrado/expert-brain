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

  // spec 68 (PWA share target): hidden input do form manda source=pwa-share quando
  // a página chegou via Web Share Target.
  it('grava com source=pwa-share quando o form manda esse source', async () => {
    const res = await handleInboxAddPost(
      req('POST', '/app/inbox/add', { cookie: await cookie(), form: { text: 'compartilhado do outro app', source: 'pwa-share' } }),
      E
    );
    expect(res.status).toBe(302);
    const row = await E.DB.prepare('SELECT body, source FROM inbox_items').first();
    expect(row.body).toBe('compartilhado do outro app');
    expect(row.source).toBe('pwa-share');
  });

  it('source fora da allowlist cai no default console (sem spoof)', async () => {
    const res = await handleInboxAddPost(
      req('POST', '/app/inbox/add', { cookie: await cookie(), form: { text: 'x', source: 'telegram' } }),
      E
    );
    expect(res.status).toBe(302);
    const row = await E.DB.prepare('SELECT source FROM inbox_items').first();
    expect(row.source).toBe('console');
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

  // TDD spec 70-grafo-higiene/75: aviso de duplicata no to-note — pré-consulta de
  // vizinhança IGUAL ao save_note, reusando os matches pra similar_edges (sem 2ª
  // query ao Vectorize) e redirecionando com ?dup= quando bate o gate de dedup.
  it('melhor match >= 0.80 (DEDUP_MIN_SCORE): redireciona com ?dup=<id> e consulta o Vectorize só 1x', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at)
       VALUES ('dup-1','Nota já existente sobre o mesmo tema','corpo','tldr da existente','["operations"]','concept',500,500,NULL)`
    ).run();
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'dup-1', score: 0.86 }] }));
    await insertInboxItem(E, { id: 'ibx_dup', body: 'ideia repetida\ndetalhe', source: 'mcp', created_at: 1000 });
    const res = await handleInboxToNotePost(req('POST', '/app/inbox/to-note', { cookie: await cookie(), form: { id: 'ibx_dup' } }), E);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/^\/app\/notes\/[^/]+\?dup=dup-1$/);
    // consulta ao Vectorize ocorreu 1x só — persistSimilarEdgesFromMatches reusa os
    // mesmos matches (nunca uma 2ª query idêntica, era o refreshSimilarEdges antigo).
    expect(E.VECTORIZE.query).toHaveBeenCalledTimes(1);
    const noteId = loc.split('/').pop()!.split('?')[0];
    const edges = await E.DB.prepare('SELECT to_id FROM similar_edges WHERE from_id = ?').bind(noteId).all();
    expect((edges.results ?? []).map((e: any) => e.to_id)).toContain('dup-1');
  });

  it('sem candidata acima do gate (score < 0.80 ou sem matches): redirect limpo, sem ?dup=', async () => {
    E.VECTORIZE.query = vi.fn(async () => ({ matches: [{ id: 'vizinha', score: 0.5 }] }));
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at)
       VALUES ('vizinha','Vizinha distante','corpo','tldr','["operations"]','concept',500,500,NULL)`
    ).run();
    await insertInboxItem(E, { id: 'ibx_sem_dup', body: 'ideia nova de verdade', source: 'mcp', created_at: 1000 });
    const res = await handleInboxToNotePost(req('POST', '/app/inbox/to-note', { cookie: await cookie(), form: { id: 'ibx_sem_dup' } }), E);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/^\/app\/notes\/[^/]+$/);
    expect(loc).not.toContain('?dup=');
  });

  it('falha do Vectorize na pré-consulta: a nota é criada mesmo assim, sem dup e sem derrubar o fluxo', async () => {
    E.VECTORIZE.query = vi.fn(async () => { throw new Error('vectorize indisponível'); });
    await insertInboxItem(E, { id: 'ibx_vecfail', body: 'ideia apesar da falha', source: 'mcp', created_at: 1000 });
    const res = await handleInboxToNotePost(req('POST', '/app/inbox/to-note', { cookie: await cookie(), form: { id: 'ibx_vecfail' } }), E);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/^\/app\/notes\/[^/]+$/);
    expect(loc).not.toContain('?dup=');
    const noteId = loc.split('/').pop()!;
    const note = await E.DB.prepare('SELECT title FROM notes WHERE id = ?').bind(noteId).first();
    expect(note.title).toBe('ideia apesar da falha');
    const item = await getInboxItem(E, 'ibx_vecfail');
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

  // spec 68 (PWA share target): manifest `share_target` navega GET /app/inbox com
  // title/text/url — a página pré-preenche o quick-add e marca source=pwa-share.
  it('sem params de share: hidden source=console e sem autofocus no botão', async () => {
    const res = await handleInboxPage(req('GET', '/app/inbox', { cookie: await cookie() }), E);
    const html = await res.text();
    expect(html).toContain('name="source" value="console"');
    expect(html).not.toContain('autofocus');
  });

  it('sem sessão + params de share: 302 pro login preservando os params no next', async () => {
    const res = await handleInboxPage(
      req('GET', '/app/inbox?title=Ideia&text=liga%20pro%20fornecedor&url=https%3A%2F%2Fexemplo.com'),
      E
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toContain('/app/login?next=');
    const next = decodeURIComponent(location.split('next=')[1]);
    expect(next).toBe('/app/inbox?title=Ideia&text=liga%20pro%20fornecedor&url=https%3A%2F%2Fexemplo.com');
  });

  it('com sessão + params de share: textarea vem preenchido e source=pwa-share', async () => {
    const res = await handleInboxPage(
      req('GET', '/app/inbox?title=Ideia&text=liga%20pro%20fornecedor&url=https%3A%2F%2Fexemplo.com', { cookie: await cookie() }),
      E
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Ideia');
    expect(html).toContain('liga pro fornecedor');
    expect(html).toContain('https://exemplo.com');
    expect(html).toContain('name="source" value="pwa-share"');
    expect(html).toContain('autofocus');
  });

  it('share só com um param (text): concatena só o que existe, sem linhas vazias sobrando', async () => {
    const res = await handleInboxPage(
      req('GET', '/app/inbox?text=so%20o%20texto', { cookie: await cookie() }),
      E
    );
    const html = await res.text();
    expect(html).toContain('so o texto');
    expect(html).toContain('name="source" value="pwa-share"');
  });

  it('Inbox saiu da navegação (Onda 8): sem item de menu, sem badge — mesmo com pendentes', async () => {
    await insertInboxItem(E, { id: 'ibx_a', body: 'x', source: 'mcp', created_at: 1000 });
    await insertInboxItem(E, { id: 'ibx_b', body: 'y', source: 'mcp', created_at: 2000 });
    const html = await (await handleNotesList(req('GET', '/app/notes', { cookie: await cookie() }), E)).text();
    expect(html).not.toContain('href="/app/inbox"');
    expect(html).not.toContain('class="nav-badge"');
    expect(html).not.toContain('na triagem');
  });

  it('a página /app/inbox segue viva (link "ver tudo" da home + share target), com Início ativo na nav', async () => {
    const res = await handleInboxPage(req('GET', '/app/inbox', { cookie: await cookie() }), E);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Inbox</h1>');
    // Sem item próprio na nav, o destaque cai em Início.
    expect(html).toMatch(/nav-item active" href="\/app" title="Início"/);
  });
});

// Onda 8 (spec 70): o card Inbox da home reusa os endpoints com hidden `next` pra
// voltar pra home. Allowlist fechada: só '/app'; qualquer outra coisa → /app/inbox.
describe('redirect `next` dos endpoints do inbox (card da home)', () => {
  beforeEach(resetDb);

  it('add com next=/app volta pra home; next malicioso cai no default', async () => {
    const home = await handleInboxAddPost(
      req('POST', '/app/inbox/add', { cookie: await cookie(), form: { text: 'da home', next: '/app' } }), E);
    expect(home.headers.get('location')).toBe('/app');

    const evil = await handleInboxAddPost(
      req('POST', '/app/inbox/add', { cookie: await cookie(), form: { text: 'x', next: 'https://evil.example' } }), E);
    expect(evil.headers.get('location')).toBe('/app/inbox');
  });

  it('resolve (descartar) com next=/app volta pra home', async () => {
    await insertInboxItem(E, { id: 'ibx_n', body: 'x', source: 'mcp', created_at: 1000 });
    const res = await handleInboxResolvePost(
      req('POST', '/app/inbox/resolve', { cookie: await cookie(), form: { id: 'ibx_n', action: 'discard', next: '/app' } }), E);
    expect(res.headers.get('location')).toBe('/app');
    expect(await countPendingInbox(E)).toBe(0);
  });
});
