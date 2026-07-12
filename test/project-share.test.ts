// Board compartilhado por projeto (spec 80-frota-agentes/85): /p/<token> expõe SÓ o
// recorte de UM projeto (tasks não-privadas + threads), com permissão por token
// ('read' | 'comment'). Comentário externo entra como 'guest' assinando o LABEL do
// share (o CHECK da 0010 fecha o enum em owner/guest/agent — 'guest' É a classe
// externa; o selo EXTERNO no render diferencia de agente assinado). Comentário
// externo gera mailbox pros assignees ativos (spec 82).
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, insertTask, setTaskAssignees, createTaskProject } from '../src/db/queries.js';
import { createProjectShare, revokeProjectShare, listProjectShares } from '../src/web/project-share.js';
import { listMailboxItems } from '../src/db/mailbox.js';
import { OWNER_TASK_VIS } from '../src/auth/visibility.js';

const E = env as any;
const NOW = Date.now();

async function seedProject(): Promise<{ projectId: string; taskId: string; privateTaskId: string; otherTaskId: string }> {
  await createTaskProject(E, { id: 'proj_a', label: 'Projeto Alfa', color: null }, NOW);
  await createTaskProject(E, { id: 'proj_b', label: 'Projeto Beta', color: null }, NOW);
  const base = {
    body: '', domains: '["operations"]', status: 'open' as const,
    due_at: null, priority: null, created_at: NOW, updated_at: NOW,
  };
  await insertTask(E, { ...base, id: 'task_pub', title: 'Task publica do alfa', tldr: 'Task publica do alfa', priority: 2, project_id: 'proj_a' });
  await insertTask(E, { ...base, id: 'task_priv', title: 'Task privada do alfa', tldr: 'Task privada do alfa', project_id: 'proj_a', private: 1 });
  await insertTask(E, { ...base, id: 'task_beta', title: 'Task do beta', tldr: 'Task do beta', project_id: 'proj_b' });
  return { projectId: 'proj_a', taskId: 'task_pub', privateTaskId: 'task_priv', otherTaskId: 'task_beta' };
}

