import { describe, it, expect } from 'vitest';
import { signSession, verifySession } from './session.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

describe('session cookie', () => {
  it('round-trips an email', async () => {
    const token = await signSession('robson@example.com', SECRET, 1712990000);
    const result = await verifySession(token, SECRET, 1712990000 + 60);
    expect(result).toEqual({ email: 'robson@example.com', issuedAt: 1712990000 });
  });

  it('rejects a tampered token', async () => {
    const token = await signSession('robson@example.com', SECRET, 1712990000);
    const [e, i, _sig] = token.split('.');
    const tampered = `${e}.${i}.ZmFrZXNpZw`;
    expect(await verifySession(tampered, SECRET, 1712990000 + 60)).toBeNull();
  });

  it('rejects an expired token (> 7d)', async () => {
    const token = await signSession('robson@example.com', SECRET, 1712990000);
    const eightDaysLater = 1712990000 + 8 * 86400;
    expect(await verifySession(token, SECRET, eightDaysLater)).toBeNull();
  });

  it('rejects a wrong secret', async () => {
    const token = await signSession('robson@example.com', SECRET, 1712990000);
    expect(await verifySession(token, 'other-secret', 1712990000 + 60)).toBeNull();
  });
});

import { sessionCookie, readCookie, requireSession } from './session.js';

describe('sessionCookie', () => {
  it('builds a Set-Cookie string with the right flags', () => {
    const c = sessionCookie('abc.def.ghi');
    expect(c).toMatch(/^mv_session=abc\.def\.ghi/);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/app');
    expect(c).toContain('Max-Age=604800');
  });

  it('builds a clearing cookie', () => {
    const c = sessionCookie('', { clear: true });
    expect(c).toContain('Max-Age=0');
  });
});

describe('readCookie', () => {
  it('reads mv_session from a Cookie header', () => {
    expect(readCookie('foo=1; mv_session=abc.def.ghi; bar=2', 'mv_session')).toBe('abc.def.ghi');
  });
  it('returns null if not present', () => {
    expect(readCookie('foo=1', 'mv_session')).toBeNull();
  });
  it('returns null for missing header', () => {
    expect(readCookie(null, 'mv_session')).toBeNull();
  });
});

describe('requireSession', () => {
  const env = { SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef' } as any;

  it('returns the email when the cookie is valid', async () => {
    const token = await signSession('robson@example.com', env.SESSION_SECRET, Math.floor(Date.now() / 1000));
    const req = new Request('https://x.test/app/notes', { headers: { Cookie: `mv_session=${token}` } });
    const result = await requireSession(req, env);
    expect(result).toEqual({ ok: true, email: 'robson@example.com' });
  });

  it('returns a redirect when the cookie is missing', async () => {
    const req = new Request('https://x.test/app/notes');
    const result = await requireSession(req, env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(302);
      expect(result.response.headers.get('location')).toBe('/app/login?next=%2Fapp%2Fnotes');
    }
  });

  it('returns a redirect when the cookie is invalid', async () => {
    const req = new Request('https://x.test/app/notes', { headers: { Cookie: 'mv_session=bad.token.sig' } });
    const result = await requireSession(req, env);
    expect(result.ok).toBe(false);
  });

  // Sessão expirada em request de dados não pode "passar" silenciosamente: o
  // fetch do browser seguiria o 302 e receberia res.ok === true com HTML de
  // login no corpo. Ver specs/20-frontend/21-csp-botoes-mortos-e-sessao-expirada.md.
  it('returns 401 JSON when accept is application/json and there is no cookie', async () => {
    const req = new Request('https://x.test/app/tasks/data', { headers: { accept: 'application/json' } });
    const result = await requireSession(req, env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get('content-type')).toContain('application/json');
      expect(await result.response.json()).toEqual({ error: 'session expired' });
    }
  });

  it('returns 401 JSON for a non-GET request to a data route without accept header', async () => {
    const req = new Request('https://x.test/app/tasks/complete', { method: 'POST' });
    const result = await requireSession(req, env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.json()).toEqual({ error: 'session expired' });
    }
  });

  it('returns 401 JSON for a non-GET request to a media route without accept header', async () => {
    const req = new Request('https://x.test/app/notes/abc123/media', { method: 'POST' });
    const result = await requireSession(req, env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it('keeps the 302 redirect for a GET page navigation without accept: application/json', async () => {
    const req = new Request('https://x.test/app/tasks', { headers: { accept: 'text/html' } });
    const result = await requireSession(req, env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(302);
      expect(result.response.headers.get('location')).toBe('/app/login?next=%2Fapp%2Ftasks');
    }
  });
});
