// Mailbox por agente + @menção (spec 80-frota-agentes/82). O board vira barramento:
// comentário com @Nome endereça outro usuário (mention), atribuição gera item
// (assignment) e comentário em task atribuída notifica os assignees
// (comment_on_assigned). check_mailbox/ack_mailbox são a superfície de leitura —
// escopadas por credencial via resolveMe, leitura NUNCA marca lido. Produção é
// best-effort: falha no mailbox jamais derruba a escrita principal.
// "mailbox" ≠ "inbox" (captura do dono, migration 0014 — intocado).
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import type { AuthContext } from '../../src/env.js';
import { createUser, getOwnerUser, insertTask, addTaskComment } from '../../src/db/queries.js';
import {
  parseMentionedUsers, addMailboxItem, produceCommentMailbox, produceAssignmentMailbox,
  listMailboxItems, countMailboxUnread,
} from '../../src/db/mailbox.js';
import { registerCheckMailbox } from '../../src/mcp/tools/check-mailbox.js';
import { registerAckMailbox } from '../../src/mcp/tools/ack-mailbox.js';
import { registerCommentTask } from '../../src/mcp/tools/comment-task.js';
import { registerSaveTask } from '../../src/mcp/tools/save-task.js';
import { registerUpdateTask } from '../../src/mcp/tools/update-task.js';
import { renderCommentThread } from '../../src/web/comments-render.js';
import { signSession } from '../../src/web/session.js';

const E = env as any;

const OWNER: AuthContext = { email: 'o@x', loggedInAt: 0 };
const pat = (keyId: string, scopes = 'full'): AuthContext => ({ email: 'o@x', loggedInAt: 0, scopes, keyId });

function reg(auth: AuthContext) {
  const r: any = {};
  const cfg: any = {};
  const server = { registerTool: (n: string, m: any, h: any) => { r[n] = h; cfg[n] = m; } } as any;
  registerCheckMailbox(server, E, auth);
  registerAckMailbox(server, E, auth);
  registerCommentTask(server, E, auth);
  registerSaveTask(server, E, auth);
  registerUpdateTask(server, E, auth);
  return { r, cfg };
}

const parse = (res: any) => JSON.parse(res.content[0].text);

async function seedAgent(userId: string, name: string, keyId: string, scopes = 'full') {
  await E.DB.prepare(
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, scopes, created_at, user_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(keyId, 'o@x', `pat-${userId}`, `eb_pat_${keyId.slice(0, 4)}`, `hash_${keyId}`, scopes, 1, userId).run();
  await createUser(E, { id: userId, name, type: 'agent', bio: null, api_key_id: null }, 1);
}

async function seedTask(id: string, opts: { priv?: boolean; assignees?: string[] } = {}) {
  const now = Date.now();
  await insertTask(E, {
    id, title: `Task ${id}`, body: 'corpo', tldr: id, domains: '["operations"]',
    status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
  });
  if (opts.priv) await E.DB.prepare(`UPDATE notes SET private = 1 WHERE id = ?`).bind(id).run();
  for (const uid of opts.assignees ?? []) {
    await E.DB.prepare(`INSERT INTO task_assignees (note_id, user_id, created_at) VALUES (?,?,?)`)
      .bind(id, uid, now).run();
  }
}

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function postForm(path: string, fields: Record<string, string | string[]>, ck: string): Promise<Response> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.set(k, v);
  }
  return SELF.fetch(`https://x${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ck },
    body: params.toString(),
  });
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM mailbox_items');
  await E.DB.exec('DELETE FROM task_comments');
  await E.DB.exec('DELETE FROM task_assignees');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
});

describe('migration 0022_agent_mailbox', () => {
  it('cria a tabela mailbox_items e o índice de não-lidos', async () => {
    const cols = (await E.DB.prepare(`PRAGMA table_info(mailbox_items)`).all()).results.map((r: any) => r.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'user_id', 'kind', 'task_id', 'comment_id', 'actor_user_id', 'created_at', 'read_at']));
    const idx = await E.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mailbox_unread'`
    ).first();
    expect(idx?.name).toBe('idx_mailbox_unread');
  });
});

