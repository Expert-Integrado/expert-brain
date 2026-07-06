import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { createShare, revokeShare } from '../src/web/share.js';
import { insertTask } from '../src/db/queries.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function seedTask(id: string) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?, 'task', 'open', NULL, NULL, NULL, 1000, 1000, NULL)`
  ).bind(id, `Task ${id}`, 'corpo', `Task ${id}`, '["operations"]').run();
}

// POST form-encoded, sem seguir redirect (pra inspecionar 302/303/429 crus).
function postForm(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  const body = new URLSearchParams(fields).toString();
  return SELF.fetch(`https://x${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
}

describe('comentario publico do convidado (POST /s/<token>/comment)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_comments');
    await E.DB.exec('DELETE FROM notes');
  });

  it('GET da pagina de share mostra o form de comentario', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    const res = await SELF.fetch(`https://x/s/${r.token}`);
    const html = await res.text();
    expect(html).toContain('Comentários');
    expect(html).toContain(`/s/${r.token}/comment`);
    expect(html).toContain('name="website"'); // honeypot presente
  });

  it('convidado comenta → 303 e o comentario aparece pro dono e na pagina publica', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    const post = await postForm(`/s/${r.token}/comment`, { name: 'Fulano Fic', body: 'oi, tudo certo?' }, { 'CF-Connecting-IP': '10.0.0.1' });
    expect(post.status).toBe(303);
    expect(post.headers.get('location')).toBe(`/s/${r.token}#comentarios`);

    // Aparece na pagina publica.
    const pub = await (await SELF.fetch(`https://x/s/${r.token}`)).text();
    expect(pub).toContain('oi, tudo certo?');
    expect(pub).toContain('Fulano Fic');

    // Aparece pro dono no console.
    const det = await (await SELF.fetch(`https://x/app/tasks/t1`, { headers: { cookie: await cookie() } })).text();
    expect(det).toContain('oi, tudo certo?');
    expect(det).toContain('Fulano Fic');
  });

  it('escape: <script> do convidado vira texto inerte na pagina publica', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    await postForm(`/s/${r.token}/comment`, { name: '<img src=x onerror=alert(1)>', body: '<script>alert(1)</script>' }, { 'CF-Connecting-IP': '10.0.0.2' });
    const pub = await (await SELF.fetch(`https://x/s/${r.token}`)).text();
    expect(pub).toContain('&lt;script&gt;');
    expect(pub).not.toContain('<script>alert(1)</script>');
    expect(pub).not.toContain('<img src=x onerror');
  });

  it('honeypot preenchido → 200 silencioso, nada gravado', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    const post = await postForm(`/s/${r.token}/comment`, { name: 'Bot', body: 'spam', website: 'http://spam' }, { 'CF-Connecting-IP': '10.0.0.3' });
    expect(post.status).toBe(200);
    const row = await E.DB.prepare(`SELECT count(*) AS c FROM task_comments WHERE task_id='t1'`).first();
    expect(row.c).toBe(0);
  });

  it('rate-limit por token: 11o comentario dentro de 1h → 429', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    // 10 posts, cada um com IP distinto (isola o limite por token do limite por IP).
    for (let i = 0; i < 10; i++) {
      const res = await postForm(`/s/${r.token}/comment`, { name: `G${i}`, body: `c${i}` }, { 'CF-Connecting-IP': `9.9.9.${i}` });
      expect(res.status).toBe(303);
    }
    const over = await postForm(`/s/${r.token}/comment`, { name: 'G11', body: 'c11' }, { 'CF-Connecting-IP': '9.9.9.200' });
    expect(over.status).toBe(429);
    const row = await E.DB.prepare(`SELECT count(*) AS c FROM task_comments WHERE task_id='t1'`).first();
    expect(row.c).toBe(10); // o 11o NAO foi gravado
  });

  it('rate-limit por IP: 6o comentario do mesmo IP → 429', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    for (let i = 0; i < 5; i++) {
      const res = await postForm(`/s/${r.token}/comment`, { name: `H${i}`, body: `c${i}` }, { 'CF-Connecting-IP': '7.7.7.7' });
      expect(res.status).toBe(303);
    }
    const over = await postForm(`/s/${r.token}/comment`, { name: 'H6', body: 'c6' }, { 'CF-Connecting-IP': '7.7.7.7' });
    expect(over.status).toBe(429);
  });

  it('share revogado → POST /comment retorna 404', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    await revokeShare(E, 't1');
    const post = await postForm(`/s/${r.token}/comment`, { name: 'X', body: 'y' }, { 'CF-Connecting-IP': '10.0.0.9' });
    expect(post.status).toBe(404);
  });

  it('share expirado → POST /comment retorna 404', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', { expiresDays: 1 }, Date.now());
    if (!r.ok) throw new Error('setup');
    await E.DB.prepare(`UPDATE notes SET share_expires_at = 5 WHERE id='t1'`).run();
    const post = await postForm(`/s/${r.token}/comment`, { name: 'X', body: 'y' }, { 'CF-Connecting-IP': '10.0.0.10' });
    expect(post.status).toBe(404);
  });
});

