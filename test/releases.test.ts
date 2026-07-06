// Spec 50-console-v2/71 — Novidades: banner no shell até visitar /app/novidades,
// página lista releases e marca como vista, sessão obrigatória.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import { RELEASES, LATEST_RELEASE_ID, readLastSeenRelease } from '../src/web/releases-data.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const E = env as any;

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => {
  E.OWNER_EMAIL = 'owner@example.com';
  E.SESSION_SECRET = SECRET;
  await runMigrations(E);
});

beforeEach(async () => {
  await E.DB.prepare(`DELETE FROM meta WHERE key = 'last_seen_release'`).run();
});

describe('banner de novidades no shell', () => {
  it('aparece em página logada quando a release mais recente não foi vista', async () => {
    const res = await SELF.fetch('https://x/app/notes', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/app/novidades');
    expect(html).toContain('release-banner');
  });

  it('some depois de visitar /app/novidades', async () => {
    const cookie = await authCookie();
    const visit = await SELF.fetch('https://x/app/novidades', { headers: { cookie } });
    expect(visit.status).toBe(200);
    expect(await readLastSeenRelease(E)).toBe(LATEST_RELEASE_ID);
    const after = await SELF.fetch('https://x/app/notes', { headers: { cookie } });
    expect(await after.text()).not.toContain('release-banner');
  });
});

describe('GET /app/novidades', () => {
  it('lista a release mais recente com highlights', async () => {
    const res = await SELF.fetch('https://x/app/novidades', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(RELEASES[0].title);
    // Trecho sem aspas/HTML-escapáveis (o render escapa " pra &quot;).
    expect(html).toContain('Kanban com colunas customizáveis');
    // A própria página não mostra o banner (já está nela).
    expect(html).not.toContain('release-banner');
  });

  it('sem sessão: não marca como vista e redireciona', async () => {
    const res = await SELF.fetch('https://x/app/novidades', { redirect: 'manual' });
    expect([302, 401]).toContain(res.status);
    expect(await readLastSeenRelease(E)).toBeNull();
  });
});
