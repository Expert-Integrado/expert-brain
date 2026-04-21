import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../db/migrate.js';
import { signSession } from './session.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

async function authCookie(): Promise<string> {
  const token = await signSession('robson@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

async function seed() {
  const db = (env as any).DB;
  await db.prepare(`INSERT OR REPLACE INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
    VALUES ('n1','Alpha','# Alpha\\n\\nbody','sum','["infra"]',NULL,1,1)`).run();
  await db.prepare(`INSERT OR REPLACE INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
    VALUES ('n2','Beta','# Beta','sum','["retrieval"]',NULL,2,2)`).run();
  await db.prepare(`INSERT OR IGNORE INTO edges (id,from_id,to_id,relation_type,why,created_at)
    VALUES ('e1','n1','n2','depends_on','shared mechanism explained here',3)`).run();
}

beforeAll(async () => {
  (env as any).OWNER_EMAIL = 'robson@example.com';
  (env as any).SESSION_SECRET = SECRET;
  await runMigrations(env as any);
  await seed();
});

describe('/app/notes', () => {
  it('redirects to login without cookie', async () => {
    const res = await SELF.fetch('https://x.test/app/notes', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/app/login');
  });

  it('lists notes ordered by updated_at DESC', async () => {
    const res = await SELF.fetch('https://x.test/app/notes', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    const alphaIdx = html.indexOf('Alpha');
    const betaIdx = html.indexOf('Beta');
    expect(betaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(betaIdx).toBeLessThan(alphaIdx);
  });

  it('renders note detail with markdown and outbound links', async () => {
    const res = await SELF.fetch('https://x.test/app/notes/n1', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1');
    expect(html).toContain('Alpha');
    expect(html).toContain('href="/app/notes/n2"');
    expect(html).toContain('shared mechanism explained here');
  });

  it('returns 404 for unknown note id', async () => {
    const res = await SELF.fetch('https://x.test/app/notes/nope', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(404);
  });
});