describe('parseMentionedUsers', () => {
  const users = [
    { id: 'u1', name: 'PC Desktop' },
    { id: 'u2', name: 'Ana' },
    { id: 'u3', name: 'Ana Almeida' },
  ];

  it('match case-insensitive de nome simples e nome com espaço (forma nua)', () => {
    expect(parseMentionedUsers('@ana revisa isso', users).map((u) => u.id)).toEqual(['u2']);
    expect(parseMentionedUsers('oi @pc desktop faz X', users).map((u) => u.id)).toEqual(['u1']);
  });

  it('aceita a forma @"Nome Com Espaço" entre aspas', () => {
    expect(parseMentionedUsers('@"PC Desktop" roda o backfill', users).map((u) => u.id)).toEqual(['u1']);
  });

  it('nome mais longo vence no mesmo span (sem duplicar o prefixo)', () => {
    const got = parseMentionedUsers('@Ana Almeida assume', users).map((u) => u.id);
    expect(got).toEqual(['u3']);
  });

  it('boundary: @Anastácia NÃO menciona Ana', () => {
    expect(parseMentionedUsers('@Anastácia é outra pessoa', users)).toEqual([]);
  });

  it('múltiplas menções no mesmo body', () => {
    const got = parseMentionedUsers('@Ana e @"PC Desktop": dividam', users).map((u) => u.id).sort();
    expect(got).toEqual(['u1', 'u2']);
  });
});

describe('addMailboxItem — dedup', () => {
  it('mesmo (user, kind, task, comment) não se repete', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedTask('t1');
    const item = { user_id: 'user_a', kind: 'mention' as const, task_id: 't1', comment_id: 'cmt_x', actor_user_id: null, created_at: 1 };
    expect(await addMailboxItem(E, item)).toBe(true);
    expect(await addMailboxItem(E, item)).toBe(false);
    const c = await E.DB.prepare(`SELECT count(*) c FROM mailbox_items`).first();
    expect(c.c).toBe(1);
  });
});

describe('produção via comment_task (mention + comment_on_assigned)', () => {
  it('@Nome gera item mention pro mencionado; autor não recebe item', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    const p = parse(await reg(pat('key_a')).r.comment_task({ task_id: 't1', body: '@Claude VPS roda o backfill' }));

    const items = await listMailboxItems(E, 'user_b', {});
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('mention');
    expect(items[0].task_id).toBe('t1');
    expect(items[0].comment_id).toBe(p.id);
    expect(items[0].actor_user_id).toBe('user_a');
    expect(await listMailboxItems(E, 'user_a', {})).toHaveLength(0);
  });

  it('comentário em task atribuída gera comment_on_assigned pros assignees ≠ autor; menção tem precedência (sem duplicar)', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedAgent('user_c', 'Notebook', 'key_c');
    await seedTask('t1', { assignees: ['user_b', 'user_c', 'user_a'] });
    await reg(pat('key_a')).r.comment_task({ task_id: 't1', body: '@Claude VPS olha isso' });

    // B foi mencionado → SÓ mention. C é assignee não-mencionado → comment_on_assigned.
    // A é o autor → nada.
    const b = await listMailboxItems(E, 'user_b', {});
    expect(b.map((i: any) => i.kind)).toEqual(['mention']);
    const c = await listMailboxItems(E, 'user_c', {});
    expect(c.map((i: any) => i.kind)).toEqual(['comment_on_assigned']);
    expect(await listMailboxItems(E, 'user_a', {})).toHaveLength(0);
  });

  it('auto-menção do autor não gera item', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedTask('t1');
    await reg(pat('key_a')).r.comment_task({ task_id: 't1', body: 'eu @Agente A assumo' });
    expect(await listMailboxItems(E, 'user_a', {})).toHaveLength(0);
  });

  it('@NomeInexistente fica inerte: sem erro, sem item', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedTask('t1');
    const res = await reg(pat('key_a')).r.comment_task({ task_id: 't1', body: '@Fulano Fantasma vê isso' });
    expect(res.isError).toBeUndefined();
    const c = await E.DB.prepare(`SELECT count(*) c FROM mailbox_items`).first();
    expect(c.c).toBe(0);
  });

  it('best-effort: falha na gravação do mailbox NÃO impede o comentário de ser salvo', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    await E.DB.exec('DROP TABLE mailbox_items');
    const res = await reg(pat('key_a')).r.comment_task({ task_id: 't1', body: '@Claude VPS sobrevive' });
    expect(res.isError).toBeUndefined();
    const c = await E.DB.prepare(`SELECT count(*) c FROM task_comments`).first();
    expect(c.c).toBe(1);
    // Restaura pro resto da suite (runMigrations do próximo beforeEach não re-cria —
    // a migration já consta em _migrations).
    await E.DB.exec(`CREATE TABLE IF NOT EXISTS mailbox_items (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT NOT NULL, comment_id TEXT, actor_user_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER)`);
    await E.DB.exec(`CREATE INDEX IF NOT EXISTS idx_mailbox_unread ON mailbox_items(user_id, read_at, created_at)`);
  });
});

