import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { createShare, resolveShare, revokeShare, getShareStatus, SHARE_TOKEN_RE } from '../src/web/share.js';

const E = env as any;

async function sessionCookieHeader(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

async function seedTask(id: string) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?, 'task', 'open', NULL, 2, NULL, 1000, 1000, NULL)`
  ).bind(id, `Task ${id}`, 'Corpo **markdown** com [[link quebrado]].', `Task ${id}`, '["operations"]').run();
}

async function seedNote(id: string) {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?,?, 'concept', 1000, 1000, NULL)`
  ).bind(id, `Nota ${id}`, 'corpo', `Nota ${id}`, '["operations"]').run();
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  return SELF.fetch(`https://x${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('share de task (spec 33) — módulo', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('createShare gera token válido, guarda só o HASH e devolve a URL', async () => {
    await seedTask('t1');
    const now = Date.now();
    const r = await createShare(E, 't1', {}, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(SHARE_TOKEN_RE.test(r.token)).toBe(true);
    expect(r.url).toContain('/s/' + r.token);
    // Default 30 dias.
    expect(r.expires_at).toBeGreaterThan(now + 29 * 24 * 3600 * 1000);
    // O banco guarda o HASH (64 hex), NUNCA o plaintext.
    const row = await E.DB.prepare(`SELECT share_token FROM notes WHERE id = 't1'`).first();
    expect(row?.share_token).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.share_token).not.toContain(r.token);
  });

  it('createShare recusa nota de conhecimento (só task)', async () => {
    await seedNote('n1');
    const r = await createShare(E, 'n1', {}, Date.now());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-found');
  });

  it('createShare recusa task inexistente/deletada', async () => {
    const r = await createShare(E, 'ghost', {}, Date.now());
    expect(r.ok).toBe(false);
    await seedTask('t2');
    await E.DB.prepare(`UPDATE notes SET deleted_at = 5 WHERE id = 't2'`).run();
    const r2 = await createShare(E, 't2', {}, Date.now());
    expect(r2.ok).toBe(false);
  });

  it('expires_days é clampado a 1-365', async () => {
    await seedTask('t1');
    const now = 1_000_000_000_000;
    const r = await createShare(E, 't1', { expiresDays: 9999 }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expires_at).toBe(now + 365 * 24 * 3600 * 1000);
    const r2 = await createShare(E, 't1', { expiresDays: 0, renew: true }, now);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.expires_at).toBe(now + 1 * 24 * 3600 * 1000);
  });

  it('já compartilhada sem renew → already-shared (não rotaciona)', async () => {
    await seedTask('t1');
    const now = Date.now();
    const r1 = await createShare(E, 't1', {}, now);
    expect(r1.ok).toBe(true);
    const hashBefore = (await E.DB.prepare(`SELECT share_token FROM notes WHERE id='t1'`).first())?.share_token;
    const r2 = await createShare(E, 't1', {}, now);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('already-shared');
    const hashAfter = (await E.DB.prepare(`SELECT share_token FROM notes WHERE id='t1'`).first())?.share_token;
    expect(hashAfter).toBe(hashBefore); // token não mudou
  });

  it('renew:true rotaciona o token (invalida o antigo)', async () => {
    await seedTask('t1');
    const now = Date.now();
    const r1 = await createShare(E, 't1', {}, now);
    if (!r1.ok) throw new Error('setup');
    const r2 = await createShare(E, 't1', { renew: true }, now);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.token).not.toBe(r1.token);
    // O token antigo não resolve mais.
    expect(await resolveShare(E, r1.token, now)).toBeNull();
    expect(await resolveShare(E, r2.token, now)).not.toBeNull();
  });

  it('resolveShare: token válido → task; expirado/revogado/lixo → null', async () => {
    await seedTask('t1');
    const now = Date.now();
    const r = await createShare(E, 't1', { expiresDays: 1 }, now);
    if (!r.ok) throw new Error('setup');
    // Válido agora.
    expect((await resolveShare(E, r.token, now))?.id).toBe('t1');
    // Expirado (2 dias depois).
    expect(await resolveShare(E, r.token, now + 2 * 24 * 3600 * 1000)).toBeNull();
    // Lixo.
    expect(await resolveShare(E, 'ebs_naoexiste000000000000000000000000000000000', now)).toBeNull();
    expect(await resolveShare(E, 'formato-invalido', now)).toBeNull();
    // Revogado.
    await revokeShare(E, 't1');
    expect(await resolveShare(E, r.token, now)).toBeNull();
  });

  it('resolveShare morre se a task for soft-deletada depois', async () => {
    await seedTask('t1');
    const now = Date.now();
    const r = await createShare(E, 't1', {}, now);
    if (!r.ok) throw new Error('setup');
    await E.DB.prepare(`UPDATE notes SET deleted_at = ? WHERE id='t1'`).bind(now).run();
    expect(await resolveShare(E, r.token, now)).toBeNull();
  });

  it('getShareStatus reflete shared/expires/expired', async () => {
    await seedTask('t1');
    const now = Date.now();
    expect((await getShareStatus(E, 't1', now))?.shared).toBe(false);
    const r = await createShare(E, 't1', { expiresDays: 1 }, now);
    if (!r.ok) throw new Error('setup');
    const s = await getShareStatus(E, 't1', now);
    expect(s?.shared).toBe(true);
    expect(s?.expired).toBe(false);
    const s2 = await getShareStatus(E, 't1', now + 2 * 24 * 3600 * 1000);
    expect(s2?.expired).toBe(true);
  });
});

describe('rota pública GET /s/<token> (sem auth)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('token válido → 200 com a task read-only + headers de segurança', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    const res = await SELF.fetch(`https://x/s/${r.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'");
    const html = await res.text();
    expect(html).toContain('Task t1');
    expect(html).toContain('noindex, nofollow'); // meta robots
    expect(html).toContain('compartilhado via Expert Brain');
    // NÃO expõe superfície do app.
    expect(html).not.toContain('/app/');
    expect(html).not.toContain('renderShell');
    expect(html).not.toContain(E.OWNER_EMAIL);
    // Wikilink quebrado vira span, nunca âncora pra /app/notes.
    expect(html).toContain('wikilink broken');
    expect(html).not.toContain('href="/app/notes');
  });

  it('token expirado → 404 genérico com headers de segurança', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', { expiresDays: 1 }, Date.now());
    if (!r.ok) throw new Error('setup');
    // Força expiração no passado.
    await E.DB.prepare(`UPDATE notes SET share_expires_at = 5 WHERE id='t1'`).run();
    const res = await SELF.fetch(`https://x/s/${r.token}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const html = await res.text();
    expect(html).toContain('inválido ou expirado');
    expect(html).not.toContain('Task t1'); // não confirma existência
  });

  it('token revogado → 404 (mesma resposta do inexistente)', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    await revokeShare(E, 't1');
    const revoked = await SELF.fetch(`https://x/s/${r.token}`);
    const ghost = await SELF.fetch(`https://x/s/ebs_ghost0000000000000000000000000000000000000`);
    expect(revoked.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(await revoked.text()).toBe(await ghost.text());
  });

  it('token com formato inválido → 404', async () => {
    const res = await SELF.fetch(`https://x/s/lixo`);
    expect(res.status).toBe(404);
  });

  it('POST em /s/<token> → 404 (só GET)', async () => {
    await seedTask('t1');
    const r = await createShare(E, 't1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    const res = await SELF.fetch(`https://x/s/${r.token}`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('endpoints de sessão /app/tasks/share e /unshare', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('sem sessão → 401', async () => {
    await seedTask('t1');
    const res = await post('/app/tasks/share', { id: 't1' });
    expect(res.status).toBe(401);
    const res2 = await post('/app/tasks/unshare', { id: 't1' });
    expect(res2.status).toBe(401);
  });

  it('com sessão: cria link e depois revoga (link morre)', async () => {
    await seedTask('t1');
    const cookie = await sessionCookieHeader();
    const create = await post('/app/tasks/share', { id: 't1', expires_days: 7 }, cookie);
    expect(create.status).toBe(201);
    const data = (await create.json()) as any;
    expect(data.ok).toBe(true);
    expect(typeof data.url).toBe('string');
    const token = data.url.split('/s/')[1];
    // Link vivo.
    expect((await SELF.fetch(`https://x/s/${token}`)).status).toBe(200);
    // Revoga.
    const unshare = await post('/app/tasks/unshare', { id: 't1' }, cookie);
    expect(unshare.status).toBe(200);
    expect(((await unshare.json()) as any).revoked).toBe(true);
    // Morre no request seguinte.
    expect((await SELF.fetch(`https://x/s/${token}`)).status).toBe(404);
  });

  it('já compartilhada sem renew → 200 already_shared (mantém o link)', async () => {
    await seedTask('t1');
    const cookie = await sessionCookieHeader();
    await post('/app/tasks/share', { id: 't1' }, cookie);
    const again = await post('/app/tasks/share', { id: 't1' }, cookie);
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).already_shared).toBe(true);
  });

  it('expires_days inválido → 400; id inexistente → 404', async () => {
    await seedTask('t1');
    const cookie = await sessionCookieHeader();
    expect((await post('/app/tasks/share', { id: 't1', expires_days: 9999 }, cookie)).status).toBe(400);
    expect((await post('/app/tasks/share', { id: 'ghost' }, cookie)).status).toBe(404);
  });
});
