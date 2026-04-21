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
  await (env as any).DB.prepare(`DELETE FROM edges`).run();
  await (env as any).DB.prepare(`DELETE FROM notes`).run();
  await (env as any).DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
    VALUES ('g1','Graph One','b','t','["infra"]',NULL,1,1)`).run();
  await (env as any).DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
    VALUES ('g2','Graph Two','b','t','["retrieval"]',NULL,2,2)`).run();
  await (env as any).DB.prepare(`INSERT INTO edges (id,from_id,to_id,relation_type,why,created_at)
    VALUES ('ge1','g1','g2','depends_on','because',3)`).run();
});

describe('/app/graph/data', () => {
  it('redirects without session', async () => {
    const res = await SELF.fetch('https://x.test/app/graph/data', { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('returns nodes and edges', async () => {
    const res = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.nodes).toHaveLength(2);
    expect(data.edges.length).toBeGreaterThanOrEqual(1);
    const explicit = data.edges.find((e: any) => e.type === 'explicit');
    expect(explicit).toBeDefined();
    expect(explicit.source).toBe('g1');
    expect(explicit.target).toBe('g2');
    for (const n of data.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it('serves from cache on second call (sourceHash match)', async () => {
    const r1 = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    const d1 = await r1.json() as any;
    const r2 = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    const d2 = await r2.json() as any;
    expect(d2.computedAt).toBe(d1.computedAt);
  });

  it('invalidates cache when a note is updated', async () => {
    const r1 = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    const d1 = await r1.json() as any;
    await (env as any).DB.prepare(`UPDATE notes SET updated_at = ? WHERE id = 'g1'`).bind(d1.computedAt + 10).run();
    const r2 = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    const d2 = await r2.json() as any;
    expect(d2.sourceHash).not.toBe(d1.sourceHash);
  });
});
