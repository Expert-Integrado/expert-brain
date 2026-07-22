import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  refreshSimilarEdges,
  replaceSimilarEdges,
  getAllSimilarEdges,
} from '../../src/contacts/web/similarity';
import { contactsSourceHash } from '../../src/contacts/vaults/contacts';

// Spec 10-backend/21 Parte 1 — similar edges PRÉ-COMPUTADAS.
// VECTORIZE é omitido no harness (vitest.config.ts) → mockamos env.VECTORIZE.query
// espalhando o env real (D1 in-memory de verdade) e injetando um query controlado.

const seed = async (id: string, name = 'E ' + id.slice(0, 6)) => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO entities (id, kind, name, source) VALUES (?, 'person', ?, 'seed')`,
  ).bind(id, name).run();
};

// env com VECTORIZE.query mockado (o resto — DB — é o real do harness).
const mockEnv = (matches: Array<{ id: string; score: number }>) =>
  ({
    ...env,
    VECTORIZE: {
      query: async (_vec: number[], _opts: any) => ({ matches }),
      getByIds: async () => [],
    },
  }) as any;

const rowsFor = async (fromId: string) => {
  const r = await env.DB.prepare(
    `SELECT to_id, score FROM similar_edges WHERE from_id = ? ORDER BY to_id`,
  ).bind(fromId).all<{ to_id: string; score: number }>();
  return r.results ?? [];
};

describe('refreshSimilarEdges (spec 21 §1b)', () => {
  it('exclui o próprio nó e grava os vizinhos', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID(), c = crypto.randomUUID();
    await Promise.all([seed(a), seed(b), seed(c)]);
    // o Vectorize devolve o próprio nó como vizinho mais próximo — precisa sumir
    const n = await refreshSimilarEdges(
      mockEnv([{ id: a, score: 0.99 }, { id: b, score: 0.8 }, { id: c, score: 0.7 }]),
      a, [0.1, 0.2], { topK: 4, minScore: 0.5 },
    );
    expect(n).toBe(2);
    const rows = await rowsFor(a);
    expect(rows.map((r) => r.to_id).sort()).toEqual([b, c].sort());
    expect(rows.find((r) => r.to_id === b)?.score).toBeCloseTo(0.8);
  });

  it('respeita minScore (descarta vizinho abaixo do limiar)', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID(), d = crypto.randomUUID();
    await Promise.all([seed(a), seed(b), seed(d)]);
    const n = await refreshSimilarEdges(
      mockEnv([{ id: a, score: 0.99 }, { id: b, score: 0.8 }, { id: d, score: 0.3 }]),
      a, [0.1], { topK: 4, minScore: 0.5 },
    );
    expect(n).toBe(1);
    expect((await rowsFor(a)).map((r) => r.to_id)).toEqual([b]);
  });

  it('respeita topK (slice após excluir o self)', async () => {
    const a = crypto.randomUUID();
    const others = Array.from({ length: 6 }, () => crypto.randomUUID());
    await Promise.all([seed(a), ...others.map((x) => seed(x))]);
    const matches = [{ id: a, score: 0.99 }, ...others.map((x, i) => ({ id: x, score: 0.9 - i * 0.05 }))];
    const n = await refreshSimilarEdges(mockEnv(matches), a, [0.1], { topK: 4, minScore: 0.5 });
    expect(n).toBe(4);
    expect((await rowsFor(a)).length).toBe(4);
  });

  it('neighbors = [] limpa as edges antigas (DELETE)', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    await Promise.all([seed(a), seed(b)]);
    await refreshSimilarEdges(mockEnv([{ id: a, score: 0.99 }, { id: b, score: 0.8 }]), a, [0.1], { topK: 4, minScore: 0.5 });
    expect((await rowsFor(a)).length).toBe(1);
    // segunda passada: só o próprio nó volta (tudo abaixo do minScore) → limpa
    const n = await refreshSimilarEdges(mockEnv([{ id: a, score: 0.99 }, { id: b, score: 0.2 }]), a, [0.1], { topK: 4, minScore: 0.5 });
    expect(n).toBe(0);
    expect((await rowsFor(a)).length).toBe(0);
  });

  it('sem VECTORIZE → no-op (retorna 0)', async () => {
    const a = crypto.randomUUID();
    await seed(a);
    const n = await refreshSimilarEdges(env as any, a, [0.1], { topK: 4, minScore: 0.5 });
    expect(n).toBe(0);
  });

  it('vizinho órfão (vetor sem entidade no D1) é filtrado e deletado do índice — não aborta o batch', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    const ghost = crypto.randomUUID(); // vetor de entidade deletada/mesclada: NÃO existe em entities
    await Promise.all([seed(a), seed(b)]);
    const deleted: string[][] = [];
    const mock = {
      ...env,
      VECTORIZE: {
        query: async () => ({ matches: [
          { id: a, score: 0.99 }, { id: ghost, score: 0.9 }, { id: b, score: 0.8 },
        ] }),
        deleteByIds: async (ids: string[]) => { deleted.push(ids); },
      },
    } as any;
    const n = await refreshSimilarEdges(mock, a, [0.1], { topK: 4, minScore: 0.5 });
    expect(n).toBe(1); // só o vizinho vivo gravou — antes o FK do órfão abortava tudo
    expect((await rowsFor(a)).map((r) => r.to_id)).toEqual([b]);
    expect(deleted).toEqual([[ghost]]); // self-healing: o vetor órfão sai do índice
  });
});

describe('replaceSimilarEdges (spec 21 §1b)', () => {
  it('grava, sobrescreve e limpa idempotente', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID(), c = crypto.randomUUID();
    await Promise.all([seed(a), seed(b), seed(c)]);
    await replaceSimilarEdges(env, a, [{ to_id: b, score: 0.7 }]);
    expect((await rowsFor(a)).map((r) => r.to_id)).toEqual([b]);
    // sobrescreve com outro conjunto — o antigo some
    await replaceSimilarEdges(env, a, [{ to_id: c, score: 0.6 }]);
    expect((await rowsFor(a)).map((r) => r.to_id)).toEqual([c]);
    // vazio limpa
    await replaceSimilarEdges(env, a, []);
    expect((await rowsFor(a)).length).toBe(0);
  });
});

describe('getAllSimilarEdges (spec 21 §1b)', () => {
  it('lê as linhas cruas gravadas', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    await Promise.all([seed(a), seed(b)]);
    await replaceSimilarEdges(env, a, [{ to_id: b, score: 0.55 }]);
    const all = await getAllSimilarEdges(env);
    const mine = all.find((r) => r.from_id === a && r.to_id === b);
    expect(mine).toBeTruthy();
    expect(mine!.score).toBeCloseTo(0.55);
  });
});

describe('contactsSourceHash inclui similar_edges (spec 21 §1e)', () => {
  it('muda quando similar_edges muda — inclusive mesmo COUNT com score diferente', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    await Promise.all([seed(a), seed(b)]);
    await replaceSimilarEdges(env, a, [{ to_id: b, score: 0.5 }]);
    const h1 = await contactsSourceHash(env);
    // MESMO count (1 linha), score diferente → o hash TEM que mudar (COUNT+SUM(score)).
    await env.DB.prepare('UPDATE similar_edges SET score = 0.9 WHERE from_id = ? AND to_id = ?').bind(a, b).run();
    const h2 = await contactsSourceHash(env);
    expect(h2).not.toBe(h1);
    // cleanup
    await replaceSimilarEdges(env, a, []);
  });
});
