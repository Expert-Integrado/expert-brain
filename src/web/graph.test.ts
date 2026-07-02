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

describe('/app/graph/data — similar edges lidas do D1', () => {
  beforeAll(async () => {
    // terceira nota viva (g3) + uma soft-deletada (gdel)
    await (env as any).DB.prepare(`INSERT OR IGNORE INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
      VALUES ('g3','Graph Three','b','t','["music"]',NULL,4,4)`).run();
    await (env as any).DB.prepare(`INSERT OR IGNORE INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at,deleted_at)
      VALUES ('gdel','Deleted','b','t','["operations"]',NULL,5,5,5)`).run();
    await (env as any).DB.prepare(`DELETE FROM similar_edges`).run();
    const ins = (a: string, b: string, s: number) => (env as any).DB
      .prepare(`INSERT OR IGNORE INTO similar_edges (from_id,to_id,score) VALUES (?,?,?)`).bind(a, b, s).run();
    await ins('g1', 'g2', 0.90);   // par que JÁ tem edge explícita → não vira 'similar'
    await ins('g1', 'g3', 0.80);   // par novo → vira 'similar'
    await ins('g3', 'g1', 0.80);   // simétrico do anterior → deduplicado
    await ins('g1', 'gdel', 0.70); // alvo soft-deletado → descartado
  });

  it('dedup simétrico, descarta par explícito e nota soft-deletada', async () => {
    const res = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    const similar = data.edges.filter((e: any) => e.type === 'similar');

    // exatamente 1 edge similar: g1↔g3 (g1-g2 caiu por ser explícita, g1-gdel por deletada,
    // g3→g1 deduplicado contra g1→g3)
    expect(similar).toHaveLength(1);
    expect([similar[0].source, similar[0].target].sort()).toEqual(['g1', 'g3']);
    expect(similar[0].score).toBeCloseTo(0.80);

    // g3 entrou como nó vivo; gdel (soft-deletada) não aparece
    expect(data.nodes.find((n: any) => n.id === 'g3')).toBeDefined();
    expect(data.nodes.find((n: any) => n.id === 'gdel')).toBeUndefined();
  });

  it('sourceHash muda quando o CONTEUDO de similar_edges muda (mesma cardinalidade) — anti cache-stale', async () => {
    const r1 = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    const d1 = await r1.json() as any;
    // muda só o SCORE de uma similar edge — count permanece igual. Sem o SUM(score) no
    // sourceHash isto serviria cache stale (cenário reembed/re-backfill).
    await (env as any).DB.prepare(`UPDATE similar_edges SET score = 0.55 WHERE from_id = 'g1' AND to_id = 'g3'`).run();
    const r2 = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    const d2 = await r2.json() as any;
    expect(d2.sourceHash).not.toBe(d1.sourceHash);
  });
});

describe('/app/graph3d (grafo 3D — o globo que gira)', () => {
  it('redirects to login without session', async () => {
    const res = await SELF.fetch('https://x.test/app/graph3d', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/app/login');
  });

  it('renders the 3D shell with a session', async () => {
    const res = await SELF.fetch('https://x.test/app/graph3d', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // canvas do 3D + bundle carregado + botão de voltar pro 2D
    expect(html).toContain('id="graph3d-canvas"');
    expect(html).toContain('/app/graph3d/bundle.js');
    expect(html).toContain('href="/app/graph"');
  });
});
