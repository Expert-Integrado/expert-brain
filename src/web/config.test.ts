import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../db/migrate.js';
import { signSession } from './session.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

async function authCookie(): Promise<string> {
  const token = await signSession('robson@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

beforeAll(async () => {
  (env as any).OWNER_EMAIL = 'robson@example.com';
  (env as any).SESSION_SECRET = SECRET;
  await runMigrations(env as any);
});

describe('/app/config', () => {
  it('redirects to /app/login without session', async () => {
    const res = await SELF.fetch('https://x.test/app/config', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/app\/login/);
  });

  it('renders the config page with sidebar nav when authenticated', async () => {
    const res = await SELF.fetch('https://x.test/app/config', {
      headers: { cookie: await authCookie() },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('MCP server URL');
    expect(html).toContain('Personalization prompt');
    expect(html).toContain('href="/app/graph"');
    expect(html).toContain('href="/app/notes"');
  });

  it('serves the config bundle script as JS', async () => {
    const res = await SELF.fetch('https://x.test/app/config/bundle.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('javascript');
    const js = await res.text();
    expect(js).toContain("location.origin + '/mcp'");
  });
});

describe('/app routing defaults', () => {
  it('redirects /app to /app/graph', async () => {
    const res = await SELF.fetch('https://x.test/app', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/graph');
  });

  it('redirects /app/ to /app/graph', async () => {
    const res = await SELF.fetch('https://x.test/app/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/graph');
  });
});
