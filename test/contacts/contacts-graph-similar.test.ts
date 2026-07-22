import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { contactsAdapter, loadConnectionsBetween } from '../../src/contacts/vaults/contacts';

// Spec 10-backend/21 — read path lê similar_edges do D1 (zero Vectorize por load),
// com dedup simétrico + descarte de par explícito + filtro de extremo vivo; e
// loadConnectionsBetween sem full-scan (IN chunked por a_id + pós-filtro do outro extremo).

const WHY = 'vinculo de teste com no minimo vinte caracteres aqui';

const seedEntity = async (id: string, kind = 'person', name?: string) => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO entities (id, kind, name, source) VALUES (?, ?, ?, 'seed')`,
  ).bind(id, kind, name ?? 'E ' + id.slice(0, 6)).run();
};
const seedConn = async (a: string, b: string, type = 'friend') => {
  await env.DB.prepare(
    `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, ?, 0.5, ?)`,
  ).bind(crypto.randomUUID(), a, b, type, WHY).run();
};
const seedSimilar = async (from: string, to: string, score: number) => {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO similar_edges (from_id, to_id, score) VALUES (?, ?, ?)`,
  ).bind(from, to, score).run();
};

describe('assemblePayload — arestas de similaridade lidas do D1 (spec 21 §1e)', () => {
  it('dedup simétrico, descarte de par explícito e filtro de extremo fora do subgrafo', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID(), c = crypto.randomUUID(), d = crypto.randomUUID(), z = crypto.randomUUID();
    await Promise.all([seedEntity(a), seedEntity(b), seedEntity(c), seedEntity(d), seedEntity(z)]);
    // A-B e C-D conectados (todos entram no subgrafo conectado); Z fica ISOLADO.
    await seedConn(a, b);
    await seedConn(c, d);
    // similar edges: (A,B) tem aresta explícita → descartar; (A,C)+(C,A) simétrico → 1 só;
    // (A,Z) → Z não está no subgrafo conectado (aliveIds) → descartar.
    await seedSimilar(a, b, 0.9);
    await seedSimilar(a, c, 0.8);
    await seedSimilar(c, a, 0.8);
    await seedSimilar(a, z, 0.7);

    const payload = await contactsAdapter.fetchGraph(env, {});
    const myIds = new Set([a, b, c, d, z]);
    const sim = payload.edges.filter(
      (e: any) => e.type === 'similar' && myIds.has(e.source) && myIds.has(e.target),
    );

    // exatamente 1 aresta de similaridade entre os meus nós: o par {A,C} deduplicado.
    expect(sim.length).toBe(1);
    expect([sim[0].source, sim[0].target].sort()).toEqual([a, c].sort());
    // nenhuma similar no par explícito A-B
    expect(sim.some((e: any) => [e.source, e.target].sort().join('|') === [a, b].sort().join('|'))).toBe(false);
    // nenhuma similar tocando Z (fora do subgrafo)
    expect(sim.some((e: any) => e.source === z || e.target === z)).toBe(false);
    // as explícitas A-B e C-D estão no payload
    const exp = payload.edges.filter((e: any) => e.type === 'explicit' && myIds.has(e.source) && myIds.has(e.target));
    expect(exp.length).toBe(2);
  });

  it('corte de exibição: score < SIMILARITY_DISPLAY_MIN fica fora do payload (ruído de sobrenome)', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID(), c = crypto.randomUUID(), d = crypto.randomUUID();
    await Promise.all([seedEntity(a), seedEntity(b), seedEntity(c), seedEntity(d)]);
    await seedConn(a, b);
    await seedConn(c, d);
    await seedSimilar(a, c, 0.45); // abaixo do corte 0.5 — na tabela, fora do grafo
    await seedSimilar(b, d, 0.7);  // acima — aparece

    const payload = await contactsAdapter.fetchGraph(env, {});
    const myIds = new Set([a, b, c, d]);
    const sim = payload.edges.filter(
      (e: any) => e.type === 'similar' && myIds.has(e.source) && myIds.has(e.target),
    );
    expect(sim.length).toBe(1);
    expect([sim[0].source, sim[0].target].sort()).toEqual([b, d].sort());
  });

  it('modo ?all= permanece SEM arestas de similaridade (skipSimilarity)', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    await Promise.all([seedEntity(a), seedEntity(b)]);
    await seedConn(a, b);
    await seedSimilar(a, b, 0.95); // existe, mas o par também é explícito e all= ignora similaridade
    const payload = await contactsAdapter.fetchGraph(env, { all: true });
    const anySimilar = payload.edges.some((e: any) => e.type === 'similar');
    expect(anySimilar).toBe(false);
  });
});

describe('loadConnectionsBetween — sem full-scan, IN chunked por a_id (spec 21 Parte 3)', () => {
  it('com > 100 ids faz chunking e só retorna arestas com os DOIS extremos no set', async () => {
    // 105 entidades no set + 1 externa fora do set
    const ids: string[] = Array.from({ length: 105 }, () => crypto.randomUUID());
    const ext = crypto.randomUUID();
    await Promise.all([...ids.map((id) => seedEntity(id)), seedEntity(ext)]);
    const set = new Set(ids);

    // aresta no 1º chunk (a_id = ids[0]) com b_id no set → mantém
    await seedConn(ids[0], ids[1]);
    // aresta no 2º chunk (a_id = ids[104], índice >100) com b_id no set → mantém (prova o chunking)
    await seedConn(ids[104], ids[0]);
    // aresta com a_id no set mas b_id FORA do set → descartar (pós-filtro do outro extremo)
    await seedConn(ids[2], ext);

    const conns = await loadConnectionsBetween(env, set);
    // filtra só as MINHAS (o D1 é compartilhado entre testes)
    const mine = conns.filter((c) => set.has(c.a_id) && (c.b_id === ids[1] || c.b_id === ids[0] || c.b_id === ext));
    const pairs = mine.map((c) => [c.a_id, c.b_id]);
    expect(pairs).toContainEqual([ids[0], ids[1]]);
    expect(pairs).toContainEqual([ids[104], ids[0]]);
    // a aresta pro ext NÃO pode aparecer (b_id fora do set)
    expect(conns.some((c) => c.b_id === ext)).toBe(false);
  });

  it('set vazio → []', async () => {
    expect(await loadConnectionsBetween(env, new Set())).toEqual([]);
  });
});
