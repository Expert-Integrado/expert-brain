import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { createShare, resolveShare, revokeShare, getShareStatus, SHARE_TOKEN_RE } from '../src/web/share.js';
import { setNotePrivate } from '../src/db/queries.js';

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
  ).bind(id, `Nota ${id}`, 'Corpo **markdown** com [[wikilink quebrado]].', `Resumo da nota ${id}`, '["operations"]').run();
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

  it('createShare aceita nota de conhecimento (spec 33 reconciliada — mesmo trilho)', async () => {
    await seedNote('n1');
    const r = await createShare(E, 'n1', {}, Date.now());
    expect(r.ok).toBe(true);
    if (r.ok) expect(SHARE_TOKEN_RE.test(r.token)).toBe(true);
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

// ─────────────── Share de NOTA de conhecimento (spec 33 reconciliada) ───────────────
// A spec original previa tabela dedicada; a execução convergiu no MESMO trilho do
// share de task (colunas em `notes` + share_include_media, migration 0016).

describe('share de NOTA de conhecimento (spec 33)', () => {
  beforeEach(async () => {
    await runMigrations(E);
    await E.DB.exec('DELETE FROM notes');
  });

  it('página pública renderiza a nota read-only, SEM comentários e SEM /app/*', async () => {
    await seedNote('n1');
    const r = await createShare(E, 'n1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    const res = await SELF.fetch(`https://x/s/${r.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'");
    const html = await res.text();
    expect(html).toContain('Nota n1');
    expect(html).toContain('Resumo da nota n1');
    expect(html).toContain('Nota compartilhada');
    // Nota de conhecimento NÃO tem thread/form de comentário (só task, spec 53).
    // ('Comentários' aparece num comentário do CSS compartilhado — o que importa é
    // não haver FORM nem action de comment no markup.)
    expect(html).not.toContain('<form');
    expect(html).not.toContain('/s/' + r.token + '/comment');
    // Zero superfície logada; wikilink vira span quebrado, nunca âncora.
    expect(html).not.toContain('/app/');
    expect(html).toContain('wikilink broken');
    expect(html).not.toContain('href="/app/notes');
  });

  it('POST /s/<token>/comment em share de NOTA → 404 e nada gravado', async () => {
    await seedNote('n1');
    const r = await createShare(E, 'n1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    const form = new FormData();
    form.set('name', 'Convidado');
    form.set('body', 'tentativa');
    const res = await SELF.fetch(`https://x/s/${r.token}/comment`, { method: 'POST', body: form });
    expect(res.status).toBe(404);
    const n = await E.DB.prepare(`SELECT COUNT(*) AS c FROM task_comments`).first();
    expect(n?.c).toBe(0);
  });

  it('nota privada: recusa na criação E privatizar depois mata o link (fail-closed)', async () => {
    await seedNote('n1');
    await E.DB.prepare(`UPDATE notes SET private = 1 WHERE id = 'n1'`).run();
    const refused = await createShare(E, 'n1', {}, Date.now());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('private');

    await seedNote('n2');
    const r = await createShare(E, 'n2', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    expect((await SELF.fetch(`https://x/s/${r.token}`)).status).toBe(200);
    // setNotePrivate revoga o share na MESMA escrita (spec 31 + 33).
    const ok = await setNotePrivate(E, 'n2', 1, Date.now());
    expect(ok).toBe(true);
    const row = await E.DB.prepare(`SELECT share_token, share_include_media FROM notes WHERE id = 'n2'`).first();
    expect(row?.share_token).toBeNull();
    expect(row?.share_include_media).toBe(0);
    expect((await SELF.fetch(`https://x/s/${r.token}`)).status).toBe(404);
  });

  it('mídia: só com include_media, só da nota do share, com no-store', async () => {
    await seedNote('n1');
    await seedNote('n2');
    // Anexo da n1 e anexo da n2 direto no D1 + R2 (sem passar pelo upload).
    await E.MEDIA.put('blob/m1', new Uint8Array([1, 2, 3]));
    await E.MEDIA.put('blob/m2', new Uint8Array([9, 9]));
    const insert = (id: string, noteId: string, key: string) =>
      E.DB.prepare(
        `INSERT INTO note_media (id, note_id, kind, r2_key, content_hash, mime_type, size_bytes, original_filename, created_at)
         VALUES (?, ?, 'image', ?, ?, 'image/png', 3, 'foto.png', 1000)`
      ).bind(id, noteId, key, 'hash-' + id).run();
    await insert('m1', 'n1', 'blob/m1');
    await insert('m2', 'n2', 'blob/m2');

    // Share SEM mídia: página não lista anexos e a rota de mídia dá 404.
    const semMidia = await createShare(E, 'n1', {}, Date.now());
    if (!semMidia.ok) throw new Error('setup');
    expect(await (await SELF.fetch(`https://x/s/${semMidia.token}`)).text()).not.toContain('Anexos');
    expect((await SELF.fetch(`https://x/s/${semMidia.token}/media/m1`)).status).toBe(404);

    // Share COM mídia: página lista, rota serve com no-store; mídia de OUTRA nota → 404.
    const comMidia = await createShare(E, 'n1', { renew: true, includeMedia: true }, Date.now());
    if (!comMidia.ok) throw new Error('setup');
    const page = await SELF.fetch(`https://x/s/${comMidia.token}`);
    const html = await page.text();
    expect(html).toContain('Anexos');
    expect(html).toContain(`/s/${comMidia.token}/media/m1`);
    // Nenhuma signed URL de sessão nem key R2 no HTML público.
    expect(html).not.toContain('?t=');
    expect(html).not.toContain('blob/m1');
    const media = await SELF.fetch(`https://x/s/${comMidia.token}/media/m1`);
    expect(media.status).toBe(200);
    expect(media.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await SELF.fetch(`https://x/s/${comMidia.token}/media/m2`)).status).toBe(404);
    expect((await SELF.fetch(`https://x/s/${comMidia.token}/media/ghost`)).status).toBe(404);
  });

  it('endpoints /app/notes/share e /app/notes/unshare funcionam com sessão', async () => {
    await seedNote('n1');
    const cookie = await sessionCookieHeader();
    const create = await post('/app/notes/share', { id: 'n1', expires_days: 7, include_media: true }, cookie);
    expect(create.status).toBe(201);
    const data = (await create.json()) as any;
    const token = data.url.split('/s/')[1];
    expect((await SELF.fetch(`https://x/s/${token}`)).status).toBe(200);
    const flag = await E.DB.prepare(`SELECT share_include_media FROM notes WHERE id = 'n1'`).first();
    expect(flag?.share_include_media).toBe(1);
    const unshare = await post('/app/notes/unshare', { id: 'n1' }, cookie);
    expect(unshare.status).toBe(200);
    expect((await SELF.fetch(`https://x/s/${token}`)).status).toBe(404);
  });

  it('rate-limit público: mesmo IP estoura em 30 req/min → 429 com retry-after', async () => {
    await seedNote('n1');
    const r = await createShare(E, 'n1', {}, Date.now());
    if (!r.ok) throw new Error('setup');
    const headers = { 'CF-Connecting-IP': '10.77.0.42' };
    let got429: Response | null = null;
    // 30 permitidas por janela de minuto; a janela pode rolar no meio, então itera
    // com folga e para no primeiro 429 (determinístico sem depender do relógio).
    for (let i = 0; i < 70; i++) {
      const res = await SELF.fetch(`https://x/s/${r.token}`, { headers });
      if (res.status === 429) { got429 = res; break; }
      expect(res.status).toBe(200);
    }
    expect(got429).not.toBeNull();
    expect(Number(got429!.headers.get('retry-after'))).toBeGreaterThan(0);
    // Sem o header de IP (ex.: tráfego interno de teste) não limita.
    expect((await SELF.fetch(`https://x/s/${r.token}`)).status).toBe(200);
  });
});