describe('comentario do dono pelo console (/app/tasks/comment)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_comments');
    await E.DB.exec('DELETE FROM notes');
  });

  it('sem sessao → 401 (accept json) e nada gravado', async () => {
    await seedTask('t1');
    const res = await postForm('/app/tasks/comment', { task_id: 't1', body: 'x' }, { accept: 'application/json' });
    expect(res.status).toBe(401);
    const row = await E.DB.prepare(`SELECT count(*) AS c FROM task_comments`).first();
    expect(row.c).toBe(0);
  });

  it('dono comenta → 302 e o comentario aparece no detalhe', async () => {
    await seedTask('t1');
    const c = await cookie();
    const res = await postForm('/app/tasks/comment', { task_id: 't1', body: 'comentario do dono' }, { cookie: c });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/app/tasks/t1');
    const det = await (await SELF.fetch('https://x/app/tasks/t1', { headers: { cookie: c } })).text();
    expect(det).toContain('comentario do dono');
    expect(det).toContain('cmt-author-owner');
  });

  it('dono apaga qualquer comentario (moderacao)', async () => {
    await seedTask('t1');
    const c = await cookie();
    // Convidado comenta primeiro.
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    await postForm(`/s/${r.token}/comment`, { name: 'Convidado', body: 'apagavel' }, { 'CF-Connecting-IP': '10.0.1.1' });
    const before = await E.DB.prepare(`SELECT id FROM task_comments WHERE task_id='t1'`).first();
    expect(before?.id).toBeTruthy();

    const del = await postForm('/app/tasks/comment/delete', { id: before.id, task_id: 't1' }, { cookie: c });
    expect(del.status).toBe(302);
    const row = await E.DB.prepare(`SELECT count(*) AS c FROM task_comments WHERE task_id='t1'`).first();
    expect(row.c).toBe(0);
  });

  it('escape: HTML do dono vira texto inerte no detalhe', async () => {
    await seedTask('t1');
    const c = await cookie();
    await postForm('/app/tasks/comment', { task_id: 't1', body: '<script>alert(2)</script>' }, { cookie: c });
    const det = await (await SELF.fetch('https://x/app/tasks/t1', { headers: { cookie: c } })).text();
    expect(det).toContain('&lt;script&gt;');
    expect(det).not.toContain('<script>alert(2)</script>');
  });
});

describe('comment_count no board (/app/tasks/data)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM task_comments');
    await E.DB.exec('DELETE FROM notes');
  });

  it('board devolve comment_count por task batendo com a thread', async () => {
    await seedTask('t1');
    await seedTask('t2');
    const c = await cookie();
    await postForm('/app/tasks/comment', { task_id: 't1', body: 'a' }, { cookie: c });
    await postForm('/app/tasks/comment', { task_id: 't1', body: 'b' }, { cookie: c });

    const data = await (await SELF.fetch('https://x/app/tasks/data', { headers: { cookie: c } })).json() as any;
    const all: any[] = data.columns.flatMap((col: any) => col.tasks);
    const t1 = all.find((t) => t.id === 't1');
    const t2 = all.find((t) => t.id === 't2');
    expect(t1.comment_count).toBe(2);
    expect(t2.comment_count).toBe(0);
  });
});