describe('produção via atribuição (assignment)', () => {
  it('save_task com assignees gera item pro atribuído ≠ ator', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    const p = parse(await reg(pat('key_a')).r.save_task({ title: 'Rodar censo', assignees: ['Claude VPS', 'me'] }));

    const b = await listMailboxItems(E, 'user_b', {});
    expect(b.map((i: any) => i.kind)).toEqual(['assignment']);
    expect(b[0].task_id).toBe(p.id);
    expect(b[0].comment_id).toBeNull();
    expect(b[0].actor_user_id).toBe('user_a');
    // 'me' (o próprio ator) não recebe item.
    expect(await listMailboxItems(E, 'user_a', {})).toHaveLength(0);
  });

  it('update_task: só o assignee ADICIONADO recebe item; remoção não gera nada', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedAgent('user_c', 'Notebook', 'key_c');
    await seedTask('t1', { assignees: ['user_b'] });

    await reg(pat('key_a')).r.update_task({ id: 't1', assignees: ['Claude VPS', 'Notebook'] });
    expect(await listMailboxItems(E, 'user_b', {})).toHaveLength(0); // já era assignee
    expect((await listMailboxItems(E, 'user_c', {})).map((i: any) => i.kind)).toEqual(['assignment']);

    await reg(pat('key_a')).r.update_task({ id: 't1', assignees: [] });
    // Remoção: nenhum item novo.
    expect(await listMailboxItems(E, 'user_c', {})).toHaveLength(1);
  });

  it('web POST /app/tasks/assignees: adicionado ganha item com ator = dono', async () => {
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    const res = await postForm('/app/tasks/assignees', { task_id: 't1', user_ids: ['user_b'] }, await cookie());
    expect(res.status).toBe(302);
    const b = await listMailboxItems(E, 'user_b', {});
    expect(b.map((i: any) => i.kind)).toEqual(['assignment']);
    expect(b[0].actor_user_id).toBe((await getOwnerUser(E))!.id);
  });
});

describe('web POST /app/tasks/comment (dono) produz menção', () => {
  it('@Nome no comentário do console gera item com ator = dono', async () => {
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    const res = await postForm('/app/tasks/comment', { task_id: 't1', body: '@Claude VPS confere a fila' }, await cookie());
    expect(res.status).toBe(302);
    const b = await listMailboxItems(E, 'user_b', {});
    expect(b.map((i: any) => i.kind)).toEqual(['mention']);
    expect(b[0].actor_user_id).toBe((await getOwnerUser(E))!.id);
  });
});

