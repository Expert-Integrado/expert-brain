import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { signSession, getSessionKeyMaterial } from '../../src/contacts/web/session';
import { handleEntityNeighbors } from '../../src/contacts/web/neighbors';

// Spec 50-console-v2/56 — GET /app/entity/neighbors: vizinhança de 1º/2º nível,
// SQL puro (zero Vectorize), sessão OU Bearer CONTACTS_PROXY_TOKEN read-only.

const SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const PROXY = 'test-proxy-token';
const WRITE = 'test-write-token';
const WHY = 'vinculo de teste com no minimo vinte caracteres aqui';

async function sessionCookie(): Promise<string> {
  const token = await signSession('owner@example.com', await getSessionKeyMaterial(env as any), Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

function getNeighbors(path: string, opts: { token?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  return SELF.fetch(`https://x${path}`, { headers, redirect: 'manual' });
}

const seedEntity = async (kind = 'person', name?: string): Promise<string> => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, source) VALUES (?, ?, ?, 'seed')`,
  ).bind(id, kind, name ?? 'E ' + id.slice(0, 6)).run();
  return id;
};
const seedConn = async (a: string, b: string, type = 'friend', strength = 0.5): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), a, b, type, strength, WHY).run();
};
const seedSimilar = async (from: string, to: string, score: number): Promise<void> => {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO similar_edges (from_id, to_id, score) VALUES (?, ?, ?)`,
  ).bind(from, to, score).run();
};

// env com env.DB.prepare interceptado: qualquer SQL tocando similar_edges lança
// (simula a tabela ainda não existir, spec 21 não executada) — o resto das
// queries (entities/connections, a maioria dos testes) passa direto pro D1 REAL
// do harness. Só usado nos testes unitários que chamam handleEntityNeighbors
// diretamente (não dá pra injetar isso via SELF.fetch, que usa o binding fixo).
function envWithBrokenSimilar(): any {
  const realDB = env.DB;
  return {
    ...env,
    DB: {
      prepare: (sql: string) => {
        if (/similar_edges/i.test(sql)) throw new Error('no such table: similar_edges');
        return realDB.prepare(sql);
      },
    },
  };
}

describe('GET /app/entity/neighbors — auth (spec 56, critério 7)', () => {
  it('sem sessão nem Bearer → 302 (redirect pro login)', async () => {
    const id = await seedEntity();
    const res = await getNeighbors(`/app/entity/neighbors?id=${id}`);
    expect(res.status).toBe(302);
  });

  it('Bearer CONTACTS_PROXY_TOKEN (read-only) → 200', async () => {
    const id = await seedEntity();
    const res = await getNeighbors(`/app/entity/neighbors?id=${id}`, { token: PROXY });
    expect(res.status).toBe(200);
  });

  it('sessão de cookie → 200', async () => {
    const id = await seedEntity();
    const cookie = await sessionCookie();
    const res = await getNeighbors(`/app/entity/neighbors?id=${id}`, { cookie });
    expect(res.status).toBe(200);
  });

  it('Bearer CONTACTS_WRITE_TOKEN (escrita, fora da allowlist deste path) → 401', async () => {
    const id = await seedEntity();
    const res = await getNeighbors(`/app/entity/neighbors?id=${id}`, { token: WRITE });
    expect(res.status).toBe(401);
  });

  it('token aleatório → 302 (não casa a allowlist, cai pro gate de sessão — mesmo comportamento de /app/entity/events)', async () => {
    const id = await seedEntity();
    const res = await getNeighbors(`/app/entity/neighbors?id=${id}`, { token: 'lixo-qualquer' });
    expect(res.status).toBe(302);
  });

  it('id ausente → 400', async () => {
    const res = await getNeighbors('/app/entity/neighbors', { token: PROXY });
    expect(res.status).toBe(400);
  });

  it('entidade inexistente → 404', async () => {
    const res = await getNeighbors(`/app/entity/neighbors?id=${crypto.randomUUID()}`, { token: PROXY });
    expect(res.status).toBe(404);
  });
});

