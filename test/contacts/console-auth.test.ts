import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleLoginPost, handleLogoutPost } from '../../src/contacts/web/login';
import { handleSso } from '../../src/contacts/web/sso';
import { requireSession, signSession, getSessionKeyMaterial } from '../../src/contacts/web/session';
import { hashPassword } from '../../src/contacts/auth/password';

// spec 20-frontend/27 — rate-limit no login (espelho do módulo do Brain, spec
// 10-backend/18: a 6ª falha registra o bloqueio, a 7ª tentativa toma 429),
// SSO single-use por nonce e session-epoch (logout/troca de senha revogam tudo).

const E = env as any;
const OWNER = 'owner@example.com';
const GOOD_PW = 'correct-horse-battery';

let TENV: any;

beforeAll(async () => {
  TENV = { ...E, OWNER_EMAIL: OWNER, OWNER_PASSWORD_HASH: await hashPassword(GOOD_PW), SSO_SECRET: 'sso-secret-test' };
});

function loginReq(email: string, password: string, ip: string): Request {
  const form = new FormData();
  form.set('email', email);
  form.set('password', password);
  form.set('next', '/app/graph');
  return new Request('https://x.test/app/login', {
    method: 'POST',
    headers: { origin: 'https://x.test', 'CF-Connecting-IP': ip },
    body: form,
  });
}

describe('rate-limit no login do Console (spec 27)', () => {
  it('6 falhas de senha => 401; a 7a tentativa => 429 com Retry-After', async () => {
    const ip = '10.9.1.1';
    for (let i = 0; i < 6; i++) {
      const r = await handleLoginPost(loginReq(OWNER, 'senha-errada', ip), TENV);
      expect(r.status).toBe(401);
    }
    const blocked = await handleLoginPost(loginReq(OWNER, 'senha-errada', ip), TENV);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // senha CERTA também é bloqueada enquanto durar o backoff
    const evenGood = await handleLoginPost(loginReq(OWNER, GOOD_PW, ip), TENV);
    expect(evenGood.status).toBe(429);
  });

  it('e-mail inexistente conta no bucket igual (sem oraculo de e-mail)', async () => {
    const ip = '10.9.1.2';
    for (let i = 0; i < 6; i++) {
      const r = await handleLoginPost(loginReq('ghost@example.com', 'x', ip), TENV);
      expect(r.status).toBe(401);
    }
    const blocked = await handleLoginPost(loginReq('ghost@example.com', 'x', ip), TENV);
    expect(blocked.status).toBe(429);
  });

  it('login correto apos falhas (antes do bloqueio) zera o bucket e cria sessao', async () => {
    const ip = '10.9.1.3';
    for (let i = 0; i < 2; i++) await handleLoginPost(loginReq(OWNER, 'errada', ip), TENV);
    const ok = await handleLoginPost(loginReq(OWNER, GOOD_PW, ip), TENV);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('set-cookie')).toContain('mv_session=');
    // bucket zerado: nenhuma chave rl:login:<ip>:* sobra no KV
    const keys = await E.CACHE.list({ prefix: `rl:login:${ip}:` });
    expect(keys.keys.length).toBe(0);
  });
});

// ── SSO single-use ──────────────────────────────────────────────────────────
const enc = new TextEncoder();
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ssoUrl(exp: number, nonce: string): Promise<string> {
  const sig = await hmacHex('sso-secret-test', `sso:${exp}:${nonce}`);
  return `https://x.test/app/sso?exp=${exp}&nonce=${nonce}&sig=${sig}`;
}

describe('SSO single-use por nonce (spec 27)', () => {
  it('URL valida cria sessao UMA vez; a mesma URL de novo cai no login sem cookie', async () => {
    const url = await ssoUrl(Date.now() + 60_000, crypto.randomUUID());
    const first = await handleSso(new Request(url), TENV);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/app/graph');
    expect(first.headers.get('set-cookie')).toContain('mv_session=');

    const replay = await handleSso(new Request(url), TENV);
    expect(replay.status).toBe(302);
    expect(replay.headers.get('location')).toBe('/app/login');
    expect(replay.headers.get('set-cookie')).toBeNull();
  });

  it('exp vencido => login; formato antigo (sem nonce) => login', async () => {
    const expired = await handleSso(new Request(await ssoUrl(Date.now() - 1000, crypto.randomUUID())), TENV);
    expect(expired.headers.get('location')).toBe('/app/login');

    const exp = Date.now() + 60_000;
    const oldSig = await hmacHex('sso-secret-test', `sso:${exp}`);
    const old = await handleSso(new Request(`https://x.test/app/sso?exp=${exp}&sig=${oldSig}`), TENV);
    expect(old.headers.get('location')).toBe('/app/login');
    expect(old.headers.get('set-cookie')).toBeNull();
  });

  it('sig sobre nonce errado => login', async () => {
    const exp = Date.now() + 60_000;
    const sig = await hmacHex('sso-secret-test', `sso:${exp}:${crypto.randomUUID()}`);
    const r = await handleSso(new Request(`https://x.test/app/sso?exp=${exp}&nonce=${crypto.randomUUID()}&sig=${sig}`), TENV);
    expect(r.headers.get('location')).toBe('/app/login');
  });
});

// ── Session-epoch ───────────────────────────────────────────────────────────
describe('session-epoch: logout e troca de senha revogam tudo (spec 27)', () => {
  async function sessionOk(token: string, envObj: any): Promise<boolean> {
    const req = new Request('https://x.test/app/graph', { headers: { cookie: `mv_session=${token}` } });
    return (await requireSession(req, envObj)).ok;
  }

  it('logout bumpa o epoch e derruba sessao de OUTRO dispositivo', async () => {
    const token = await signSession(OWNER, await getSessionKeyMaterial(TENV), Math.floor(Date.now() / 1000));
    expect(await sessionOk(token, TENV)).toBe(true);

    const logout = await handleLogoutPost(
      new Request('https://x.test/app/logout', { method: 'POST', headers: { origin: 'https://x.test' } }),
      TENV
    );
    expect(logout.status).toBe(302);
    // o MESMO token (outro dispositivo) agora falha
    expect(await sessionOk(token, TENV)).toBe(false);
    // sessao nova pos-bump passa
    const fresh = await signSession(OWNER, await getSessionKeyMaterial(TENV), Math.floor(Date.now() / 1000));
    expect(await sessionOk(fresh, TENV)).toBe(true);
  });

  it('trocar OWNER_PASSWORD_HASH invalida sessoes antigas sem passo manual', async () => {
    const token = await signSession(OWNER, await getSessionKeyMaterial(TENV), Math.floor(Date.now() / 1000));
    expect(await sessionOk(token, TENV)).toBe(true);
    const rotated = { ...TENV, OWNER_PASSWORD_HASH: await hashPassword('nova-senha-forte') };
    expect(await sessionOk(token, rotated)).toBe(false);
  });
});
