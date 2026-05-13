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
    expect(html).toContain('URL do servidor MCP');
    expect(html).toContain('Prompt de personalização');
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

  it('renders default placeholder prompt on first visit', async () => {
    // Garante banco limpo pra esse teste — apaga qualquer valor salvo antes.
    await (env as any).DB.prepare(`DELETE FROM meta WHERE key = ?`)
      .bind('personalization_prompt')
      .run();
    const res = await SELF.fetch('https://x.test/app/config', {
      headers: { cookie: await authCookie() },
    });
    const html = await res.text();
    expect(html).toContain('[seu nome]');
    expect(html).not.toContain('Eric Luciano');
  });

  it('saves edited prompt and persists it on next render', async () => {
    const custom = 'Sou Asafe. Trabalho com automações e produto.';
    const form = new URLSearchParams({ prompt: `Expert Brain ${custom}` });
    const post = await SELF.fetch('https://x.test/app/config/prefs', {
      method: 'POST',
      headers: {
        cookie: await authCookie(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(post.status).toBe(302);

    const get = await SELF.fetch('https://x.test/app/config', {
      headers: { cookie: await authCookie() },
    });
    const html = await get.text();
    expect(html).toContain('Sou Asafe');
    expect(html).not.toContain('[seu nome]');
  });

  it('rejects empty prompt', async () => {
    const form = new URLSearchParams({ prompt: '   ' });
    const res = await SELF.fetch('https://x.test/app/config/prefs', {
      method: 'POST',
      headers: {
        cookie: await authCookie(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    expect(res.status).toBe(400);
  });

  it('rejects prompt over max length', async () => {
    const form = new URLSearchParams({ prompt: 'x'.repeat(8001) });
    const res = await SELF.fetch('https://x.test/app/config/prefs', {
      method: 'POST',
      headers: {
        cookie: await authCookie(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    expect(res.status).toBe(400);
  });

  it('rejects prefs POST without session', async () => {
    const form = new URLSearchParams({ prompt: 'foo' });
    const res = await SELF.fetch('https://x.test/app/config/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/app\/login/);
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