const getPage = (token: string) => SELF.fetch(`https://x/p/${token}`);
const postComment = (token: string, fields: Record<string, string>) =>
  SELF.fetch(`https://x/p/${token}/comment`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

beforeEach(async () => {
  await runMigrations(E);
  // Ordem respeita as FKs: filhos antes dos pais (assignees/comments → notes → users).
  await E.DB.exec('DELETE FROM mailbox_items');
  await E.DB.exec('DELETE FROM task_assignees');
  await E.DB.exec('DELETE FROM task_comments');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM task_projects');
  await E.DB.exec('DELETE FROM project_shares');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
});

describe('migration 0024_project_shares', () => {
  it('tabela existe com as colunas do share por projeto', async () => {
    const cols = (await E.DB.prepare(`PRAGMA table_info(project_shares)`).all()).results.map((r: any) => r.name);
    for (const c of ['id', 'token_hash', 'prefix', 'project_id', 'label', 'mode', 'created_at', 'expires_at', 'revoked_at']) {
      expect(cols).toContain(c);
    }
  });
});

describe('GET /p/<token> — recorte read-only', () => {
  it('mostra as tasks não-privadas do projeto; privada e outros projetos NUNCA', async () => {
    const s = await seedProject();
    const share = await createProjectShare(E, s.projectId, { label: 'Cliente X', mode: 'read' }, NOW);
    const res = await getPage(share.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    const html = await res.text();
    expect(html).toContain('Task publica do alfa');
    expect(html).toContain('Projeto Alfa');
    expect(html).not.toContain('Task privada do alfa');
    expect(html).not.toContain('Task do beta');
    // Nada além do recorte: sem navegação pro console.
    expect(html).not.toContain('href="/app');
    // mode read: zero formulário de comentário.
    expect(html).not.toContain('<form');
  });

  it('token revogado, expirado ou lixo → 404 neutro', async () => {
    const s = await seedProject();
    const share = await createProjectShare(E, s.projectId, { label: 'Cliente X', mode: 'read' }, NOW);
    await revokeProjectShare(E, share.id);
    expect((await getPage(share.token)).status).toBe(404);

    const expired = await createProjectShare(E, s.projectId, { label: 'Y', mode: 'read', expiresDays: 1 }, NOW - 3 * 86400000);
    expect((await getPage(expired.token)).status).toBe(404);

    expect((await getPage('ebp_nao-existe-token-com-tamanho-suficiente-aqui-123')).status).toBe(404);
    expect((await getPage('curto')).status).toBe(404);
  });

  it('share sem expiração segue vivo; listProjectShares lista com label/modo', async () => {
    const s = await seedProject();
    await createProjectShare(E, s.projectId, { label: 'Agente da ACME', mode: 'comment' }, NOW);
    const shares = await listProjectShares(E, s.projectId);
    expect(shares).toHaveLength(1);
    expect(shares[0].label).toBe('Agente da ACME');
    expect(shares[0].mode).toBe('comment');
    expect(shares[0].revoked_at).toBeNull();
  });
});

describe('POST /p/<token>/comment — modo comment', () => {
  it('externo comenta: guest assinando o label + selo EXTERNO; assignee ativo recebe mailbox', async () => {
    const s = await seedProject();
    await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: null }, 1);
    await setTaskAssignees(E, s.taskId, ['user_vps'], NOW);
    const share = await createProjectShare(E, s.projectId, { label: 'Cliente X', mode: 'comment' }, NOW);

    const res = await postComment(share.token, { task_id: s.taskId, body: 'Podemos antecipar a entrega?' });
    expect(res.status).toBe(303);

    const cmt = await E.DB.prepare(`SELECT author, author_name, author_user_id, body FROM task_comments WHERE task_id = ?`)
      .bind(s.taskId).first();
    expect(cmt.author).toBe('guest');
    expect(cmt.author_name).toBe('Cliente X');
    expect(cmt.author_user_id).toBeNull();

    // Selo EXTERNO no render da página pública.
    const html = await (await getPage(share.token)).text();
    expect(html).toContain('Podemos antecipar a entrega?');
    expect(html).toContain('cmt-external');

    // Mailbox: assignee ativo recebe comment_on_assigned (spec 82/85).
    const items = await listMailboxItems(E, 'user_vps', OWNER_TASK_VIS);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('comment_on_assigned');
    expect(items[0].task_id).toBe(s.taskId);
  });

  it('POST em token read → 404 neutro (permissão é do token, não do form)', async () => {
    const s = await seedProject();
    const share = await createProjectShare(E, s.projectId, { label: 'Só leitura', mode: 'read' }, NOW);
    const res = await postComment(share.token, { task_id: s.taskId, body: 'tentativa' });
    expect(res.status).toBe(404);
  });

  it('task fora do projeto (ou privada) → não grava', async () => {
    const s = await seedProject();
    const share = await createProjectShare(E, s.projectId, { label: 'Cliente X', mode: 'comment' }, NOW);
    const r1 = await postComment(share.token, { task_id: s.otherTaskId, body: 'fora do recorte' });
    expect(r1.status).toBeGreaterThanOrEqual(400);
    const r2 = await postComment(share.token, { task_id: s.privateTaskId, body: 'na privada' });
    expect(r2.status).toBeGreaterThanOrEqual(400);
    const n = await E.DB.prepare(`SELECT count(*) c FROM task_comments`).first();
    expect(n.c).toBe(0);
  });

  it('rate limit por token: 11º comentário na mesma hora → 429', async () => {
    const s = await seedProject();
    const share = await createProjectShare(E, s.projectId, { label: 'Cliente X', mode: 'comment' }, NOW);
    for (let i = 0; i < 10; i++) {
      const r = await postComment(share.token, { task_id: s.taskId, body: `comentário ${i}` });
      expect(r.status).toBe(303);
    }
    const blocked = await postComment(share.token, { task_id: s.taskId, body: 'estourou' });
    expect(blocked.status).toBe(429);
  });

  it('honeypot preenchido descarta em silêncio', async () => {
    const s = await seedProject();
    const share = await createProjectShare(E, s.projectId, { label: 'Cliente X', mode: 'comment' }, NOW);
    const r = await postComment(share.token, { task_id: s.taskId, body: 'spam', website: 'http://bot' });
    expect(r.status).toBe(200);
    const n = await E.DB.prepare(`SELECT count(*) c FROM task_comments`).first();
    expect(n.c).toBe(0);
  });
});

describe('gestão no console', () => {
  it('POST /app/project-shares/create cria e redireciona com flash; revoke mata na hora', async () => {
    const { signSession } = await import('../src/web/session.js');
    const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
    const ck = `eb_session=${token}`;
    const s = await seedProject();

    const create = await SELF.fetch('https://x/app/project-shares/create', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ck },
      body: new URLSearchParams({ project_id: s.projectId, label: 'Cliente X', mode: 'comment' }).toString(),
    });
    expect(create.status).toBe(302);
    expect(create.headers.get('location')).toMatch(/pflash=[a-f0-9]{32}/);

    const shares = await listProjectShares(E, s.projectId);
    expect(shares).toHaveLength(1);

    // A config com o pflash mostra a URL /p/ uma única vez.
    const loc = create.headers.get('location')!;
    const page = await SELF.fetch(`https://x${loc}`, { headers: { cookie: ck } });
    const html = await page.text();
    expect(html).toContain('/p/ebp_');

    const revoke = await SELF.fetch('https://x/app/project-shares/revoke', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ck },
      body: new URLSearchParams({ id: shares[0].id }).toString(),
    });
    expect(revoke.status).toBe(302);
    const after = await listProjectShares(E, s.projectId);
    expect(after[0].revoked_at).not.toBeNull();
  });
});
