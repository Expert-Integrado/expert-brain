import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { hashPassword } from '../auth/password.js';

describe('/app/login', () => {
  it('GET renders the login form', async () => {
    const res = await SELF.fetch('https://x.test/app/login');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<input type="email"');
    expect(html).toContain('<input type="password"');
  });

  it('POST with correct credentials sets eb_session cookie', async () => {
    // OWNER_EMAIL, OWNER_PASSWORD_HASH, SESSION_SECRET are pre-configured in vitest.config.ts miniflare bindings.
    // The hash corresponds to 'correct-horse-battery-staple' (PBKDF2-SHA256, fixed salt).
    const form = new URLSearchParams({ email: 'owner@example.com', password: 'correct-horse-battery-staple' });
    const res = await SELF.fetch('https://x.test/app/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://x.test' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/graph');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^eb_session=/);
    expect(setCookie).toContain('HttpOnly');
  });

  it('POST with wrong password returns 401', async () => {
    // OWNER_EMAIL, OWNER_PASSWORD_HASH, SESSION_SECRET are pre-configured in vitest.config.ts miniflare bindings.
    // Posting 'wrong' against the pre-configured hash will fail verification → 401.
    const form = new URLSearchParams({ email: 'owner@example.com', password: 'wrong' });
    const res = await SELF.fetch('https://x.test/app/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://x.test' },
      body: form.toString(),
    });
    expect(res.status).toBe(401);
  });

  it('POST with mismatched Origin returns 403', async () => {
    (env as any).OWNER_EMAIL = 'owner@example.com';
    (env as any).OWNER_PASSWORD_HASH = await hashPassword('correct-horse-battery-staple');
    (env as any).SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
    const form = new URLSearchParams({ email: 'owner@example.com', password: 'correct-horse-battery-staple' });
    const res = await SELF.fetch('https://x.test/app/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.test' },
      body: form.toString(),
    });
    expect(res.status).toBe(403);
  });

  it('POST ignores open-redirect next parameter', async () => {
    const form = new URLSearchParams({
      email: 'owner@example.com',
      password: 'correct-horse-battery-staple',
      next: '/app/..//evil.com',
    });
    const res = await SELF.fetch('https://x.test/app/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://x.test' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/graph');
  });

  it('POST /app/logout clears the cookie', async () => {
    const res = await SELF.fetch('https://x.test/app/logout', {
      method: 'POST',
      headers: { origin: 'https://x.test' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });
});
