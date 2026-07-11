import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import {
  handlePushVapidKeyGet,
  handlePushSubscribePost,
  handlePushUnsubscribePost,
  handlePushPendingGet,
  handlePushTestPost,
  sendPushToAll,
  runPushDigest,
} from '../src/web/push.js';
import { listPushSubscriptions, upsertPushSubscription } from '../src/db/push-queries.js';

// Web Push sem payload (specs/50-console-v2/68): VAPID JWT ES256 via WebCrypto,
// POST vazio pro push service, conteúdo buscado pelo SW em /app/push/pending.
// A chave de teste é GERADA aqui (generateKey) — nenhum material de chave commitado.

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function jsonReq(path: string, opts: { cookie?: string; body?: unknown; method?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return new Request('https://x' + path, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
}

async function testVapidJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return JSON.stringify(jwk);
}

async function resetDb(): Promise<void> {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM push_subscriptions');
  await E.DB.exec('DELETE FROM inbox_items');
  await E.DB.exec('DELETE FROM edges');
  await E.DB.exec('DELETE FROM tags');
  await E.DB.exec('DELETE FROM similar_edges');
  await E.DB.exec('DELETE FROM notes');
}

afterEach(() => {
  delete E.VAPID_PRIVATE_KEY;
  vi.unstubAllGlobals();
});

describe('GET /app/push/vapid-key', () => {
  beforeEach(resetDb);

  it('sem sessão: 401', async () => {
    const res = await handlePushVapidKeyGet(jsonReq('/app/push/vapid-key'), E);
    expect(res.status).toBe(401);
  });

  it('sem VAPID_PRIVATE_KEY: { key: null } (push desligado)', async () => {
    const res = await handlePushVapidKeyGet(jsonReq('/app/push/vapid-key', { cookie: await cookie() }), E);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).key).toBeNull();
  });

  it('com JWK configurado: devolve a pública derivada (ponto não-comprimido, 65 bytes)', async () => {
    E.VAPID_PRIVATE_KEY = await testVapidJwk();
    const res = await handlePushVapidKeyGet(jsonReq('/app/push/vapid-key', { cookie: await cookie() }), E);
    const { key } = (await res.json()) as { key: string };
    expect(typeof key).toBe('string');
    const b64 = key.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });
});

describe('subscribe / unsubscribe', () => {
  beforeEach(resetDb);

  it('grava a assinatura; re-assinar o MESMO endpoint atualiza em vez de duplicar', async () => {
    const c = await cookie();
    const sub = { endpoint: 'https://push.example/reg/abc', keys: { p256dh: 'pk', auth: 'au' } };
    expect((await handlePushSubscribePost(jsonReq('/app/push/subscribe', { cookie: c, body: sub }), E)).status).toBe(200);
    expect((await handlePushSubscribePost(jsonReq('/app/push/subscribe', { cookie: c, body: { ...sub, keys: { p256dh: 'pk2', auth: 'au2' } } }), E)).status).toBe(200);
    const rows = await listPushSubscriptions(E);
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe('pk2');
  });

  it('endpoint não-https: 400', async () => {
    const res = await handlePushSubscribePost(
      jsonReq('/app/push/subscribe', { cookie: await cookie(), body: { endpoint: 'http://inseguro.example/x' } }),
      E
    );
    expect(res.status).toBe(400);
  });

  it('unsubscribe remove a linha', async () => {
    const c = await cookie();
    await handlePushSubscribePost(jsonReq('/app/push/subscribe', { cookie: c, body: { endpoint: 'https://push.example/reg/1' } }), E);
    await handlePushUnsubscribePost(jsonReq('/app/push/unsubscribe', { cookie: c, body: { endpoint: 'https://push.example/reg/1' } }), E);
    expect(await listPushSubscriptions(E)).toHaveLength(0);
  });
});

describe('GET /app/push/pending', () => {
  beforeEach(resetDb);

  it('conta task atrasada + inbox pendente no body e no badge_count', async () => {
    const now = Date.now();
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,created_at,updated_at)
       VALUES ('t1','Task atrasada','b','tl','["operations"]','task','open',?,1,1)`
    ).bind(now - 3600_000).run();
    await E.DB.prepare(`INSERT INTO inbox_items (id, body, source, created_at) VALUES ('ibx_1','x','console',1)`).run();
    const res = await handlePushPendingGet(jsonReq('/app/push/pending', { cookie: await cookie() }), E);
    const data = (await res.json()) as any;
    expect(data.badge_count).toBe(2);
    expect(data.body).toContain('atrasada');
    expect(data.body).toContain('inbox');
  });

  it('nada pendente: "Tudo em dia." e badge 0', async () => {
    const res = await handlePushPendingGet(jsonReq('/app/push/pending', { cookie: await cookie() }), E);
    const data = (await res.json()) as any;
    expect(data.badge_count).toBe(0);
    expect(data.body).toBe('Tudo em dia.');
  });
});

describe('envio (sendPushToAll / runPushDigest / test)', () => {
  beforeEach(resetDb);

  async function seedSub(endpoint: string): Promise<void> {
    await upsertPushSubscription(E, { id: 'ps_' + endpoint.slice(-1), endpoint, p256dh: null, auth: null, created_at: 1 });
  }

  it('POST vazio com header vapid; 201 marca last_ok_at, 410 remove a assinatura', async () => {
    E.VAPID_PRIVATE_KEY = await testVapidJwk();
    await seedSub('https://push.example/reg/1');
    await seedSub('https://push.example/reg/2');
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const u = String(url);
      calls.push({ url: u, auth: init?.headers?.Authorization ?? null });
      return new Response(null, { status: u.endsWith('/1') ? 201 : 410 });
    }));
    const r = await sendPushToAll(E, Date.now());
    expect(r).toMatchObject({ configured: true, sent: 1, removed: 1, failed: 0 });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.auth).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    }
    const rows = await listPushSubscriptions(E);
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe('https://push.example/reg/1');
    expect(rows[0].last_ok_at).not.toBeNull();
  });

  it('runPushDigest: sem pendência não envia nada (skip, zero fetch)', async () => {
    E.VAPID_PRIVATE_KEY = await testVapidJwk();
    await seedSub('https://push.example/reg/1');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await runPushDigest(E, Date.now());
    expect(r.skipped).toBe('nada pendente');
    expect(f).not.toHaveBeenCalled();
  });

  it('runPushDigest: com task vencendo dispara o envio', async () => {
    E.VAPID_PRIVATE_KEY = await testVapidJwk();
    await seedSub('https://push.example/reg/1');
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,status,due_at,created_at,updated_at)
       VALUES ('t1','Vence logo','b','tl','["operations"]','task','open',?,1,1)`
    ).bind(Date.now() + 3600_000).run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })));
    const r = await runPushDigest(E, Date.now());
    expect(r.sent).toBe(1);
  });

  it('sem VAPID: runPushDigest e /app/push/test degradam sem explodir', async () => {
    const digest = await runPushDigest(E, Date.now());
    expect(digest.configured).toBe(false);
    const res = await handlePushTestPost(jsonReq('/app/push/test', { cookie: await cookie(), method: 'POST' }), E);
    expect(res.status).toBe(503);
  });
});