describe('check_mailbox', () => {
  it('default: só não-lidos do chamador, mais antigos primeiro, com body do comentário e unread_count', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    await reg(pat('key_a')).r.comment_task({ task_id: 't1', body: '@Claude VPS primeiro' });
    await reg(pat('key_a')).r.comment_task({ task_id: 't1', body: '@Claude VPS segundo' });

    const out = parse(await reg(pat('key_b')).r.check_mailbox({}));
    expect(out.unread_count).toBe(2);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].comment.body).toBe('@Claude VPS primeiro');
    expect(out.items[1].comment.body).toBe('@Claude VPS segundo');
    expect(out.items[0].kind).toBe('mention');
    expect(out.items[0].task.id).toBe('t1');
    expect(out.items[0].actor.id).toBe('user_a');
    expect(out.items[0].comment.author_user.id).toBe('user_a');
    expect(out.items[0].created_brt).toBeTruthy();

    // Ler NÃO marca lido: segunda chamada devolve o mesmo.
    const again = parse(await reg(pat('key_b')).r.check_mailbox({}));
    expect(again.unread_count).toBe(2);
  });

  it('itens de A não vazam pra B; PAT sem vínculo recebe erro instrutivo', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    await reg(pat('key_b')).r.comment_task({ task_id: 't1', body: '@Agente A pra você' });

    expect(parse(await reg(pat('key_b')).r.check_mailbox({})).items).toHaveLength(0);

    await E.DB.prepare(
      `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at) VALUES ('key_orfa','o@x','orfa','eb_pat_o','h',1)`
    ).run();
    const res = await reg(pat('key_orfa')).r.check_mailbox({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('/app/config');
  });

  it('all:true inclui lidos; task privada some pra credencial sem escopo private', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    await seedTask('tsec', { priv: true });
    await reg(pat('key_a')).r.comment_task({ task_id: 't1', body: '@Claude VPS publica' });
    await addMailboxItem(E, { user_id: 'user_b', kind: 'mention', task_id: 'tsec', comment_id: null, actor_user_id: 'user_a', created_at: Date.now() });

    // PAT full sem private: item da task privada FILTRADO (fail-closed).
    const semPriv = parse(await reg(pat('key_b', 'full')).r.check_mailbox({}));
    expect(semPriv.items.map((i: any) => i.task.id)).toEqual(['t1']);
    expect(semPriv.unread_count).toBe(1);

    // Mesma identidade com escopo private vê os dois.
    await E.DB.prepare(
      `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, scopes, created_at, user_id)
       VALUES ('key_bp','o@x','b-priv','eb_pat_bp','h',?,1,'user_b')`
    ).bind('full,private').run();
    const comPriv = parse(await reg(pat('key_bp', 'full,private')).r.check_mailbox({}));
    expect(comPriv.items).toHaveLength(2);

    // ack + all:true — o lido continua acessível no histórico.
    await reg(pat('key_b')).r.ack_mailbox({ ids: [semPriv.items[0].id] });
    expect(parse(await reg(pat('key_b')).r.check_mailbox({})).items).toHaveLength(0);
    const all = parse(await reg(pat('key_b')).r.check_mailbox({ all: true }));
    expect(all.items).toHaveLength(1);
    expect(all.items[0].read_at).toBeTruthy();
  });

  it('check_mailbox é readOnlyHint:true (passa no escopo read)', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    const { cfg } = reg(pat('key_a'));
    expect(cfg.check_mailbox.annotations.readOnlyHint).toBe(true);
    expect(cfg.ack_mailbox.annotations.readOnlyHint).toBe(false);
  });
});

describe('ack_mailbox', () => {
  it('marca só itens do PRÓPRIO chamador; ids de outro usuário não são tocados', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    await reg(pat('key_a')).r.comment_task({ task_id: 't1', body: '@Claude VPS item de B' });
    const bItem = (await listMailboxItems(E, 'user_b', {}))[0];

    // A tenta ackar o item de B: 0 acked, item de B segue não-lido.
    const res = parse(await reg(pat('key_a')).r.ack_mailbox({ ids: [bItem.id] }));
    expect(res.acked).toBe(0);
    expect(await countMailboxUnread(E, 'user_b', true)).toBe(1);

    const ok = parse(await reg(pat('key_b')).r.ack_mailbox({ ids: [bItem.id] }));
    expect(ok.acked).toBe(1);
    expect(await countMailboxUnread(E, 'user_b', true)).toBe(0);
  });

  it('up_to marca tudo até o timestamp; exige exatamente um de ids/up_to', async () => {
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    await addMailboxItem(E, { user_id: 'user_b', kind: 'mention', task_id: 't1', comment_id: 'c1', actor_user_id: null, created_at: 100 });
    await addMailboxItem(E, { user_id: 'user_b', kind: 'mention', task_id: 't1', comment_id: 'c2', actor_user_id: null, created_at: 200 });

    const r = reg(pat('key_b')).r;
    expect((await r.ack_mailbox({})).isError).toBe(true);
    expect((await r.ack_mailbox({ ids: ['x'], up_to: 150 })).isError).toBe(true);

    const res = parse(await r.ack_mailbox({ up_to: 150 }));
    expect(res.acked).toBe(1);
    expect(await countMailboxUnread(E, 'user_b', true)).toBe(1);
  });
});