describe('GET /app/entity/neighbors — 1º nível (spec 56, critério 3)', () => {
  it('explícitas com why/rel/strength + similares com score, ordenadas por força desc', async () => {
    const ego = await seedEntity('person', 'Ego');
    const exp1 = await seedEntity('person', 'Explícito forte');
    const exp2 = await seedEntity('person', 'Explícito fraco');
    const sim1 = await seedEntity('person', 'Similar');
    await seedConn(ego, exp1, 'colleague', 0.9);
    await seedConn(exp2, ego, 'friend', 0.2); // ego como b_id — cobre os dois lados
    await seedSimilar(ego, sim1, 0.75);

    const res = await getNeighbors(`/app/entity/neighbors?id=${ego}`, { token: PROXY });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.ego).toEqual({ id: ego, label: 'Ego', kind: 'person' });
    expect(j.similar_available).toBe(true);

    const byId = new Map(j.level1.map((n: any) => [n.id, n]));
    expect(byId.get(exp1)).toMatchObject({ edge: 'explicit', rel: 'colleague', why: WHY, strength: 0.9, label: 'Explícito forte' });
    expect(byId.get(exp2)).toMatchObject({ edge: 'explicit', rel: 'friend', strength: 0.2 });
    expect(byId.get(sim1)).toMatchObject({ edge: 'similar', score: 0.75, label: 'Similar' });

    // ordenado por força desc: exp1 (0.9) > sim1 (0.75) > exp2 (0.2)
    expect(j.level1.map((n: any) => n.id)).toEqual([exp1, sim1, exp2]);
  });

  it('similar_edges indisponível → similar_available=false, explícitas normais (não quebra)', async () => {
    const ego = await seedEntity('person', 'Ego sem similar');
    const exp1 = await seedEntity('person', 'Explícito');
    await seedConn(ego, exp1, 'colleague', 0.6);

    const res = await handleEntityNeighbors(
      new Request(`https://x/app/entity/neighbors?id=${ego}`),
      envWithBrokenSimilar(),
    );
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.similar_available).toBe(false);
    expect(j.level1).toEqual([
      expect.objectContaining({ id: exp1, edge: 'explicit', rel: 'colleague', strength: 0.6 }),
    ]);
    expect(j.level2).toEqual([]);
  });
});

