// Assinatura por credencial no comment_task (spec 80-frota-agentes/81): a autoria
// do comentário de agente é derivada da credencial no servidor (resolveMe), nunca
// autodeclarada. PAT sem perfil vinculado = fail-closed. Render distingue comentário
// assinado (nome do usuário) de agente legado ("não assinado (legado)").
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import type { AuthContext } from '../../src/env.js';
import { insertTask, addTaskComment, listTaskComments, createUser, getOwnerUser } from '../../src/db/queries.js';
import { registerCommentTask } from '../../src/mcp/tools/comment-task.js';
import { registerGetTask } from '../../src/mcp/tools/get-task.js';
import { commentAuthorLabel, renderCommentThread } from '../../src/web/comments-render.js';
import { signSession } from '../../src/web/session.js';

const E = env as any;
const OWNER: AuthContext = { email: 'o@x', loggedInAt: 0 };
const AGENT_PAT: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'key_vps' };
const UNLINKED_PAT: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'key_orfao' };

function reg(auth?: AuthContext) {
  const r: any = {};
  const server = { registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any;
  registerCommentTask(server, E, auth);
  registerGetTask(server, E, auth);
  return r;
}

const parse = (res: any) => JSON.parse(res.content[0].text);

async function seedTask(id: string) {
  const now = Date.now();
  await insertTask(E, {
    id, title: id, body: 'corpo', tldr: id, domains: '["operations"]',
    status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
  });
}

async function seedAgentUser() {
  await E.DB.prepare(
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)`
  ).bind('key_vps', 'o@x', 'claude-vps', 'eb_pat_x', 'h', 1).run();
  await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: 'key_vps' }, 1);
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM task_comments');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
});

describe('migration 0020', () => {
  it('task_comments ganha a coluna author_user_id (aditiva, NULL nos legados)', async () => {
    const info = await E.DB.prepare(`PRAGMA table_info(task_comments)`).all();
    const cols = info.results.map((r: any) => r.name);
    expect(cols).toContain('author_user_id');
  });
});

describe('comment_task assina pela credencial', () => {
  it('PAT vinculado grava author_user_id e devolve author_user', async () => {
    await seedAgentUser();
    await seedTask('t1');
    const p = parse(await reg(AGENT_PAT).comment_task({ task_id: 't1', body: 'feito' }));
    expect(p.author_user).toEqual({ id: 'user_vps', name: 'Claude VPS', type: 'agent' });
    const row = await E.DB.prepare(`SELECT author_user_id FROM task_comments WHERE id = ?`).bind(p.id).first();
    expect(row.author_user_id).toBe('user_vps');
  });

  it('PAT sem vínculo é rejeitado fail-closed (nenhuma linha gravada)', async () => {
    await seedTask('t1');
    const res = await reg(UNLINKED_PAT).comment_task({ task_id: 't1', body: 'anon' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('/app/config');
    const c = await E.DB.prepare(`SELECT count(*) c FROM task_comments`).first();
    expect(c.c).toBe(0);
  });

  it('sessão OAuth do dono assina como o perfil owner', async () => {
    await seedTask('t1');
    const p = parse(await reg(OWNER).comment_task({ task_id: 't1', body: 'ok' }));
    const ownerId = (await getOwnerUser(E))!.id;
    expect(p.author_user.id).toBe(ownerId);
  });

  it('author_name vira rótulo complementar, não identidade', async () => {
    await seedAgentUser();
    await seedTask('t1');
    const p = parse(await reg(AGENT_PAT).comment_task({ task_id: 't1', body: 'x', author_name: 'sessao-noturna' }));
    expect(p.author_user.id).toBe('user_vps');
    expect(p.author_name).toBe('sessao-noturna');
  });
});

describe('get_task ecoa author_user por comentário', () => {
  it('assinado traz {id,name,type}; legado traz null', async () => {
    await seedAgentUser();
    await seedTask('t1');
    await addTaskComment(E, { id: 'c_leg', task_id: 't1', author: 'agent', author_name: 'bot', body: 'legado', created_at: 1001 });
    await reg(AGENT_PAT).comment_task({ task_id: 't1', body: 'assinado' });
    const got = parse(await reg(OWNER).get_task({ id: 't1' }));
    const byBody = Object.fromEntries(got.comments.map((c: any) => [c.body, c.author_user]));
    expect(byBody['legado']).toBeNull();
    expect(byBody['assinado'].name).toBe('Claude VPS');
  });
});

describe('render com assinatura', () => {
  it('comentário assinado exibe o nome do usuário', async () => {
    await seedAgentUser();
    const signed: any = {
      id: 'c1', task_id: 't1', author: 'agent', author_name: null, body: 'oi',
      created_at: 1000, author_user_id: 'user_vps',
      author_user: { id: 'user_vps', name: 'Claude VPS', type: 'agent', avatar: false },
    };
    expect(commentAuthorLabel(signed)).toContain('Claude VPS');
    const html = renderCommentThread([signed]);
    expect(html).toContain('Claude VPS');
    expect(html).not.toContain('não assinado');
  });

  it('agente legado (sem author_user_id) ganha selo "não assinado (legado)"', async () => {
    const legacy: any = {
      id: 'c2', task_id: 't1', author: 'agent', author_name: 'bot', body: 'oi',
      created_at: 1000, author_user_id: null, author_user: null,
    };
    const html = renderCommentThread([legacy]);
    expect(html).toContain('agente · bot');
    expect(html).toContain('não assinado (legado)');
  });

  it('dono e convidado legados renderizam como hoje, sem selo', async () => {
    const owner: any = { id: 'c3', task_id: 't1', author: 'owner', author_name: null, body: 'a', created_at: 1, author_user_id: null, author_user: null };
    const guest: any = { id: 'c4', task_id: 't1', author: 'guest', author_name: 'Fulano', body: 'b', created_at: 2, author_user_id: null, author_user: null };
    const html = renderCommentThread([owner, guest]);
    expect(html).toContain('dono');
    expect(html).toContain('Fulano');
    expect(html).not.toContain('não assinado');
  });
});

describe('comentário do dono via console assina como owner', () => {
  it('POST /app/tasks/comment grava author_user_id do perfil owner', async () => {
    await seedTask('t1');
    const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
    const res = await SELF.fetch('https://x/app/tasks/comment', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `eb_session=${token}` },
      body: new URLSearchParams({ task_id: 't1', body: 'do console' }).toString(),
    });
    expect(res.status).toBe(302);
    const ownerId = (await getOwnerUser(E))!.id;
    const row = await E.DB.prepare(`SELECT author_user_id FROM task_comments WHERE task_id = 't1'`).first();
    expect(row.author_user_id).toBe(ownerId);
    const list = await listTaskComments(E, 't1');
    expect((list[0] as any).author_user?.id).toBe(ownerId);
  });
});
