import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../db/migrate.js';
import { signSession } from './session.js';
import { PAYLOAD_BUDGET_BYTES } from './graph-data.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

async function authCookie(): Promise<string> {
  const token = await signSession('owner@example.com', SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

beforeAll(async () => {
  (env as any).OWNER_EMAIL = 'owner@example.com';
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

describe('/app/graph3d (rota legada → 302 pro modo 3D em /app/graph)', () => {
  it('redirects to /app/graph?mode=3d (sem sessão também — é 302 fixo antes do auth)', async () => {
    const res = await SELF.fetch('https://x.test/app/graph3d', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/graph?mode=3d');
  });

  it('redirects to /app/graph?mode=3d com sessão', async () => {
    const res = await SELF.fetch('https://x.test/app/graph3d', {
      headers: { cookie: await authCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/graph?mode=3d');
  });
});

describe('/app/graph?mode=3d (modo 3D dentro da mesma tela)', () => {
  it('renderiza a página do grafo já com o palco 3D e o painel esquerdo', async () => {
    const res = await SELF.fetch('https://x.test/app/graph?mode=3d', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Palco 3D presente + painel de controles preservado (busca) + toggle 2D/3D.
    expect(html).toContain('id="graph3d-stage"');
    expect(html).toContain('id="graph-search-input"');
    expect(html).toContain('data-graph-action="toggle-3d"');
    // Boot já em 3D: wrap com a classe mode-3d e botão mostrando "2D".
    expect(html).toContain('mode-3d');
    expect(html).toContain('data-graph-initial-mode="3d"');
  });

  it('sem ?mode fica em 2D por padrão (não liga o palco 3D no boot)', async () => {
    const res = await SELF.fetch('https://x.test/app/graph', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-graph-initial-mode="2d"');
    // O container 3D existe (pro lazy-load), mas o wrap NÃO nasce em mode-3d.
    expect(html).toContain('id="graph3d-stage"');
    expect(html).not.toContain('mode-3d mode-3d-loading');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spec 26: cap top-3 de similar edges, invalidação por hash-na-chave e orçamento
// de payload em escala.
// ─────────────────────────────────────────────────────────────────────────────

describe('/app/graph/data — cap top-3 de similar edges (spec 26)', () => {
  beforeAll(async () => {
    await (env as any).DB.prepare(`DELETE FROM edges`).run();
    await (env as any).DB.prepare(`DELETE FROM notes`).run();
    await (env as any).DB.prepare(`DELETE FROM similar_edges`).run();
    // hub c0 com 5 vizinhos por similaridade — só os top-3 por score devem entrar.
    for (let i = 0; i < 6; i++) {
      await (env as any).DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
        VALUES (?,?,?,?,?,NULL,?,?)`).bind(`c${i}`, `Cap ${i}`, 'b', 't', '["product"]', i + 1, i + 1).run();
    }
    const ins = (a: string, b: string, s: number) => (env as any).DB
      .prepare(`INSERT OR IGNORE INTO similar_edges (from_id,to_id,score) VALUES (?,?,?)`).bind(a, b, s).run();
    // 5 similares saindo de c0, scores decrescentes; só c0→c1/c2/c3 (top-3) sobrevivem.
    await ins('c0', 'c1', 0.99);
    await ins('c0', 'c2', 0.88);
    await ins('c0', 'c3', 0.77);
    await ins('c0', 'c4', 0.66); // fora do top-3
    await ins('c0', 'c5', 0.55); // fora do top-3
  });

  it('serve no máximo 3 similar edges por nó-fonte (window function no D1)', async () => {
    const res = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    const sims = data.edges.filter((e: any) => e.type === 'similar');
    // c0 tinha 5 candidatos; top-3 por score = c1,c2,c3. c4/c5 caem pelo cap.
    const targets = new Set<string>();
    for (const s of sims) { targets.add(s.source === 'c0' ? s.target : s.source); }
    expect(targets.has('c4')).toBe(false);
    expect(targets.has('c5')).toBe(false);
    expect(sims.length).toBeLessThanOrEqual(3);
  });
});

describe('/app/graph/link — invalidação por hash-na-chave sem GRAPH_CACHE.delete (spec 26)', () => {
  beforeAll(async () => {
    await (env as any).DB.prepare(`DELETE FROM edges`).run();
    await (env as any).DB.prepare(`DELETE FROM notes`).run();
    await (env as any).DB.prepare(`DELETE FROM similar_edges`).run();
    await (env as any).DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
      VALUES ('lk1','Link One','b','t','["infra"]',NULL,1,1)`).run();
    await (env as any).DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
      VALUES ('lk2','Link Two','b','t','["ml"]',NULL,2,2)`).run();
  });

  it('inserir edge via POST /app/graph/link aparece no request seguinte', async () => {
    const before = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    const d0 = await before.json() as any;
    expect(d0.edges.filter((e: any) => e.type === 'explicit')).toHaveLength(0);

    const linkRes = await SELF.fetch('https://x.test/app/graph/link', {
      method: 'POST',
      headers: { cookie: await authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'lk1', target: 'lk2', why: 'mecanismo compartilhado de teste' }),
    });
    expect(linkRes.status).toBe(200);

    const after = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    const d1 = await after.json() as any;
    // Sem depender de GRAPH_CACHE.delete: a edge muda COUNT/MAX(created_at) → hash
    // novo → chave nova no KV → o request seguinte já reflete a edge.
    const explicit = d1.edges.filter((e: any) => e.type === 'explicit');
    expect(explicit.length).toBeGreaterThanOrEqual(1);
    expect(d1.sourceHash).not.toBe(d0.sourceHash);
  });
});

describe('orçamento de payload em escala N=5k (spec 26)', () => {
  beforeAll(async () => {
    await (env as any).DB.prepare(`DELETE FROM edges`).run();
    await (env as any).DB.prepare(`DELETE FROM notes`).run();
    await (env as any).DB.prepare(`DELETE FROM similar_edges`).run();

    const N = 5000;
    const title = (i: number) => `Nota de conhecimento número ${i} sobre um tema cross-domain qualquer`; // ~60+ chars
    // Semeia em chunks via batch pra não estourar binds do D1.
    const CHUNK = 200;
    for (let base = 0; base < N; base += CHUNK) {
      const stmts: any[] = [];
      for (let i = base; i < Math.min(base + CHUNK, N); i++) {
        stmts.push((env as any).DB.prepare(
          `INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at) VALUES (?,?,?,?,?,NULL,?,?)`
        ).bind(`n${i}`, title(i), '', 'tl', i % 2 === 0 ? '["product"]' : '["ai-applied","product"]', i + 1, i + 1));
      }
      await (env as any).DB.batch(stmts);
    }
    // ~1000 edges explícitas
    for (let base = 0; base < 1000; base += CHUNK) {
      const stmts: any[] = [];
      for (let i = base; i < base + CHUNK; i++) {
        stmts.push((env as any).DB.prepare(
          `INSERT OR IGNORE INTO edges (id,from_id,to_id,relation_type,why,created_at) VALUES (?,?,?,?,?,?)`
        ).bind(`e${i}`, `n${i}`, `n${(i + 1) % N}`, 'depends_on', 'why', i + 1));
      }
      await (env as any).DB.batch(stmts);
    }
    // 4 similar edges por nó (espelha SIMILARITY_TOP_K=4), com alguns simétricos.
    for (let base = 0; base < N; base += CHUNK) {
      const stmts: any[] = [];
      for (let i = base; i < Math.min(base + CHUNK, N); i++) {
        for (let k = 1; k <= 4; k++) {
          const to = (i + k) % N;
          stmts.push((env as any).DB.prepare(
            `INSERT OR IGNORE INTO similar_edges (from_id,to_id,score) VALUES (?,?,?)`
          ).bind(`n${i}`, `n${to}`, 0.9 - k * 0.05));
        }
      }
      await (env as any).DB.batch(stmts);
    }
  }, 120_000);

  it('serve 5000 nós dentro do orçamento de bytes e sem erro', async () => {
    const res = await SELF.fetch('https://x.test/app/graph/data', { headers: { cookie: await authCookie() } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const bytes = new TextEncoder().encode(text).length;
    // Gate anti-regressão: quebra se o payload estourar o orçamento.
    expect(bytes).toBeLessThan(PAYLOAD_BUDGET_BYTES);
    const data = JSON.parse(text);
    expect(data.nodes.length).toBe(5000);
  }, 120_000);
});

// spec 20-frontend/25: régua canônica do MCP no endpoint do modal — why >= 20
// chars e relation_type validado contra EDGE_TYPES (default analogous_to).
describe('/app/graph/link — why >= 20 e relation_type (spec 25)', () => {
  beforeAll(async () => {
    await (env as any).DB.prepare(`DELETE FROM edges`).run();
    await (env as any).DB.prepare(`DELETE FROM notes`).run();
    await (env as any).DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
      VALUES ('rl1','Rel One','b','t','["infra"]',NULL,1,1)`).run();
    await (env as any).DB.prepare(`INSERT INTO notes (id,title,body,tldr,domains,kind,created_at,updated_at)
      VALUES ('rl2','Rel Two','b','t','["ml"]',NULL,2,2)`).run();
  });

  const post = async (body: unknown) => SELF.fetch('https://x.test/app/graph/link', {
    method: 'POST',
    headers: { cookie: await authCookie(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('why com 19 chars => 400 mencionando 20', async () => {
    const res = await post({ source: 'rl1', target: 'rl2', why: '1234567890123456789' });
    expect(res.status).toBe(400);
    const b = await res.json() as any;
    expect(b.error).toContain('20');
  });

  it('relation_type same_mechanism_as e gravado; ausente vira analogous_to', async () => {
    const r1 = await post({ source: 'rl1', target: 'rl2', why: 'mecanismo compartilhado de teste A', relation_type: 'same_mechanism_as' });
    expect(r1.status).toBe(200);
    const { id } = await r1.json() as any;
    const row = await (env as any).DB.prepare(`SELECT relation_type FROM edges WHERE id = ?`).bind(id).first();
    expect(row.relation_type).toBe('same_mechanism_as');

    await (env as any).DB.prepare(`DELETE FROM edges`).run();
    const r2 = await post({ source: 'rl1', target: 'rl2', why: 'mecanismo compartilhado de teste B' });
    expect(r2.status).toBe(200);
    const { id: id2 } = await r2.json() as any;
    const row2 = await (env as any).DB.prepare(`SELECT relation_type FROM edges WHERE id = ?`).bind(id2).first();
    expect(row2.relation_type).toBe('analogous_to');
  });

  it('relation_type fora do enum => 400 listando os aceitos', async () => {
    const res = await post({ source: 'rl1', target: 'rl2', why: 'mecanismo compartilhado de teste C', relation_type: 'friends_with' });
    expect(res.status).toBe(400);
    const b = await res.json() as any;
    expect(b.error).toContain('same_mechanism_as');
  });
});