describe('GET /app/entity/neighbors — 2º nível (spec 56, critério 4)', () => {
  it('agrupa via seed, exclui ego e 1º nível, não duplica', async () => {
    const ego = await seedEntity('person', 'Ego 2N');
    const seed1 = await seedEntity('person', 'Seed 1');
    const seed2 = await seedEntity('person', 'Seed 2');
    const second = await seedEntity('person', 'Segundo grau');
    const alsoFirst = await seedEntity('person', 'Também é 1o grau');

    await seedConn(ego, seed1, 'colleague', 0.9);
    await seedConn(ego, seed2, 'colleague', 0.8);
    // seed1 -> second (2o grau de verdade)
    await seedConn(seed1, second, 'friend', 0.7);
    // seed2 -> alsoFirst, mas alsoFirst TAMBÉM é 1o grau do ego direto — não pode
    // aparecer duplicado no 2o nível.
    await seedConn(ego, alsoFirst, 'friend', 0.4);
    await seedConn(seed2, alsoFirst, 'friend', 0.4);
    // seed1 <-> seed2: aresta entre duas sementes de 1o grau — não gera 2o nível.
    await seedConn(seed1, seed2, 'colleague', 0.3);

    const res = await getNeighbors(`/app/entity/neighbors?id=${ego}`, { token: PROXY });
    const j: any = await res.json();
    expect(res.status).toBe(200);

    const level1Ids = new Set(j.level1.map((n: any) => n.id));
    expect(level1Ids.has(second)).toBe(false); // ainda não é 1o grau

    const level2ById = new Map(j.level2.map((n: any) => [n.id, n]));
    expect(level2ById.has(second)).toBe(true);
    expect(level2ById.get(second)).toMatchObject({ via_id: seed1, via_label: 'Seed 1', edge: 'explicit', rel: 'friend' });
    // alsoFirst é 1o grau — NUNCA aparece no 2o nível mesmo alcançável via seed2.
    expect(level2ById.has(alsoFirst)).toBe(false);
    // seed1/seed2 (sementes) nunca aparecem no 2o nível um do outro.
    expect(level2ById.has(seed1)).toBe(false);
    expect(level2ById.has(seed2)).toBe(false);
  });

  it('similar edges também alimentam o 2º nível, via_label correto', async () => {
    const ego = await seedEntity('person', 'Ego sim2');
    const seed1 = await seedEntity('person', 'Seed sim');
    const second = await seedEntity('person', 'Segundo via similar');
    await seedSimilar(ego, seed1, 0.85);
    await seedSimilar(seed1, second, 0.7);

    const res = await getNeighbors(`/app/entity/neighbors?id=${ego}`, { token: PROXY });
    const j: any = await res.json();
    const level2ById = new Map(j.level2.map((n: any) => [n.id, n]));
    expect(level2ById.get(second)).toMatchObject({ via_id: seed1, via_label: 'Seed sim', edge: 'similar', score: 0.7 });
  });

  it('corte de exibição: similar abaixo de SIMILARITY_DISPLAY_MIN fica fora dos vínculos', async () => {
    const ego = await seedEntity('person', 'Ego corte');
    const weak = await seedEntity('person', 'Sobrenome Coincidente');
    const strong = await seedEntity('person', 'Perfil Parecido');
    await seedSimilar(ego, weak, 0.45); // abaixo do corte 0.5 — na tabela, fora da UI
    await seedSimilar(ego, strong, 0.72);

    const res = await getNeighbors(`/app/entity/neighbors?id=${ego}`, { token: PROXY });
    const j: any = await res.json();
    const ids = j.level1.map((n: any) => n.id);
    expect(ids).toContain(strong);
    expect(ids).not.toContain(weak);
  });

  it('cap de 25 sementes e 60 resultados de 2º nível é respeitado', async () => {
    const ego = await seedEntity('person', 'Ego cap');
    const seeds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const s = await seedEntity('person', `Seed ${i}`);
      seeds.push(s);
      // força decrescente: seed 0 é a mais forte, seed 29 a mais fraca.
      await seedConn(ego, s, 'colleague', 1 - i * 0.03);
    }
    // cada uma das 30 sementes tem 3 segundos-graus próprios (90 candidatos totais,
    // mas só as 25 sementes mais fortes entram na expansão de 2o grau).
    for (const s of seeds) {
      for (let k = 0; k < 3; k++) {
        const c = await seedEntity('person', `Cand ${s.slice(0, 4)}-${k}`);
        await seedConn(s, c, 'friend', 0.5);
      }
    }

    const res = await getNeighbors(`/app/entity/neighbors?id=${ego}`, { token: PROXY });
    const j: any = await res.json();
    expect(res.status).toBe(200);
    expect(j.level1.length).toBe(30);
    // as sementes 25-29 (mais fracas) NÃO expandem — seus candidatos não aparecem.
    const level2ById = new Map(j.level2.map((n: any) => [n.id, n]));
    for (const via of level2ById.values()) {
      const seedIndex = seeds.indexOf((via as any).via_id);
      expect(seedIndex).toBeGreaterThanOrEqual(0);
      expect(seedIndex).toBeLessThan(25);
    }
    expect(j.level2.length).toBeLessThanOrEqual(60);
  });
});

describe('GET /app/entity/neighbors — zero Vectorize (spec 56, critério 8)', () => {
  it('responde 200 sem VECTORIZE configurado (harness omite o binding)', async () => {
    // vitest.config.ts OMITE VECTORIZE deliberadamente — se o handler tocasse
    // env.VECTORIZE.query em qualquer ponto, isto lançaria "Cannot read properties
    // of undefined" e o teste falharia. Passar aqui prova SQL puro.
    const ego = await seedEntity('person', 'Sem vectorize');
    const other = await seedEntity('person', 'Vizinho');
    await seedConn(ego, other, 'colleague', 0.5);
    await seedSimilar(ego, other, 0.6);
    expect((env as any).VECTORIZE).toBeUndefined();
    const res = await getNeighbors(`/app/entity/neighbors?id=${ego}`, { token: PROXY });
    expect(res.status).toBe(200);
  });
});