describe('produceAssignmentMailbox/produceCommentMailbox — dedup e best-effort diretos', () => {
  it('produzir o mesmo comentário duas vezes não duplica itens', async () => {
    await seedAgent('user_a', 'Agente A', 'key_a');
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    await addTaskComment(E, { id: 'cmt_1', task_id: 't1', author: 'agent', author_name: null, body: '@Claude VPS oi', created_at: 1, author_user_id: 'user_a' });
    await produceCommentMailbox(E, { taskId: 't1', commentId: 'cmt_1', body: '@Claude VPS oi', actorUserId: 'user_a' });
    await produceCommentMailbox(E, { taskId: 't1', commentId: 'cmt_1', body: '@Claude VPS oi', actorUserId: 'user_a' });
    expect(await listMailboxItems(E, 'user_b', {})).toHaveLength(1);
  });

  it('produceAssignmentMailbox não lança com tabela ausente (best-effort)', async () => {
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    await E.DB.exec('DROP TABLE mailbox_items');
    await expect(
      produceAssignmentMailbox(E, { taskId: 't1', addedUserIds: ['user_b'], actorUserId: null, now: Date.now() })
    ).resolves.toBeUndefined();
    await E.DB.exec(`CREATE TABLE IF NOT EXISTS mailbox_items (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT NOT NULL, comment_id TEXT, actor_user_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER)`);
    await E.DB.exec(`CREATE INDEX IF NOT EXISTS idx_mailbox_unread ON mailbox_items(user_id, read_at, created_at)`);
  });
});

describe('board — badge de não-lidas + filtro de menções', () => {
  it('/app/tasks/data expõe mailbox_unread por usuário e mention_me no card', async () => {
    await seedAgent('user_b', 'Claude VPS', 'key_b');
    await seedTask('t1');
    await seedTask('t2');
    const ownerId = (await getOwnerUser(E))!.id;
    // Menção não-lida pro DONO em t1 + item pro agente B em t2.
    await addMailboxItem(E, { user_id: ownerId, kind: 'mention', task_id: 't1', comment_id: 'c1', actor_user_id: 'user_b', created_at: 1 });
    await addMailboxItem(E, { user_id: 'user_b', kind: 'assignment', task_id: 't2', comment_id: null, actor_user_id: ownerId, created_at: 2 });

    const res = await SELF.fetch('https://x.test/app/tasks/data', { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    const data: any = await res.json();

    const byUser = new Map((data.mailbox_unread ?? []).map((u: any) => [u.id, u]));
    expect((byUser.get(ownerId) as any)?.count).toBe(1);
    expect((byUser.get('user_b') as any)?.count).toBe(1);

    const tasks = data.columns.flatMap((c: any) => c.tasks);
    expect(tasks.find((t: any) => t.id === 't1')?.mention_me).toBe(true);
    expect(tasks.find((t: any) => t.id === 't2')?.mention_me).toBe(false);
  });
});

describe('realce de @Nome no render do comentário', () => {
  it('menção resolvida vira span inerte .cmt-mention; nome não cadastrado fica texto puro', () => {
    const comments: any = [{
      id: 'c1', task_id: 't1', author: 'agent', author_name: null,
      body: '@Claude VPS e @"PC Desktop" olhem; @Fantasma não', created_at: 1,
      author_user_id: 'user_a', author_key_id: null,
      author_user: { id: 'user_a', name: 'Agente A', type: 'agent', avatar: false },
    }];
    const html = renderCommentThread(comments, { mentionNames: ['Claude VPS', 'PC Desktop'] });
    expect(html).toContain('<span class="cmt-mention">@Claude VPS</span>');
    expect(html).toContain('<span class="cmt-mention">@&quot;PC Desktop&quot;</span>');
    expect(html).not.toContain('<span class="cmt-mention">@Fantasma</span>');
    // Inerte: nenhum link.
    expect(html).not.toContain('<a');
  });
});
